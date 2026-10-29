// Simulation state: run/stop/reset, honest status, stale detection, transient playback and
// optional continuous re-run of the operating point.
import { create } from "zustand";
import { useProject } from "../core/store";
import type { AnalysisKind, Diagnostic, Project, SimResult } from "../core/types";
import { runSimulation } from "./run";
import { validateSetup } from "./setup";
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
  run: (analysis?: AnalysisKind) => Promise<void>;
  stop: () => void;
  reset: () => void;
  setContinuous: (on: boolean) => void;
}

const settingsKey = (p: Project, a: AnalysisKind) => JSON.stringify(a === "tran" ? [a, p.simulation.tran] : a === "ac" ? [a, p.simulation.ac] : [a]);

let token = 0;
let pendingRerun = false;

export const useSim = create<SimState>((set, get) => ({
  status: "idle",
  result: null,
  resultRevision: null,
  basis: null,
  blocked: [],
  startedAt: null,
  continuous: false,
  run: async (analysis) => {
    const project = useProject.getState().project;
    const kind = analysis ?? project.simulation.analysis;
    const problems = validateSetup(project, kind);
    if (problems.some((d) => d.severity === "error")) {
      set({ blocked: problems, status: "failed", result: null, basis: null, resultRevision: null });
      return;
    }
    const my = ++token;
    if (get().status === "running") workerEngine.stop(); // a newer run replaces the old one
    set({ status: "running", blocked: [], startedAt: Date.now() });
    const result = await runSimulation(project, workerEngine, kind);
    if (my !== token) return; // superseded by Stop, Reset or a newer Run
    result.diagnostics = [...problems, ...result.diagnostics];
    usePlayback.getState().resetFor(result);
    set({
      status: result.ok ? "done" : "failed", result, startedAt: null, resultRevision: Date.now(),
      basis: { schematic: project.schematic, models: project.models, settings: settingsKey(project, kind), probeIds: project.simulation.probes.map((p) => p.id), project },
    });
    if (pendingRerun) { pendingRerun = false; scheduleContinuous(); }
  },
  stop: () => {
    if (get().status !== "running") return;
    token++;
    workerEngine.stop();
    set({ status: "stopped", result: null, basis: null, resultRevision: null, startedAt: null });
    usePlayback.getState().resetFor(null);
  },
  reset: () => {
    token++;
    // Terminating the worker also discards the engine state; the next run loads a fresh ngspice.
    workerEngine.stop();
    set({ status: "idle", result: null, basis: null, resultRevision: null, blocked: [], startedAt: null });
    usePlayback.getState().resetFor(null);
  },
  setContinuous: (on) => { set({ continuous: on }); if (on) scheduleContinuous(); },
}));

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
 * Playback of a computed transient result. ngspice computes the whole run first; this only
 * animates the finished waveform and the on-canvas values. `speed` 1× plays the whole run in
 * `BASE_SECONDS` of wall time.
 */
export const BASE_SECONDS = 10;
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10];

interface PlaybackState {
  /** Current playback time in simulation seconds, or null when not in playback mode. */
  t: number | null;
  playing: boolean;
  speed: number;
  t0: number;
  t1: number;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setSpeed: (s: number) => void;
  /** Leave playback mode (values show the end of the run). */
  exit: () => void;
  resetFor: (r: SimResult | null) => void;
}

let raf = 0;
export const usePlayback = create<PlaybackState>((set, get) => {
  const tick = (last: number) => (now: number) => {
    const s = get();
    if (!s.playing || s.t == null) return;
    const dt = (now - last) / 1000;
    const next = s.t + dt * s.speed * (s.t1 - s.t0) / BASE_SECONDS;
    if (next >= s.t1) { set({ t: s.t1, playing: false }); return; }
    set({ t: next });
    raf = requestAnimationFrame(tick(now));
  };
  return {
    t: null, playing: false, speed: 1, t0: 0, t1: 0,
    play: () => {
      const s = get();
      if (s.t1 <= s.t0) return;
      const t = s.t == null || s.t >= s.t1 ? s.t0 : s.t;
      cancelAnimationFrame(raf);
      set({ t, playing: true });
      raf = requestAnimationFrame((now) => { raf = requestAnimationFrame(tick(now)); });
    },
    pause: () => { cancelAnimationFrame(raf); set({ playing: false }); },
    seek: (t) => set((s) => ({ t: Math.min(s.t1, Math.max(s.t0, t)) })),
    setSpeed: (speed) => set({ speed }),
    exit: () => { cancelAnimationFrame(raf); set({ t: null, playing: false }); },
    resetFor: (r) => {
      cancelAnimationFrame(raf);
      const x = r?.ok && r.analysis === "tran" ? r.x?.real : undefined;
      set({ t: null, playing: false, t0: x?.[0] ?? 0, t1: x?.[x.length - 1] ?? 0 });
    },
  };
});
