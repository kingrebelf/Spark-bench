// Turns a SimResult plus the project's probes into labeled traces for the scope, tables, CSV and canvas.
import { computeConnectivity } from "../core/connectivity";
import type { Project, SimResult, Vector } from "../core/types";
import { PROBE_COLORS, resolveProbes, vectorForProbe, type ResolvedProbe } from "./probes";

export interface Trace {
  id: string;
  label: string;
  color: string;
  vector: Vector;
  /** Probe this trace belongs to (absent for "all signals" traces). */
  probeId?: string;
}

/** Display label for a probe from what it is attached to now. */
export function probeLabel(r: ResolvedProbe, project: Project): string {
  if (r.problem) return r.probe.label;
  if (r.probe.kind === "voltage") return `V(${r.netName === "0" ? "GND" : r.netName})`;
  return `I(${project.schematic.components.find((c) => c.id === r.componentId)?.ref ?? "?"})`;
}

export interface ProbeTraces {
  traces: Trace[];
  /** Probes that can't be shown, with the reason. */
  missing: { probeId: string; label: string; reason: string }[];
}

/**
 * Traces for the current project's probes. Each probe is resolved against `runProject` (the project as
 * simulated), so a stale result never shows another node's data under a renumbered auto net name.
 */
export function probeTraces(project: Project, result: SimResult, runProject: Project = project): ProbeTraces {
  const traces: Trace[] = [];
  const missing: ProbeTraces["missing"] = [];
  const atRun = new Map(resolveProbes(runProject, computeConnectivity(runProject)).map((r) => [r.probe.id, r]));
  for (const current of resolveProbes(project, computeConnectivity(project))) {
    const r = atRun.get(current.probe.id);
    if (!r) { missing.push({ probeId: current.probe.id, label: probeLabel(current, project), reason: "Added after this run. Run again to see its values." }); continue; }
    const label = probeLabel(r, runProject);
    if (r.problem) { missing.push({ probeId: r.probe.id, label, reason: r.problem }); continue; }
    const v = vectorForProbe(r, result);
    if (!v) {
      missing.push({ probeId: r.probe.id, label, reason: r.probe.kind === "current" && result.analysis === "ac"
        ? "ngspice can't report this part's current in AC analysis."
        : "This run has no data for it. Run again." });
      continue;
    }
    traces.push({ id: r.probe.id, label, color: r.color, vector: v, probeId: r.probe.id });
  }
  return { traces, missing };
}

/** Every node voltage and every reported current, for "show all signals". */
export function allTraces(project: Project, result: SimResult): Trace[] {
  const refs = new Map(project.schematic.components.map((c) => [c.id, c.ref]));
  const out: Trace[] = [];
  const sorted = [...result.vectors].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "voltage" ? -1 : 1));
  for (const v of sorted) {
    if (v.kind !== "voltage" && v.kind !== "current") continue;
    if (/sb[lf]c?_/i.test(v.name)) continue; // live-mode control/failure helpers, not circuit signals
    const label = v.kind === "voltage" ? `V(${v.netName})` : `I(${(v.componentId && refs.get(v.componentId)) || v.name})`;
    out.push({ id: `all:${v.name}`, label, color: PROBE_COLORS[out.length % PROBE_COLORS.length], vector: v });
  }
  return out;
}

/** AC helpers. */
export const magDb = (v: Vector) => v.real.map((re, i) => 20 * Math.log10(Math.hypot(re, v.imag?.[i] ?? 0) || 1e-30));
/** Phase in degrees, unwrapped so it doesn't jump by 360° between points. */
export function phaseDeg(v: Vector): number[] {
  const out: number[] = [];
  let offset = 0;
  for (let i = 0; i < v.real.length; i++) {
    const p = Math.atan2(v.imag?.[i] ?? 0, v.real[i]) * 180 / Math.PI;
    if (i) {
      const prev = out[i - 1] - offset;
      if (p - prev > 180) offset -= 360;
      else if (p - prev < -180) offset += 360;
    }
    out.push(p + offset);
  }
  return out;
}
