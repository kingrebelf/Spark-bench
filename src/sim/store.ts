// Simulation state: run/stop/reset, honest status, stale detection, transient playback, live
// interactive sessions and optional continuous re-run of the operating point.
import { create } from "zustand";
import { getPart } from "../core/library";
import type { SpiceEngine } from "../core/simulate";
import { useProject } from "../core/store";
import type { AnalysisKind, Diagnostic, Project, SimResult } from "../core/types";
import { autoRate, defaultRate, edgeFor, livePlan, recordChange, toPwl, tranPlan, validUntil, staticValue, type Change, type LivePlan } from "./live";
import { runSimulation } from "./run";
import { detectFailure, type Damage } from "./stress";
import { siText, validateSetup } from "./setup";
import { workerEngine } from "./workerEngine";

export type SimStatus = "idle" | "running" | "done" | "failed" | "stopped";

/** What a result was computed from, to tell the user exactly what changed since. */
export interface ResultBasis {
  schematic: Project["schematic"];
  models: Project["models"];
  /** Analysis settings as JSON (tran/ac and kind). */
  settings: string;
  /** Probe ids present at run time. */
  probeIds: string[];
  /** The project exactly as simulated. Probe -> vector mapping uses it, because auto net names (N001…) shift after edits. */
  project: Project;
}

/**
 * A transient session: the run settings in effect plus the changes the user made on the canvas while it
 * played. Every re-run simulates from t = 0 with all changes; nothing is stitched.
 */
export interface Session {
  /** Started with Live: real-time default, grows while playing. */
  live: boolean;
  plan: LivePlan;
  /** Current stop time (live sessions grow it ahead of the playhead). */
  stop: number;
  /** Parts that failed from over-stress (modeled as open circuits from the failure time). */
  damage: Record<string, Damage[]>;
  /** Wall time the last run took, to start the next extension early enough. */
  computeMs?: number;
  /** Recorded changes per component id. */
  changes: Record<string, Change[]>;
  /** Change counter; `resultSeq` says which changes the shown result includes. */
  seq: number;
  log: { seq: number; t: number }[];
  /** Plain-language note about the last thing that limited the session (cap reached, …). */
  note?: string;
}

interface SimState {
  status: SimStatus;
  result: SimResult | null;
  /** Kept for compatibility with earlier callers; prefer `basis`/`useStaleness`. */
  resultRevision: number | null;
  basis: ResultBasis | null;
  /** Setup problems that blocked the last Run (shown instead of results). */
  blocked: Diagnostic[];
  startedAt: number | null;
  /** Re-run the operating point automatically after edits. */
  continuous: boolean;
  session: Session | null;
  /** Session change seq the shown result was computed with. */
  resultSeq: number;
  /** A live re-run (from t = 0 with the recorded changes) is in flight; the old result stays shown up to `validUntil`. */
  rerunning: boolean;
  run: (analysis?: AnalysisKind) => Promise<void>;
  /** Start a live session: transient in (scaled) real time that you can operate while it plays. */
  startLive: () => Promise<void>;
  /** Record an interactive change at circuit time t (defaults to the playhead) and re-simulate. */
  change: (componentId: string, value: number, t?: number) => void;
  /** Drop all recorded changes and re-simulate with the parts' static settings. */
  clearChanges: () => void;
  /** Simulate further: grow the session's stop time by one chunk and re-run. */
  extend: () => void;
  /** Replace every failed part at the playback time and re-simulate. */
  repairAll: () => void;
  stop: () => void;
  reset: () => void;
  setContinuous: (on: boolean) => void;
}

const settingsKey = (p: Project, a: AnalysisKind) => JSON.stringify(a === "tran" ? [a, p.simulation.tran] : a === "ac" ? [a, p.simulation.ac] : [a]);

