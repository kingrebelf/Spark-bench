// Simulation state: run/stop/reset, honest status, stale detection, transient playback, live interactive
// sessions (chunked continuation from saved state) and optional continuous re-run of the operating point.
import { create } from "zustand";
import { getPart } from "../core/library";
import type { SpiceEngine } from "../core/simulate";
import { useProject } from "../core/store";
import type { AnalysisKind, Diagnostic, Project, SimResult } from "../core/types";
import { dropBefore, lastIndexAtOrBefore, runChunk, safeIndex, splice, stateAt, truncate, type ChunkState } from "./chunk";
import { classifyEdit, describeEdit, invalidValues, mapState } from "./edits";
import { autoRate, defaultRate, livePlan, recordChange, staticValue, tranPlan, valueAt, type Change, type LivePlan } from "./live";
import { runSimulation } from "./run";
import { validateSetup } from "./setup";
import { damageText, failedAt, firstExceed, stressTracks, type Damage, type RatingKind } from "./stress";
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
 * A transient session. The shown result is a timeline of chunks: each chunk is a real ngspice run that continues
 * from the previous chunk's state at a real solver timepoint (see chunk.ts). Operating a part cuts the timeline
 * at the last timepoint at or before the playhead and continues from the circuit's state at that moment.
 */
export interface Session {
  /** Started with Live: computes ahead of the playhead for as long as it plays. */
  live: boolean;
  plan: LivePlan;
  /** Run sessions compute up to here (Simulate further raises it). */
  stop: number;
  /** Recorded changes per component id (for the canvas: the value in effect at a playback time). */
  changes: Record<string, Change[]>;
  /** Parts that failed from over-stress (open circuits from the failure time). */
  damage: Record<string, Damage[]>;
  /** The last change: the circuit time it applies from, and how long until its first chunk was shown. */
  lastChange?: { t: number; latencyMs?: number; label?: string };
  /** Value edits and circuit edits applied during the run (markers on the scope's time axis). */
  edits?: { t: number; label: string }[];
  /** One line about an edit that could not be applied (yet), or why the run restarted. */
  note?: string;
  /** Values operated while the previous change was still computing; applied as soon as it lands. */
  pending?: Record<string, number>;
}

/** Averaged stress of one rating over the shown timeline (aligned with result.x). */
export interface StressSeries { componentId: string; ref: string; kind: RatingKind; limit: number; tau: number; ratio: number[]; avg: number[] }

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
  /** A chunk is being computed. */
  computing: boolean;
  /** Averaged stress of rated parts over the timeline (transient sessions). */
  stress: StressSeries[];
  run: (analysis?: AnalysisKind) => Promise<void>;
  /** Start a live session: transient played in (scaled) real time, computed ahead, operable while it plays. */
  startLive: () => Promise<void>;
  /** Operate a part at the playback time (or `t`): continue from the circuit's state there with the new value. */
  change: (componentId: string, value: number, t?: number) => void;
  /** Run sessions: compute further than the stop time. */
  extend: () => void;
  /** Replace every failed part at the playback time and continue. */
  repairAll: () => void;
  stop: () => void;
  reset: () => void;
  setContinuous: (on: boolean) => void;
}

const settingsKey = (p: Project, a: AnalysisKind) => JSON.stringify(a === "tran" ? [a, p.simulation.tran] : a === "ac" ? [a, p.simulation.ac] : [a]);

let token = 0;
let pendingRerun = false;
/** Engine used by the store; tests swap in the Node engine. */
let engine: SpiceEngine & { stop?: () => void; init?: () => Promise<unknown> } = workerEngine;
export const setSimEngine = (e: SpiceEngine & { stop?: () => void; init?: () => Promise<unknown> }) => { engine = e; };
/** Load ngspice ahead of the first run (the panel calls this on mount; Stop/Reset call it after terminating). */
export const warmUpEngine = () => { void engine.init?.().catch(() => { /* the next run reports any failure */ }); };
/** Wall time of the last chunk, and from a change to its first data on screen (running averages). */
let lastChunkMs = 20;
let changeLatencyMs = 40;

