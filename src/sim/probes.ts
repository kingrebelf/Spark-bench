// Probe resolution and the netlist rewrite that makes ngspice save device currents.
// ngspice saves node voltages and voltage-source currents by default; anything else must be
// requested with `.save all @dev[param]`. We rewrite the netlist in `src/sim` (not in core) and
// keep the text that actually ran, so the netlist view and the .cir export show the real input.
import { computeConnectivity, type Connectivity } from "../core/connectivity";
import { keyOf } from "../core/geometry";
import { getPart } from "../core/library";
import type { NetlistResult } from "../core/netlist";
import type { EngineOutput, SpiceEngine } from "../core/simulate";
import type { AnalysisKind, ComponentDef, Diagnostic, Probe, Project, SimResult, Vector } from "../core/types";

export const PROBE_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4dd0e1", "#f06292", "#aed581", "#ff8a65"];

/** Which internal current ngspice can report for an element, by its leading letter. */
const CURRENT_PARAM: Record<string, string> = { r: "i", c: "i", l: "i", d: "id", q: "ic", m: "id", j: "id", b: "i", g: "i", f: "i", h: "i", i: "current" };
/** Elements whose branch current ngspice already saves as `i(name)` (or name#branch). */
const BRANCH = new Set(["v", "e"]);

export interface CurrentSave {
  componentId: string;
  /** SPICE element name (lowercase). */
  element: string;
  /** ngspice vector expression saved for it, e.g. "@r1[i]", or null when it is a branch current saved by default. */
  save: string | null;
}

/** Element names per component id, in netlist order. */
export function elementsByComponent(nl: NetlistResult): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [el, id] of nl.elementMap) {
    if (!m.has(id)) m.set(id, []);
    m.get(id)!.push(el);
  }
  return m;
}

/**
 * Decide how to measure the current into the first pin of a component.
 * Returns null when the part is a subcircuit (X) or otherwise has no single measurable element.
 */
export function currentSaveFor(componentId: string, nl: NetlistResult): CurrentSave | null {
  const els = elementsByComponent(nl).get(componentId);
  if (!els || els.length !== 1) return null;
  const el = els[0];
  const letter = el[0];
  if (BRANCH.has(letter)) return { componentId, element: el, save: null };
  const p = CURRENT_PARAM[letter];
  if (!p) return null;
  return { componentId, element: el, save: `@${el}[${p}]` };
}

/** Insert `.save all <vectors>` before the analysis card / `.end`. Returns the netlist unchanged when nothing is needed. */
export function addSaves(netlist: string, saves: string[]): string {
  const uniq = [...new Set(saves)];
  if (!uniq.length) return netlist;
  const lines = netlist.split("\n");
  const at = lines.findIndex((l) => /^\s*\.(op|tran|ac|dc|end)\b/i.test(l));
  lines.splice(at < 0 ? lines.length : at, 0, `.save all ${uniq.join(" ")}`);
  return lines.join("\n");
}

/** A SpiceEngine wrapper that adds `.save` lines and remembers the netlist it actually ran. */
export class SavingEngine implements SpiceEngine {
  lastNetlist = "";
  constructor(private inner: SpiceEngine, private saves: string[]) {}
  run(netlist: string): Promise<EngineOutput> {
    this.lastNetlist = addSaves(netlist, this.saves);
    return this.inner.run(this.lastNetlist);
  }
}

// ---------------------------------------------------------------- probe targets

export interface ResolvedProbe {
  probe: Probe;
  color: string;
  /** Voltage probes: the net now at the probe's point/name. */
  netName?: string;
  /** Current probes: the component (if it still exists). */
  componentId?: string;
  /** Why this probe cannot be shown. */
  problem?: string;
}