let token = 0;
let pendingRerun = false;
let pendingLive = false;
/** Engine used by the store; tests swap in the Node engine. */
let engine: SpiceEngine & { stop?: () => void } = workerEngine;
export const setSimEngine = (e: SpiceEngine & { stop?: () => void }) => { engine = e; };

/** Seconds of playback kept behind the playhead in live sessions (older samples are not saved). */
export const HISTORY_SECONDS = 30;

/** Wall-clock lead (in circuit seconds) at which a live session starts computing further ahead. */
const leadTime = (s: Session, rate: number) => Math.max(5, 1.5 * (s.computeMs ?? 0) / 1000) * rate;

/**
 * The project with the session's stop/step in place of the tran settings, and the PWL schedules. Live sessions
 * still simulate from 0 s but only save the last HISTORY_SECONDS of playback behind the playhead (bounded memory).
 */
function sessionInput(project: Project, s: Session) {
  const pb = usePlayback.getState();
  const start = s.live ? Math.max(0, Math.min(pb.t ?? 0, s.stop) - HISTORY_SECONDS * pb.rate) : 0;
  const tran = { ...project.simulation.tran, stop: siText(s.stop), step: siText(s.plan.step), start: start > 0 ? siText(start) : undefined };
  const p: Project = { ...project, simulation: { ...project.simulation, analysis: "tran", tran } };
  const schedules = new Map<string, [number, number][]>();
  const edge = edgeFor(s.plan.step);
  for (const c of project.schematic.components) {
    const def = getPart(c.type);
    if (!def?.interactive) continue;
    schedules.set(c.id, toPwl(staticValue(c, def), s.changes[c.id] ?? [], edge));
  }
  return { p, schedules };
}