/** Seconds of playback kept behind the playhead in live sessions (older samples are dropped). */
export const HISTORY_SECONDS = 30;
/** Seconds of playback computed ahead of the playhead, and per chunk (short, so a change is cheap). */
const LEAD_SECONDS = 1;
const CHUNK_SECONDS = 0.25;
/** The first chunk after a change is shorter still, so the change shows up at once. */
const FIRST_CHUNK_SECONDS = 0.1;

const stressKey = (id: string, kind: string) => `${id}:${kind}`;
/** Start computing (set when the store is created; playback calls it to keep ahead of the playhead). */
let kick: () => void = () => {};
/** Apply schematic edits made during a live run (set when the store is created). */
let liveEdit: () => void = () => {};

export const useSim = create<SimState>((set, get) => {
  const basisOf = (project: Project, kind: AnalysisKind): ResultBasis =>
    ({ schematic: project.schematic, models: project.models, settings: settingsKey(project, kind), probeIds: project.simulation.probes.map((p) => p.id), project });

  // ------------------------------------------------------------ timeline state (outside React state for speed)
  /** Interactive values at the end of the timeline. */
  let params: Record<string, number> = {};
  /** Advanced by every change, repair, Stop and Reset: a chunk computed for an older generation is discarded. */
  let gen = 0;
  let pumping = false;
  let changeWall: number | null = null;
  let firstAfterChange = false;
  /**
   * Changes made while the previous change's first chunk is still computing. Cutting the timeline again would
   * discard that chunk, so a drag at mouse speed would never show anything; instead they are applied in order at
   * the end of the chunk that lands (a slider keeps only its latest value), and every step of a drag shows data.
   */
  let queue: { id: string; value: number }[] = [];
  /** A timeline end already chosen as a quiet restart point (cutting there must not trigger another step back). */
  let trustedEnd = NaN;
  /** For the first chunk after a change or repair: values just before it, and parts to reconnect. */
  let transitionFrom: Record<string, number> | null = null;
  let reconnect: string[] = [];

  const projectOf = () => get().basis?.project ?? useProject.getState().project;

  /** Values of interactive parts in effect at circuit time t. */
  function paramsAt(project: Project, changes: Record<string, Change[]>, t: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of project.schematic.components) {
      const def = getPart(c.type);
      if (def?.interactive) out[c.id] = valueAt(staticValue(c, def), changes[c.id], t);
    }
    return out;
  }

  /** Damage averages for a new chunk, continuing the timeline's averages (or 0 after a repair). */
  function chunkStress(project: Project, r: SimResult, damage: Record<string, Damage[]>, prev: StressSeries[]) {
    const initial: Record<string, number> = {};
    for (const s of prev) initial[stressKey(s.componentId, s.kind)] = s.avg[s.avg.length - 1] ?? 0;
    return stressTracks(project, r, damage, undefined, initial);
  }

  /** Append a chunk (and its stress series) to the shown timeline; live sessions drop old history. */
  function append(chunk: SimResult, tracks: ReturnType<typeof stressTracks>) {
    const s = get().session!;
    const prev = get().result;
    let result = prev?.ok && prev.analysis === "tran" ? splice(prev, chunk) : chunk;
    const skip = prev?.ok && prev.x && chunk.x && prev.x.real.length && chunk.x.real[0] <= prev.x.real[prev.x.real.length - 1] + 1e-15 ? 1 : 0;
    const old = new Map(get().stress.map((x) => [stressKey(x.componentId, x.kind), x]));
    let stress: StressSeries[] = tracks.map((tr) => {
      const o = prev?.ok ? old.get(stressKey(tr.componentId, tr.kind)) : undefined;
      const pad = (prev?.x?.real.length ?? 0) - (o?.avg.length ?? 0);
      const head = (arr: number[] | undefined) => [...(arr ?? []), ...new Array(Math.max(0, pad)).fill(0)];
      return { componentId: tr.componentId, ref: tr.ref, kind: tr.kind, limit: tr.limit, tau: tr.tau,
        avg: prev?.ok ? [...head(o?.avg), ...Array.from(tr.avg).slice(skip)] : Array.from(tr.avg),
        ratio: prev?.ok ? [...head(o?.ratio), ...Array.from(tr.ratio).slice(skip)] : Array.from(tr.ratio) };
    });
    if (s.live && result.x) {
      const pb = usePlayback.getState();
      const keepFrom = (pb.t ?? result.x.real[0]) - HISTORY_SECONDS * pb.rate;
      const k = lastIndexAtOrBefore(result.x.real, keepFrom);
      if (k > 0 && result.x.real[k] < keepFrom) {
        result = dropBefore(result, k);
        stress = stress.map((x) => ({ ...x, avg: x.avg.slice(k), ratio: x.ratio.slice(k) }));
      }
    }
    set({ result, stress, resultRevision: Date.now() });
    usePlayback.getState().adopt(result);
  }

  /** Cut the timeline at sample k (a real timepoint). */
  function cutAt(k: number) {
    const r = get().result!;
    set({ result: truncate(r, k), stress: get().stress.map((x) => ({ ...x, avg: x.avg.slice(0, k + 1), ratio: x.ratio.slice(0, k + 1) })), resultRevision: Date.now() });
    usePlayback.getState().adopt(get().result!);
  }

  /** Compute chunks until the session has enough ahead of the playhead (live) or reaches its stop time (Run). */
  async function pump() {
    if (pumping) return;
    pumping = true;
    set({ computing: true });
    try {
      for (let guard = 0; guard < 10_000; guard++) {
        const s = get().session, r = get().result;
        if (!s || !r?.ok || !r.x?.real.length || get().status !== "done") break;
        const x = r.x.real, end = x[x.length - 1];
        const pb = usePlayback.getState();
        const target = s.live ? Math.max(pb.t ?? end, x[0]) + LEAD_SECONDS * pb.rate : s.stop;
        if (end >= target - 1e-12) break;
        // Continue from a quiet sample (never from inside a fast edge): cut back to it first if needed.
        if (end !== trustedEnd) {
          const safe = safeIndex(r, x.length - 1, 50);
          trustedEnd = x[safe];
          if (safe < x.length - 1) { cutAt(safe); continue; }
        }
        const want = (firstAfterChange ? FIRST_CHUNK_SECONDS : CHUNK_SECONDS) * pb.rate;
        const length = Math.min(Math.max(want, 20 * s.plan.step), target - end, s.plan.step * 50_000);
        const myGen = gen, myToken = token;
        const project = projectOf();
        const open = Object.entries(s.damage).filter(([, l]) => failedAt(l, end)).map(([id]) => id);
        const from = transitionFrom ?? undefined, rec = reconnect;
        const w0 = performance.now();
        const chunk = await runChunk(project, engine, { t0: end, length, step: s.plan.step, params, open, from, reconnect: rec, state: stateAt(r, x.length - 1) });
        lastChunkMs = 0.7 * lastChunkMs + 0.3 * (performance.now() - w0);
        if (myGen !== gen || myToken !== token) continue; // a change, repair or new run happened meanwhile
        transitionFrom = null;
        reconnect = [];
        if (!chunk.ok || !chunk.x?.real.length) {
          // Honest failure: show it, with no waveform.
          usePlayback.getState().resetFor(null);
          set({ status: "failed", result: chunk, stress: [], resultRevision: Date.now() });
          break;
        }
        // Damage: the earliest part whose running average passes its limit in this chunk fails there.
        const tracks = chunkStress(project, chunk, s.damage, get().stress);
        let fail: { id: string; k: number; tr: (typeof tracks)[number] } | null = null;
        for (const tr of tracks) {
          if (open.includes(tr.componentId)) continue;
          const tf = firstExceed(chunk.x.real, tr.avg, tr.limit);
          if (tf == null) continue;
          const k = lastIndexAtOrBefore(chunk.x.real, tf);
          if (!fail || k < fail.k) fail = { id: tr.componentId, k, tr };
        }
        let piece = chunk, pieceTracks = tracks;
        if (fail) {
          piece = truncate(chunk, fail.k);
          pieceTracks = tracks.map((t) => ({ ...t, avg: t.avg.slice(0, fail!.k + 1), ratio: t.ratio.slice(0, fail!.k + 1), raw: t.raw.slice(0, fail!.k + 1) }));
          const tf = chunk.x.real[fail.k];
          const d: Damage = { t: tf, ...damageText(project, fail.tr, tf, fail.tr.raw[fail.k]) };
          set({ session: { ...s, damage: { ...s.damage, [fail.id]: [...(s.damage[fail.id] ?? []), d] } } });
        }
        append(piece, pieceTracks);
        if (firstAfterChange && changeWall != null) {
          const cur = get().session!;
          const ms = performance.now() - changeWall;
          changeLatencyMs = 0.7 * changeLatencyMs + 0.3 * ms;
          set({ session: { ...cur, lastChange: { ...cur.lastChange, t: cur.lastChange?.t ?? end, latencyMs: Math.round(ms) } } });
          changeWall = null;
        }
        firstAfterChange = false;
        const next = queue.shift();
        if (next) { const nx = get().result!.x!.real; applyChange(next.id, next.value, nx[nx.length - 1]); }
      }
    } finally {
      pumping = false;
      set({ computing: false });
    }
  }

  /** Operate a part at circuit time `at`: cut there and continue from the circuit's state with the new value. */
  function applyChange(componentId: string, value: number, at: number) {
    const s = get().session;
    if (!s) return;
    const tk = restartAt(Math.max(0, at));
    if (tk == null) return;
    // Everything recorded after the restart point belonged to a future that is now recomputed.
    const changes: Record<string, Change[]> = {};
    for (const [id, list] of Object.entries(s.changes)) { const kept = list.filter(([t]) => t <= tk); if (kept.length) changes[id] = kept; }
    // Values in effect just before the change, at the restart point.
    transitionFrom = transitionFrom ?? paramsAt(projectOf(), changes, tk - 1e-15);
    changes[componentId] = recordChange(changes[componentId], tk, value);
    params = paramsAt(projectOf(), changes, tk);
    changeWall = performance.now();
    firstAfterChange = true;
    const pending = { ...s.pending };
    if (!queue.some((q) => q.id === componentId)) delete pending[componentId];
    set({ session: { ...s, changes, damage: pruneDamage(s.damage, tk), lastChange: { t: tk }, pending } });
    void pump();
  }

  /** Cut the timeline at the last real timepoint at or before t; returns that time (null when there is no timeline). */
  function restartAt(t: number): number | null {
    const r = get().result;
    if (!r?.ok || r.analysis !== "tran" || !r.x?.real.length) return null;
    const k = safeIndex(r, lastIndexAtOrBefore(r.x.real, t));
    trustedEnd = r.x.real[k];
    gen++;
    if (k < r.x.real.length - 1) cutAt(k);
    return r.x.real[k];
  }

  kick = () => void pump();

  /**
   * The project changed during a live run. Value edits apply a moment ahead of the playhead, continuing from the
   * circuit's state there (node voltages and inductor currents carry over). Topology edits continue from the
   * mapped state when every node still exists (new nodes start at 0 V), otherwise the run restarts from 0 s.
   * Invalid values are never sent to ngspice: the run keeps going with the last valid circuit.
   */
  liveEdit = () => {
    const s = get().session, r = get().result;
    if (!s?.live || get().status !== "done" || !r?.ok || !r.x?.real.length) return;
    const old = projectOf(), cur = useProject.getState().project;
    const kind = classifyEdit(old, cur);
    if (kind === "none") return;
    const bad = invalidValues(cur);
    if (bad.length) { set({ session: { ...s, note: `Not applied yet: ${bad[0].message}` } }); return; }
    const pb = usePlayback.getState();
    const now = pb.t ?? pb.t1;
    const ahead = pb.playing ? Math.min(0.25, Math.max(0.06, 2.5 * Math.max(changeLatencyMs, 2 * lastChunkMs) / 1000)) * pb.rate : 0;
    const label = kind === "props" ? describeEdit(old, cur) : "circuit edited";
    if (kind === "props") {
      const tk = restartAt(now + ahead);
      if (tk == null) return;
      transitionFrom = null;
      params = paramsAt(cur, s.changes, tk);
      changeWall = performance.now();
      firstAfterChange = true;
      const edits = [...(s.edits ?? []).filter((e) => e.t <= tk), { t: tk, label }];
      set({ basis: basisOf(cur, "tran"), session: { ...s, damage: pruneDamage(s.damage, tk), edits, lastChange: { t: tk, label }, note: undefined } });
      void pump();
      return;
    }
    // Topology: continue from the state at a quiet timepoint near the playhead, mapped onto the new circuit.
    const k = safeIndex(r, lastIndexAtOrBefore(r.x.real, now + ahead));
    const mapped = mapState(old, cur, stateAt(r, k));
    const ids = new Set(cur.schematic.components.map((c) => c.id));
    const keep = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => ids.has(id)));
    if (mapped) {
      const edits = [...(s.edits ?? []).filter((e) => e.t <= mapped.t), { t: mapped.t, label }];
      void fresh(cur, "tran", { ...s, changes: keep(s.changes), damage: keep(pruneDamage(s.damage, mapped.t)), edits,
        lastChange: { t: mapped.t, label }, note: "Circuit edited: continuing from the circuit's state at that moment (new nodes start at 0 V)." },
      { state: mapped, keepRate: true });
    } else {
      void fresh(cur, "tran", { ...s, changes: {}, damage: {}, edits: [], lastChange: undefined,
        note: "Circuit edited: a node of the running circuit no longer exists, so the run restarted from 0 s." }, undefined);
    }
  };

  /** A fresh run: replaces whatever is shown, auto-plays transients from t = 0. */
  async function fresh(project: Project, kind: AnalysisKind, session: Session | null, cont?: { state: ChunkState; keepRate: boolean }) {
    const problems = validateSetup(project, kind);
    if (problems.some((d) => d.severity === "error")) {
      set({ blocked: problems, status: "failed", result: null, basis: null, resultRevision: null, session: null, stress: [] });
      return;
    }
    const my = ++token;
    gen++;
    queue = [];
    changeWall = null;
    if (get().status === "running") engine.stop?.(); // a newer run replaces the old one
    set({ status: "running", blocked: [], startedAt: Date.now(), session, stress: [] });
    let result: SimResult;
    if (session) {
      const t0 = cont?.state.t ?? 0;
      params = paramsAt(project, session.changes, t0);
      // Run: the whole span in one run. Live: a first chunk, then chunks ahead of the playhead.
      const rate = cont?.keepRate ? usePlayback.getState().rate : session.plan.rate;
      const length = session.live ? Math.max(LEAD_SECONDS * rate, 20 * session.plan.step) : session.stop;
      result = await runChunk(project, engine, { t0, length, step: session.plan.step, params, state: cont?.state ?? null });
    } else {
      result = await runSimulation(project, engine, kind);
    }
    if (my !== token) return; // superseded by Stop, Reset or a newer Run
    result.diagnostics = [...problems, ...result.diagnostics];
    usePlayback.getState().resetFor(result);
    set({ status: result.ok ? "done" : "failed", result: null, startedAt: null, resultRevision: Date.now(), basis: basisOf(project, kind) });
    if (result.ok && kind === "tran" && session) {
      const tracks = chunkStress(project, result, {}, []);
      set({ result: null, stress: [] });
      // detect a failure in the first chunk the same way as later ones: keep up to it, then continue
      let piece = result, pieceTracks = tracks;
      let fail: { id: string; k: number; tr: (typeof tracks)[number] } | null = null;
      for (const tr of tracks) {
        const tf = firstExceed(result.x!.real, tr.avg, tr.limit);
        if (tf == null) continue;
        const k = lastIndexAtOrBefore(result.x!.real, tf);
        if (!fail || k < fail.k) fail = { id: tr.componentId, k, tr };
      }
      if (fail) {
        piece = truncate(result, fail.k);
        pieceTracks = tracks.map((t) => ({ ...t, avg: t.avg.slice(0, fail!.k + 1), ratio: t.ratio.slice(0, fail!.k + 1), raw: t.raw.slice(0, fail!.k + 1) }));
        const tf = result.x!.real[fail.k];
        set({ session: { ...session, damage: { [fail.id]: [{ t: tf, ...damageText(project, fail.tr, tf, fail.tr.raw[fail.k]) }] } } });
      }
      append(piece, pieceTracks);
      const pb = usePlayback.getState();
      const auto = autoRate(project), span = defaultRate(session.stop);
      if (!cont?.keepRate) pb.setRate(session.live ? session.plan.rate : auto != null ? Math.min(auto, span) : span);
      pb.play();
      void pump();
    } else {
      set({ result });
      if (result.ok && kind === "tran") usePlayback.getState().play();
    }
    if (pendingRerun) { pendingRerun = false; scheduleContinuous(); }
  }

  return {
    status: "idle",
    result: null,
    resultRevision: null,
    basis: null,
    blocked: [],
    startedAt: null,
    continuous: false,
    session: null,
    computing: false,
    stress: [],
    run: async (analysis) => {
      const project = useProject.getState().project;
      const kind = analysis ?? project.simulation.analysis;
      const plan = kind === "tran" ? tranPlan(project) : null;
      await fresh(project, kind, plan ? { live: false, plan, stop: plan.stop, changes: {}, damage: {} } : null);
    },
    startLive: async () => {
      const st = useProject.getState();
      if (st.project.simulation.analysis !== "tran") st.update("Simulation settings", (d) => { d.simulation.analysis = "tran"; }, { merge: true });
      const project = useProject.getState().project;
      const plan = livePlan(project);
      await fresh(project, "tran", { live: true, plan, stop: plan.stop, changes: {}, damage: {} });
    },
    change: (componentId, value, at) => {
      const s = get().session, r = get().result;
      if (!s || !r?.ok || r.analysis !== "tran") return;
      if (changeWall != null && pumping) {
        const slider = getPart(projectOf().schematic.components.find((c) => c.id === componentId)?.type ?? "")?.interactive?.kind === "slider";
        const last = queue[queue.length - 1];
        if (slider && last?.id === componentId) last.value = value; else queue.push({ id: componentId, value });
        set({ session: { ...s, pending: { ...s.pending, [componentId]: value } } });
        return;
      }
      const pb = usePlayback.getState();
      // While playing, a change lands a moment ahead of the playhead (2.5x the measured change-to-screen time,
      // 60-250 ms of wall time), so the playhead keeps playing through data already computed while the new chunk
      // computes: it never stops for a change.
      const now = pb.t ?? pb.t1;
      const ahead = pb.playing ? Math.min(0.25, Math.max(0.06, 2.5 * Math.max(changeLatencyMs, 2 * lastChunkMs) / 1000)) * pb.rate : 0;
      applyChange(componentId, value, Math.max(at ?? now, now + ahead));
    },
    repairAll: () => {
      const s = get().session;
      if (!s || !Object.keys(s.damage).length) return;
      const pb = usePlayback.getState();
      const tk = restartAt(pb.t ?? pb.t1);
      if (tk == null) return;
      const damage: Record<string, Damage[]> = {};
      const repaired = new Set<string>();
      for (const [id, list] of Object.entries(pruneDamage(s.damage, tk))) damage[id] = list.map((d) => (d.repairedAt == null ? (repaired.add(id), { ...d, repairedAt: tk }) : d));
      // A new part starts cool: its running averages restart at 0.
      set({ session: { ...s, damage }, stress: get().stress.map((x) => (repaired.has(x.componentId) ? { ...x, avg: [...x.avg.slice(0, -1), 0], ratio: [...x.ratio.slice(0, -1), 0] } : x)) });
      reconnect = [...repaired];
      firstAfterChange = true;
      void pump();
    },
    extend: () => {
      const s = get().session;
      if (!s || s.live) return;
      set({ session: { ...s, stop: s.stop + s.plan.chunk } });
      void pump();
    },
    stop: () => {
      if (get().status !== "running" && !get().computing) return;
      token++;
      gen++;
      engine.stop?.();
      warmUpEngine();
      set({ status: "stopped", result: null, basis: null, resultRevision: null, startedAt: null, session: null, stress: [] });
      usePlayback.getState().resetFor(null);
    },
    reset: () => {
      token++;
      gen++;
      // Terminating the worker also discards the engine state; the next run loads a fresh ngspice.
      engine.stop?.();
      warmUpEngine();
      set({ status: "idle", result: null, basis: null, resultRevision: null, blocked: [], startedAt: null, session: null, stress: [] });
      usePlayback.getState().resetFor(null);
    },
    setContinuous: (on) => { set({ continuous: on }); if (on) scheduleContinuous(); },
  };
});

