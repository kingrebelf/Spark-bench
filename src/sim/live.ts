// Live interactive simulation: pure helpers.
//
// Live mode is a transient run played back in (scaled) real time. When the user operates a switch,
// button or potentiometer on the canvas, the change is recorded with the playback time and the WHOLE
// transient is re-simulated from t = 0 with every recorded change (one exact ngspice run, nothing stitched).
// Until that run returns, data after the earliest unapplied change is never shown.
import { computeConnectivity } from "../core/connectivity";
import { getPart } from "../core/library";
import { formatSI, parseSI } from "../core/units";
import type { ComponentDef, ComponentInstance, Project } from "../core/types";
import { sourceFrequencies } from "./setup";

/** A recorded change: at circuit time t the interactive prop becomes v (booleans as 0/1, sliders in prop units). */
export type Change = [number, number];

/** Edge time used to turn a recorded step into a PWL ramp: 1 µs, or a tenth of the max step when that is smaller. */
export const edgeFor = (step: number) => Math.min(1e-6, Number.isFinite(step) && step > 0 ? step / 10 : 1e-6);

/** Static (non-live) value of an interactive part's prop, as a number. */
export function staticValue(c: ComponentInstance, def: ComponentDef): number {
  const it = def.interactive!;
  const raw = c.props[it.prop] ?? def.props.find((p) => p.key === it.prop)?.default;
  if (it.kind === "slider") {
    const v = parseSI(raw as string | number);
    const lo = it.min ?? -Infinity, hi = it.max ?? Infinity;
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2;
  }
  return raw === true || raw === "true" ? 1 : 0;
}

/**
 * Turn recorded changes (step semantics) into PWL points for the netlist: starts at t = 0 with the initial
 * value, each change becomes [t, old] → [t + edge, new]. Times are made strictly increasing.
 */
export function toPwl(initial: number, changes: Change[], edge: number): [number, number][] {
  const pts: [number, number][] = [[0, initial]];
  let cur = initial, last = 0;
  for (const [t0, v] of [...changes].sort((a, b) => a[0] - b[0])) {
    if (v === cur) continue;
    if (t0 <= 0 && pts.length === 1) { pts[0][1] = v; cur = v; continue; }
    const t = Math.max(t0, last + edge);
    pts.push([t, cur], [t + edge, v]);
    last = t + edge;
    cur = v;
  }
  return pts;
}

/** The value in effect at time t (step semantics, as the user sees it on the canvas). */
export function valueAt(initial: number, changes: Change[] | undefined, t: number): number {
  let v = initial, bestT = -Infinity;
  for (const [ct, cv] of changes ?? []) if (ct <= t && ct >= bestT) { v = cv; bestT = ct; }
  return v;
}

/** Record a change at time t. Later recorded changes of the same part are replaced (you re-did its future). */
export function recordChange(changes: Change[] | undefined, t: number, v: number): Change[] {
  return [...(changes ?? []).filter(([ct]) => ct < t), [t, v]];
}

/**
 * How far the shown result may be displayed: the earliest change made after the result's run started,
 * or null when the result already includes every change.
 */
export function validUntil(log: { seq: number; t: number }[], resultSeq: number): number | null {
  let m: number | null = null;
  for (const e of log) if (e.seq > resultSeq && (m == null || e.t < m)) m = e.t;
  return m;
}

/** Where display of data must stop: the playhead, or the earliest unapplied change if that is earlier. */
export function displayLimit(t: number | null, valid: number | null): number | null {
  if (t == null) return valid;
  return valid == null ? t : Math.min(t, valid);
}

// ---------------------------------------------------------------- time scale

/** Playback rates in circuit seconds per wall-clock second (1 = real time), 1-2-5 steps. */
export const RATES: number[] = (() => {
  const out: number[] = [];
  for (let e = -7; e <= 1; e++) for (const m of [1, 2, 5]) out.push(Number((m * 10 ** e).toPrecision(3)));
  return out.filter((r) => r >= 1e-7 && r <= 10);
})();

/** Largest preset rate ≤ x (the smallest preset when x is below all of them). */
export const niceRate = (x: number) => RATES.filter((r) => r <= x * (1 + 1e-9)).pop() ?? RATES[0];