export const useSim = create<SimState>((set, get) => {
  const basisOf = (project: Project, kind: AnalysisKind): ResultBasis =>
    ({ schematic: project.schematic, models: project.models, settings: settingsKey(project, kind), probeIds: project.simulation.probes.map((p) => p.id), project });

  /**
   * Look for a part that fails in this result (after the failures it already models). When one does, record it
   * and return true: the caller re-simulates with the part open from that time.
   */
  let failChecks = 0;
  function checkDamage(result: SimResult, project: Project): boolean {
    const s = get().session;
    if (!s || !result.ok || result.analysis !== "tran" || pendingLive) return false;
    if (++failChecks > 40) return false; // a runaway chain of failures: stop modeling further ones
    const f = detectFailure(project, result, s.damage);
    if (!f) return false;
    const seq = s.seq + 1;
    set({ session: { ...s, seq, damage: { ...s.damage, [f.componentId]: [...(s.damage[f.componentId] ?? []), f.damage] }, log: [...s.log, { seq, t: f.t }] } });
    return true;
  }

  /** A fresh run: replaces whatever is shown, auto-plays transients from t = 0. */
  async function fresh(project: Project, kind: AnalysisKind, session: Session | null) {
    const problems = validateSetup(project, kind);
    if (problems.some((d) => d.severity === "error")) {
      set({ blocked: problems, status: "failed", result: null, basis: null, resultRevision: null, session: null });
      return;
    }
    const my = ++token;
    pendingLive = false;
    if (get().status === "running" || get().rerunning) engine.stop?.(); // a newer run replaces the old one
    set({ status: "running", blocked: [], startedAt: Date.now(), session, rerunning: false, resultSeq: 0 });
    const inp = session ? sessionInput(project, session) : null;
    const result = await runSimulation(inp?.p ?? project, engine, kind, inp ? { schedules: inp.schedules, damage: session!.damage } : {});
    if (my !== token) return; // superseded by Stop, Reset or a newer Run
    result.diagnostics = [...problems, ...result.diagnostics];
    usePlayback.getState().resetFor(result);
    failChecks = 0;
    set({ status: result.ok ? "done" : "failed", result, startedAt: null, resultRevision: Date.now(), basis: basisOf(project, kind), resultSeq: session?.seq ?? 0,
      session: session ? { ...session, computeMs: result.elapsedMs } : null });
    if (result.ok && kind === "tran") {
      const pb = usePlayback.getState();
      const auto = autoRate(project);
      const span = defaultRate(pb.t1 - pb.t0);
      pb.setRate(session?.live ? session.plan.rate : auto != null ? Math.min(auto, span) : span);
      pb.play();
      if (checkDamage(result, project)) void rerun();
    }
    if (pendingRerun) { pendingRerun = false; scheduleContinuous(); }
  }

  /** Re-simulate the session from t = 0 (latest changes win); playback keeps going meanwhile. */
  async function rerun() {
    const s = get().session;
    if (!s || !get().result?.ok) return;
    if (get().rerunning) { pendingLive = true; return; }
    const my = token;
    const project = get().basis?.project ?? useProject.getState().project;
    const seq = s.seq;
    set({ rerunning: true });
    const inp = sessionInput(project, s);
    const result = await runSimulation(inp.p, engine, "tran", { schedules: inp.schedules, damage: s.damage });
    if (my !== token) return;
    set({ rerunning: false });
    if (!result.ok) {
      // Honest failure: drop the waveform rather than keep showing data that no longer matches your changes.
      usePlayback.getState().resetFor(null);
      set({ status: "failed", result, resultRevision: Date.now(), resultSeq: seq });
      pendingLive = false;
      return;
    }
    usePlayback.getState().adopt(result);
    const cur = get().session;
    set({ result, resultRevision: Date.now(), resultSeq: seq, session: cur ? { ...cur, computeMs: result.elapsedMs } : cur });
    if (pendingLive) { pendingLive = false; void rerun(); }
    else if (checkDamage(result, project)) void rerun();
  }

  /** Grow the session's stop time (live sessions ahead of the playhead, or a change made at the end). */
  function extendTo(t: number): boolean {
    const s = get().session;
    if (!s) return false;
    const rate = usePlayback.getState().rate;
    // Live: at least 20 s of playback per extension (more when runs get slow), at most 100k output steps.
    const chunk = s.live ? Math.min(Math.max(20 * rate, 2 * leadTime(s, rate)), s.plan.step * 100_000) : s.plan.chunk;
    const stop = Math.max(s.stop + chunk, t + chunk);
    set({ session: { ...s, stop } });
    return true;
  }

  /** Recorded failures and repairs after time t were computed from a future that a change just replaced. */
  const pruneDamage = (damage: Record<string, Damage[]>, t: number): Record<string, Damage[]> => {
    const out: Record<string, Damage[]> = {};
    for (const [id, list] of Object.entries(damage)) {
      const kept = list.filter((d) => d.t <= t).map((d) => (d.repairedAt != null && d.repairedAt > t ? { ...d, repairedAt: undefined } : d));
      if (kept.length) out[id] = kept;
    }
    return out;
  };

  return {
    status: "idle",
    result: null,
    resultRevision: null,
    basis: null,
    blocked: [],
    startedAt: null,
    continuous: false,
    session: null,
    resultSeq: 0,
    rerunning: false,
    run: async (analysis) => {
      const project = useProject.getState().project;
      const kind = analysis ?? project.simulation.analysis;
      const plan = kind === "tran" ? tranPlan(project) : null;
      await fresh(project, kind, plan ? { live: false, plan, stop: plan.stop, changes: {}, damage: {}, seq: 0, log: [] } : null);
    },
    startLive: async () => {
      const st = useProject.getState();
      if (st.project.simulation.analysis !== "tran") st.update("Simulation settings", (d) => { d.simulation.analysis = "tran"; }, { merge: true });
      const project = useProject.getState().project;
      const plan = livePlan(project);
      await fresh(project, "tran", { live: true, plan, stop: plan.stop, changes: {}, damage: {}, seq: 0, log: [] });
    },
    change: (componentId, value, at) => {
      const s = get().session, r = get().result;
      if (!s || !r?.ok || r.analysis !== "tran") return;
      const pb = usePlayback.getState();
      const t = Math.max(0, at ?? pb.t ?? pb.t1);
      const seq = s.seq + 1;
      const next: Session = { ...s, seq, changes: { ...s.changes, [componentId]: recordChange(s.changes[componentId], t, value) }, damage: pruneDamage(s.damage, t), log: [...s.log, { seq, t }] };
      set({ session: next });
      failChecks = 0;
      // A change at (or past) the end needs simulated time after it.
      if (t > pb.t1 - (next.live ? leadTime(next, pb.rate) : next.plan.chunk * 0.05)) extendTo(t);
      void rerun();
    },
    repairAll: () => {
      const s = get().session;
      if (!s || !Object.keys(s.damage).length) return;
      const pb = usePlayback.getState();
      const t = pb.t ?? pb.t1;
      const damage: Record<string, Damage[]> = {};
      for (const [id, list] of Object.entries(pruneDamage(s.damage, t))) damage[id] = list.map((d) => (d.repairedAt == null ? { ...d, repairedAt: t } : d));
      const seq = s.seq + 1;
      set({ session: { ...s, seq, damage, log: [...s.log, { seq, t }] } });
      failChecks = 0;
      void rerun();
    },
    extend: () => { if (extendTo(usePlayback.getState().t1)) void rerun(); },
    clearChanges: () => {
      const s = get().session;
      if (!s) return;
      const seq = s.seq + 1;
      set({ session: { ...s, seq, changes: {}, damage: {}, log: [...s.log, { seq, t: 0 }] } });
      failChecks = 0;
      void rerun();
    },
    stop: () => {
      if (get().status !== "running" && !get().rerunning) return;
      token++;
      pendingLive = false;
      engine.stop?.();
      set({ status: "stopped", result: null, basis: null, resultRevision: null, startedAt: null, rerunning: false, session: null });
      usePlayback.getState().resetFor(null);
    },
    reset: () => {
      token++;
      pendingLive = false;
      // Terminating the worker also discards the engine state; the next run loads a fresh ngspice.
      engine.stop?.();
      set({ status: "idle", result: null, basis: null, resultRevision: null, blocked: [], startedAt: null, rerunning: false, session: null });
      usePlayback.getState().resetFor(null);
    },
    setContinuous: (on) => { set({ continuous: on }); if (on) scheduleContinuous(); },
  };
});