/** Recorded failures and repairs after time t belonged to a future that is being recomputed. */
function pruneDamage(damage: Record<string, Damage[]>, t: number): Record<string, Damage[]> {
  const out: Record<string, Damage[]> = {};
  for (const [id, list] of Object.entries(damage)) {
    const kept = list.filter((d) => d.t <= t).map((d) => (d.repairedAt != null && d.repairedAt > t ? { ...d, repairedAt: undefined } : d));
    if (kept.length) out[id] = kept;
  }
  return out;
}

/** Called by playback each frame: keep computing ahead of the playhead. */
function keepAhead(t: number, t1: number, rate: number) {
  const sim = useSim.getState();
  if (!sim.session?.live || sim.computing || sim.status !== "done") return;
  if (t1 - t <= LEAD_SECONDS * rate * 0.75) kick();
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

// Edits during a live run (properties panel, undo/redo, canvas): applied live after a short pause in typing.
const EDIT_DEBOUNCE_MS = 60;
let editTimer: ReturnType<typeof setTimeout> | null = null;
useProject.subscribe((s, prev) => {
  if (s.project === prev.project || !useSim.getState().session?.live) return;
  if (s.project.schematic === prev.project.schematic && s.project.models === prev.project.models) return;
  if (editTimer) clearTimeout(editTimer);
  editTimer = setTimeout(() => { editTimer = null; liveEdit(); }, EDIT_DEBOUNCE_MS);
});

// ---------------------------------------------------------------- playback

/**
 * Playback of computed transient results. `rate` is circuit seconds per wall-clock second (1 = real time).
 * In live sessions the playhead never passes the computed end: it waits there while the next chunk computes.
 */
interface PlaybackState {
  /** Current playback time in simulation seconds, or null when not in playback mode. */
  t: number | null;
  playing: boolean;
  /** Circuit seconds per second of playback. */
  rate: number;
  t0: number;
  t1: number;
  /** Playing but held at the end while more is computed. */
  waiting: boolean;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setRate: (r: number) => void;
  /** Leave playback mode (values show the end of the run). */
  exit: () => void;
  resetFor: (r: SimResult | null) => void;
  /** Take a grown or cut timeline of the same session: keep the position and keep playing. */
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
    keepAhead(next, s.t1, s.rate);
    if (next >= s.t1) {
      const sim = useSim.getState();
      const more = sim.session && sim.status === "done" && (sim.session.live || s.t1 < sim.session.stop - 1e-12);
      if (more) { set({ t: s.t1, waiting: true }); frame = raf(tick(now)); return; }
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
      if (s.t1 <= s.t0 && !useSim.getState().session?.live) return;
      const t = s.t == null || (s.t >= s.t1 && !useSim.getState().session?.live) ? s.t0 : s.t;
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
