// Validation of a laid-out proposal: design checks, then (optionally) the proposal's suggested
// simulations, comparing real ngspice results with the AI's expected ranges.
import { hasErrors, runChecks } from "../core/checks";
import { getPart } from "../core/library";
import { simulate, type SpiceEngine } from "../core/simulate";
import { parseSI } from "../core/units";
import type { ComponentDef, Diagnostic, Project, SimResult, Vector } from "../core/types";
import type { Expectation, SuggestedSimulation } from "./proposal";

type Lookup = (id: string) => ComponentDef | undefined;

export type ValidationStage =
  | "unvalidated"   // AI proposal: not yet validated
  | "checks-failed"
  | "checks-passed"
  | "sim-failed"    // ngspice could not run it
  | "sim-ran"       // simulated fine, but the AI gave no expectations to compare
  | "sim-mismatch"  // simulated, at least one expectation not met
  | "sim-match";    // simulated, all expectations met

export interface ExpectationResult {
  expectation: Expectation;
  measured: number | null;
  unit: string;
  /** null when the value could not be measured (reason in `note`). */
  pass: boolean | null;
  note?: string;
}

export interface SimulationCheck {
  simulation: SuggestedSimulation;
  result: SimResult;
  expectations: ExpectationResult[];
  /** true only if the run succeeded and every expectation was measured and passed */
  matches: boolean;
}

export function checkDesign(project: Project, lookup: Lookup = getPart): { ok: boolean; diagnostics: Diagnostic[] } {
  const diagnostics = runChecks(project, lookup);
  return { ok: !hasErrors(diagnostics), diagnostics };
}

/** Copy of `project` with simulation settings taken from a suggested simulation. */
export function withSimulation(project: Project, sim: SuggestedSimulation): Project {
  const p: Project = structuredClone(project);
  p.simulation.analysis = sim.analysis;
  if (sim.tran) p.simulation.tran = { ...p.simulation.tran, stop: sim.tran.stop, step: sim.tran.step };
  if (sim.ac) p.simulation.ac = { sweep: "dec", points: Math.max(1, Math.round(sim.ac.pointsPerDecade)), start: sim.ac.start, stop: sim.ac.stop };
  return p;
}

/** Problems with the suggested analysis settings themselves (missing or unparsable). */
export function simSettingsProblems(sim: SuggestedSimulation): string[] {
  const out: string[] = [];
  const bad = (s: string) => !(parseSI(s) > 0);
  if (sim.analysis === "tran") {
    if (!sim.tran) out.push("transient run without stop time/step");
    else { if (bad(sim.tran.stop)) out.push(`stop time "${sim.tran.stop}" is invalid`); if (bad(sim.tran.step)) out.push(`time step "${sim.tran.step}" is invalid`); }
  }
  if (sim.analysis === "ac") {
    if (!sim.ac) out.push("AC sweep without start/stop frequency");
    else { if (bad(sim.ac.start)) out.push(`start frequency "${sim.ac.start}" is invalid`); if (bad(sim.ac.stop)) out.push(`stop frequency "${sim.ac.stop}" is invalid`); }
  }
  return out;
}

const mag = (v: Vector, i: number) => Math.hypot(v.real[i], v.imag?.[i] ?? 0);