/** Circuit time up to which the shown result includes every recorded change (null = all of it). */
export const useValidUntil = () => useSim((s) => (s.session ? validUntil(s.session.log, s.resultSeq) : null));

/** Called by playback each frame: a live session grows before playback reaches its end. */
function maybeExtend(t: number, t1: number, rate: number) {
  const sim = useSim.getState();
  const s = sim.session;
  if (!s?.live || sim.rerunning || !sim.result?.ok || s.stop > t1 + 1e-12) return;
  if (t1 - t <= leadTime(s, rate)) sim.extend();
}

// ---------------------------------------------------------------- staleness

export interface Staleness { schematic: boolean; settings: boolean; newProbes: boolean; any: boolean }

export function staleness(project: Project, basis: ResultBasis | null, analysis: AnalysisKind | undefined): Staleness {
  if (!basis || !analysis) return { schematic: false, settings: false, newProbes: false, any: false };
  const schematic = project.schematic !== basis.schematic || project.models !== basis.models;
  const settings = settingsKey(project, analysis) !== basis.settings || project.simulation.analysis !== analysis;
  const newProbes = project.simulation.probes.some((p) => !basis.probeIds.includes(p.id));
  return { schematic, settings, newProbes, any: schematic || settings };
}

export const useStaleness = (): Staleness => {
  const project = useProject((s) => s.project);
  const basis = useSim((s) => s.basis);
  const analysis = useSim((s) => s.result?.analysis);
  return staleness(project, basis, analysis);
};