export function rateLabel(rate: number): string {
  if (Math.abs(rate - 1) < 1e-12) return "real time";
  return rate < 1 ? `${formatSI(rate, "s", 3)} per second (slowed)` : `${formatSI(rate, "s", 3)} per second (sped up)`;
}

/** Default playback rate for a finished transient of length `span`: real time when it lasts 1–60 s, else ~10 s of playback. */
export function defaultRate(span: number): number {
  if (span >= 1 && span <= 60) return 1;
  return niceRate(span / 10);
}

export interface LivePlan {
  stop: number;
  step: number;
  rate: number;
  /** How much circuit time an extension adds (Run sessions; live sessions size it from the playback rate). */
  chunk: number;
  reason: string;
}

/**
 * Slowest RC time constant: each capacitor with each resistor that touches one of its nets. A rough estimate
 * for choosing a playback rate, not an analysis result.
 */
export function rcTimeConstant(project: Project, lookup = getPart): number | null {
  const conn = computeConnectivity(project, lookup);
  const netsOf = (id: string) => new Set(["1", "2"].map((p) => conn.pinNet.get(`${id}:${p}`)).filter((n): n is string => !!n && n !== "0"));
  const val = (c: ComponentInstance) => parseSI((c.props.value ?? lookup(c.type)?.props.find((p) => p.key === "value")?.default) as string | number);
  const comps = project.schematic.components;
  const caps = comps.filter((c) => c.type === "capacitor" || c.type === "capacitor_polarized");
  const res = comps.filter((c) => c.type === "resistor" || c.type === "potentiometer");
  let best = 0;
  for (const c of caps) {
    const cn = netsOf(c.id), cv = val(c);
    for (const r of res) {
      const rv = val(r);
      if ([...netsOf(r.id)].some((n) => cn.has(n)) && cv > 0 && rv > 0) best = Math.max(best, rv * cv);
    }
  }
  return best > 0 ? best : null;
}

/**
 * Playback rate that makes the circuit's action visible: about two periods of the slowest source per second,
 * else about half the slowest RC time constant per second; null when the circuit sets no time scale.
 * Capped at 10 s per second.
 */
export function autoRate(project: Project, lookup = getPart): number | null {
  const fs = sourceFrequencies(project, lookup);
  if (fs.length) return Math.min(10, niceRate(2 / Math.min(...fs.map((f) => f.f))));
  const tau = rcTimeConstant(project, lookup);
  return tau ? Math.min(10, niceRate(2 * tau)) : null;
}

/**
 * Settings for a live session: the automatic rate (real time when the circuit sets no time scale), a first run
 * covering ~20 s of playback, and a max step fine enough for the sources but at most ~100k steps per 20 s.
 */
export function livePlan(project: Project, lookup = getPart): LivePlan {
  const fs = sourceFrequencies(project, lookup);
  const userStep = parseSI(project.simulation.tran.step);
  const okStep = Number.isFinite(userStep) && userStep > 0 ? userStep : Infinity;
  const auto = autoRate(project, lookup);
  const rate = auto ?? 1;
  let step = fs.length ? Math.min(okStep, 1 / (Math.max(...fs.map((f) => f.f)) * 50)) : Math.min(okStep, rate / 500);
  step = Math.max(step, rate / 5000);
  const reason = fs.length ? `about two periods of the slowest source (${formatSI(Math.min(...fs.map((f) => f.f)), "Hz")}) per second`
    : auto ? "about half the slowest RC time constant per second" : "real time: the circuit sets no faster time scale";
  return { stop: 20 * rate, step, rate, chunk: 20 * rate, reason };
}

/** Session settings for an ordinary transient Run (the project's own stop/step). */
export function tranPlan(project: Project): LivePlan | null {
  const stop = parseSI(project.simulation.tran.stop), step = parseSI(project.simulation.tran.step);
  if (!(stop > 0) || !(step > 0)) return null;
  return { stop, step, rate: defaultRate(stop), chunk: stop, reason: "the transient settings" };
}

/** Parts the user can operate during a run, and parts whose look follows the results. */
export const isInteractive = (c: ComponentInstance, lookup = getPart) => !!lookup(c.type)?.interactive;
export const hasLiveParts = (project: Project, lookup = getPart) =>
  project.schematic.components.some((c) => { const d = lookup(c.type); return !!d?.interactive || !!d?.indicator; });