/** Resolve probes against the current schematic. Points win over stored net names (auto names like N003 are not stable). */
export function resolveProbes(project: Project, conn: Connectivity = computeConnectivity(project)): ResolvedProbe[] {
  const comps = new Map(project.schematic.components.map((c) => [c.id, c]));
  const netNames = new Set(conn.nets.map((n) => n.name));
  return project.simulation.probes.map((probe, i) => {
    const color = probe.color ?? PROBE_COLORS[i % PROBE_COLORS.length];
    if (probe.kind === "voltage") {
      const byPoint = probe.target.point ? conn.pointNet.get(keyOf(probe.target.point)) : undefined;
      const net = byPoint ?? (probe.target.netName && netNames.has(probe.target.netName) ? probe.target.netName : undefined);
      if (!net) return { probe, color, problem: `${probe.label}: the wire or net it was attached to no longer exists.` };
      return { probe, color, netName: net };
    }
    const id = probe.target.componentId;
    if (!id || !comps.has(id)) return { probe, color, problem: `${probe.label}: the part it measured was removed.` };
    return { probe, color, componentId: id };
  });
}

/** Current saves needed for the current probes, plus diagnostics for parts whose current can't be measured. */
export function planCurrentSaves(project: Project, nl: NetlistResult, analysis: AnalysisKind, lookup: (id: string) => ComponentDef | undefined = getPart): { saves: string[]; diagnostics: Diagnostic[] } {
  const saves: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const r of resolveProbes(project, nl.connectivity)) {
    if (r.probe.kind !== "current" || !r.componentId) continue;
    const plan = currentSaveFor(r.componentId, nl);
    const c = project.schematic.components.find((x) => x.id === r.componentId)!;
    if (plan?.save && analysis === "ac") {
      // ngspice-WASM cannot write device-internal currents (@r1[i]) in AC: the run fails or hangs.
      diagnostics.push({ severity: "warning", code: "probe-current-ac", source: "check", componentIds: [c.id],
        message: `Current probe ${r.probe.label}: ngspice cannot report the current through ${c.ref} in AC analysis (only voltage-source currents are available).`,
        fix: `Add a 0 V DC voltage source in series with ${c.ref} and probe that source's current, or use a transient run.` });
    } else if (plan?.save) saves.push(plan.save);
    else if (!plan) {
      const def = lookup(c.type);
      diagnostics.push({ severity: "warning", code: "probe-current-unsupported", source: "check", componentIds: [c.id],
        message: `Current probe ${r.probe.label}: ${c.ref} (${def?.name ?? c.type}) is ${def?.spice ? "a multi-element model" : "not simulated"}, so ngspice cannot report a single current for it.`,
        fix: `Probe the current of a two-terminal part in series with ${c.ref} instead, or add a 0 V DC voltage source in series and probe that.` });
    }
  }
  return { saves, diagnostics };
}

/** Core maps `i(v1)`/`v1#branch` to components but not saved device currents like `i(@r1[i])`; fill those in. */
export function mapDeviceCurrents(result: SimResult, nl: NetlistResult): void {
  for (const v of result.vectors) {
    if (v.kind !== "current" || v.componentId) continue;
    const m = /^(?:i\()?@([^[\]]+)\[/i.exec(v.name);
    if (m) v.componentId = nl.elementMap.get(m[1].toLowerCase());
  }
}

/** Find the result vector a probe refers to (or undefined when this run didn't include it). */
export function vectorForProbe(r: ResolvedProbe, result: SimResult): Vector | undefined {
  if (r.problem) return undefined;
  if (r.probe.kind === "voltage") {
    if (r.netName === "0") return { name: "0", kind: "voltage", unit: "V", netName: "0", real: new Array(result.x?.real.length ?? 1).fill(0), imag: result.analysis === "ac" ? new Array(result.x?.real.length ?? 1).fill(0) : undefined };
    return result.vectors.find((v) => v.kind === "voltage" && v.netName?.toLowerCase() === r.netName!.toLowerCase());
  }
  return result.vectors.find((v) => v.kind === "current" && v.componentId === r.componentId);
}