/** The project the shown result was computed from (falls back to the current one). */
export const useRunProject = (): Project => {
  const current = useProject((s) => s.project);
  return useSim((s) => s.basis?.project) ?? current;
};

/** True when the schematic or analysis settings changed after the shown result was computed. */
export const useResultStale = () => useStaleness().any;

// ---------------------------------------------------------------- continuous op

let timer: ReturnType<typeof setTimeout> | null = null;
function scheduleContinuous() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const sim = useSim.getState();
    const project = useProject.getState().project;
    if (!sim.continuous || project.simulation.analysis !== "op") return;
    if (sim.status === "running") { pendingRerun = true; return; }
    const st = staleness(project, sim.basis, sim.result?.analysis);
    if (!sim.basis || st.schematic || st.newProbes || sim.result?.analysis !== "op") void sim.run("op");
  }, 400);
}
useProject.subscribe((s, prev) => {
  if (s.project !== prev.project && useSim.getState().continuous) scheduleContinuous();
});

// ---------------------------------------------------------------- playback

/**
 * Playback of a computed transient result. ngspice computes the run first; this animates the finished
 * waveform and the on-canvas values. `rate` is circuit seconds per wall-clock second (1 = real time).
 */
interface PlaybackState {
  /** Current playback time in simulation seconds, or null when not in playback mode. */
  t: number | null;
  playing: boolean;
  /** Circuit seconds per second of playback. */
  rate: number;
  t0: number;
  t1: number;
  /** Playing but held at the end while a live session computes more time. */
  waiting: boolean;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setRate: (r: number) => void;
  /** Leave playback mode (values show the end of the run). */
  exit: () => void;
  resetFor: (r: SimResult | null) => void;
  /** Take a re-simulated result of the same session: keep the position and keep playing. */
  adopt: (r: SimResult) => void;
}

const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id: number) => clearTimeout(id);
let frame = 0;
export const usePlayback = create<PlaybackState>((set, get) => {
  const tick = (last: number) => (now: number) => {
    const s = get();
    if (!s.playing || s.t == null) return;
    const dt = Math.min(0.25, (now - last) / 1000); // a background tab must not jump ahead
    let next = s.t + dt * s.rate;
    maybeExtend(next, s.t1, s.rate);
    if (next >= s.t1) {
      const sim = useSim.getState();
      if (sim.session?.live && sim.rerunning) { set({ t: s.t1, waiting: true }); frame = raf(tick(now)); return; }
      set({ t: s.t1, playing: false, waiting: false });
      return;
    }
    if (next < s.t0) next = s.t0;
    set({ t: next, waiting: false });
    frame = raf(tick(now));
  };
  return {
    t: null, playing: false, rate: 1, t0: 0, t1: 0, waiting: false,
    play: () => {
      const s = get();
      if (s.t1 <= s.t0) return;
      const t = s.t == null || s.t >= s.t1 ? s.t0 : s.t;
      caf(frame);
      set({ t, playing: true });
      frame = raf((now) => { frame = raf(tick(now)); });
    },
    pause: () => { caf(frame); set({ playing: false, waiting: false }); },
    seek: (t) => set((s) => ({ t: Math.min(s.t1, Math.max(s.t0, t)) })),
    setRate: (rate) => set({ rate }),
    exit: () => { caf(frame); set({ t: null, playing: false, waiting: false }); },
    resetFor: (r) => {
      caf(frame);
      const x = r?.ok && r.analysis === "tran" ? r.x?.real : undefined;
      set({ t: null, playing: false, waiting: false, t0: x?.[0] ?? 0, t1: x?.[x.length - 1] ?? 0 });
    },
    adopt: (r) => {
      const x = r.x?.real;
      if (!x?.length) return;
      const t1 = x[x.length - 1];
      set((s) => ({ t0: x[0], t1, t: s.t == null ? null : Math.min(t1, Math.max(x[0], s.t)) }));
    },
  };
});