/** Measure one expectation on a result. `net` is the schematic's (ngspice) net name. */
export function measure(result: SimResult, net: string, e: Expectation): { value: number; unit: string } | { error: string } {
  const v = result.vectors.find((x) => x.kind === "voltage" && x.netName?.toLowerCase() === net.toLowerCase());
  if (net === "0") return { error: "the ground net is 0 V by definition" };
  if (!v) return { error: `no voltage was recorded for net ${net}` };
  const x = result.x?.real ?? [];
  const n = v.real.length;
  if (!n) return { error: "the result is empty" };
  switch (e.measure) {
    case "op":
      if (result.analysis !== "op") return { error: "'op' needs an operating-point analysis" };
      return { value: v.real[0], unit: "V" };
    case "final": case "max": case "min": case "avg": case "pp": case "rms": {
      if (result.analysis !== "tran") return { error: `'${e.measure}' needs a transient analysis` };
      const ys = v.real;
      if (e.measure === "final") return { value: ys[n - 1], unit: "V" };
      if (e.measure === "max") return { value: Math.max(...ys), unit: "V" };
      if (e.measure === "min") return { value: Math.min(...ys), unit: "V" };
      if (e.measure === "pp") return { value: Math.max(...ys) - Math.min(...ys), unit: "V" };
      // time-weighted (trapezoidal) average / RMS; ngspice uses variable time steps
      let s = 0, s2 = 0;
      for (let i = 1; i < n; i++) {
        const dt = x[i] - x[i - 1];
        s += dt * (ys[i] + ys[i - 1]) / 2;
        s2 += dt * (ys[i] ** 2 + ys[i - 1] ** 2) / 2;
      }
      const T = x[n - 1] - x[0];
      if (!(T > 0)) return { error: "the transient run has zero length" };
      return e.measure === "avg" ? { value: s / T, unit: "V" } : { value: Math.sqrt(s2 / T), unit: "V" };
    }
    case "gain_db_at": {
      if (result.analysis !== "ac") return { error: "'gain_db_at' needs an AC analysis" };
      if (e.frequency === null || !(e.frequency > 0)) return { error: "no frequency given" };
      if (e.frequency < x[0] * 0.999 || e.frequency > x[n - 1] * 1.001) return { error: `${e.frequency} Hz is outside the swept range` };
      // log-frequency interpolation of |V|
      let i = x.findIndex((f) => f >= e.frequency!);
      if (i <= 0) i = 1;
      const f0 = x[i - 1], f1 = x[i];
      const t = f1 === f0 ? 0 : (Math.log(e.frequency) - Math.log(f0)) / (Math.log(f1) - Math.log(f0));
      const m = mag(v, i - 1) + (mag(v, i) - mag(v, i - 1)) * Math.min(1, Math.max(0, t));
      return { value: 20 * Math.log10(m), unit: "dB" };
    }
    case "f_3db": {
      if (result.analysis !== "ac") return { error: "'f_3db' needs an AC analysis" };
      const ms = v.real.map((_, i) => mag(v, i));
      const peak = ms.reduce((a, b, i) => (b > ms[a] ? i : a), 0);
      const target = ms[peak] / Math.SQRT2;
      // first crossing above the peak (low-pass / band-pass upper edge), else below it (high-pass)
      for (let i = peak + 1; i < n; i++) if (ms[i] <= target) return { value: interpLog(x[i - 1], x[i], ms[i - 1], ms[i], target), unit: "Hz" };
      for (let i = peak - 1; i >= 0; i--) if (ms[i] <= target) return { value: interpLog(x[i], x[i + 1], ms[i], ms[i + 1], target), unit: "Hz" };
      return { error: "the response never falls 3 dB below its peak within the sweep" };
    }
  }
}

function interpLog(f0: number, f1: number, m0: number, m1: number, target: number): number {
  if (m1 === m0) return f0;
  const t = (target - m0) / (m1 - m0);
  return Math.exp(Math.log(f0) + t * (Math.log(f1) - Math.log(f0)));
}

/**
 * Run one suggested simulation on the proposed project and grade its expectations.
 * `netNames` maps proposal net names to schematic net names (LayoutResult.netNames).
 */
export async function runSuggestedSimulation(
  project: Project, sim: SuggestedSimulation, netNames: Map<string, string>, engine: SpiceEngine, lookup: Lookup = getPart,
): Promise<SimulationCheck> {
  const p = withSimulation(project, sim);
  const result = await simulate(p, engine, sim.analysis, lookup);
  const expectations: ExpectationResult[] = sim.expectations.map((e) => {
    if (!result.ok) return { expectation: e, measured: null, unit: "", pass: null, note: "The simulation failed, so nothing was measured." };
    const net = netNames.get(e.net);
    if (net === undefined) return { expectation: e, measured: null, unit: "", pass: null, note: `The proposal has no net named ${e.net}.` };
    const m = measure(result, net, e);
    if ("error" in m) return { expectation: e, measured: null, unit: "", pass: null, note: `Could not measure: ${m.error}.` };
    const pass = (e.min === null || m.value >= e.min) && (e.max === null || m.value <= e.max);
    return { expectation: e, measured: m.value, unit: m.unit, pass };
  });
  const matches = result.ok && expectations.length > 0 && expectations.every((x) => x.pass === true);
  return { simulation: sim, result, expectations, matches };
}

/** Overall stage for the review header. */
export function stageOf(checksOk: boolean | null, sims: SimulationCheck[]): ValidationStage {
  if (checksOk === null) return "unvalidated";
  if (!checksOk) return "checks-failed";
  if (!sims.length) return "checks-passed";
  if (sims.some((s) => !s.result.ok)) return "sim-failed";
  const graded = sims.filter((s) => s.expectations.length);
  if (!graded.length) return "sim-ran";
  return graded.every((s) => s.matches) ? "sim-match" : "sim-mismatch";
}

export const STAGE_LABEL: Record<ValidationStage, string> = {
  "unvalidated": "AI proposal: not yet validated",
  "checks-failed": "Design checks failed",
  "checks-passed": "Checks passed (not simulated)",
  "sim-failed": "Checks passed · simulation failed",
  "sim-ran": "Simulated (no expected results to compare)",
  "sim-mismatch": "Simulated: doesn't match the AI's expectation",
  "sim-match": "Simulated: matches expectation",
};
