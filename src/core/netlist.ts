// Project -> ngspice netlist. Pure function; no engine dependency.
import { computeConnectivity, type Connectivity } from "./connectivity";
import { getPart } from "./library";
import { parseSI, toSpiceNumber } from "./units";
import type { AnalysisKind, ComponentDef, Diagnostic, Project } from "./types";

export interface NetlistResult {
  text: string;
  connectivity: Connectivity;
  diagnostics: Diagnostic[];
  /** SPICE element name (lowercase) -> component id, for mapping engine messages and currents back. */
  elementMap: Map<string, string>;
}

export interface NetlistOptions {
  /** Live mode: component id -> [time, value] schedule for its interactive prop. */
  schedules?: Map<string, [number, number][]>;
}

/** SPICE element names must start with the element letter; we prefix when the ref doesn't. */
export function spiceElementName(letter: string, ref: string): string {
  const safe = ref.replace(/[^A-Za-z0-9_]/g, "_");
  return safe.toUpperCase().startsWith(letter.toUpperCase()) ? safe : `${letter}${safe}`;
}

export function analysisCard(project: Project, analysis: AnalysisKind): string {
  const s = project.simulation;
  if (analysis === "op") return ".op";
  if (analysis === "tran") {
    const step = toSpiceNumber(parseSI(s.tran.step));
    const stop = toSpiceNumber(parseSI(s.tran.stop));
    const start = s.tran.start ? ` ${toSpiceNumber(parseSI(s.tran.start))}` : "";
    return `.tran ${step} ${stop}${start}${s.tran.uic ? " uic" : ""}`;
  }
  return `.ac ${s.ac.sweep} ${Math.max(1, Math.round(s.ac.points))} ${toSpiceNumber(parseSI(s.ac.start))} ${toSpiceNumber(parseSI(s.ac.stop))}`;
}

export function generateNetlist(
  project: Project,
  analysis: AnalysisKind = project.simulation.analysis,
  lookup: (id: string) => ComponentDef | undefined = getPart,
  opts: NetlistOptions = {},
): NetlistResult {
  const connectivity = computeConnectivity(project, lookup);
  const diagnostics: Diagnostic[] = [];
  const lines: string[] = [];
  const defines = new Map<string, string>();
  const elementMap = new Map<string, string>();
  const modelsById = new Map(project.models.map((m) => [m.id, m]));

  for (const inst of project.schematic.components) {
    const def = lookup(inst.type);
    if (!def || !def.spice || def.role) continue;
    if (def.analyses?.[analysis] === false) {
      diagnostics.push({ severity: "error", code: "unsupported-analysis", source: "check", componentIds: [inst.id],
        message: `${inst.ref} (${def.name}) cannot be used in ${analysis.toUpperCase()} analysis.`,
        fix: `Remove ${inst.ref} or choose a different analysis.` });
      continue;
    }
    const ctx = {
      inst,
      analysis,
      node: (pinId: string) => connectivity.pinNet.get(`${inst.id}:${pinId}`) ?? `NC_${inst.ref}_${pinId}`,
      str: (key: string) => String(inst.props[key] ?? def.props.find((p) => p.key === key)?.default ?? ""),
      num: (key: string) => {
        const raw = inst.props[key] ?? def.props.find((p) => p.key === key)?.default;
        const v = parseSI(raw as string | number);
        if (Number.isNaN(v)) {
          const label = def.props.find((p) => p.key === key)?.label ?? key;
          diagnostics.push({ severity: "error", code: "invalid-value", source: "check", componentIds: [inst.id],
            message: `${inst.ref}: "${raw}" is not a valid ${label}.`,
            fix: `Enter a number with an optional SI prefix, e.g. 4.7k, 100n, 1MEG.` });
        }
        return v;
      },
      define: (key: string, text: string) => { if (!defines.has(key)) defines.set(key, text); },
      model: (id: string) => modelsById.get(id),
      schedule: opts.schedules?.get(inst.id),
    };
    const out = def.spice(ctx);
    if (out === null) {
      diagnostics.push({ severity: "error", code: "unsupported-part", source: "check", componentIds: [inst.id],
        message: `${inst.ref} (${def.name}) has no simulation model for this analysis.`,
        fix: "Replace it with a simulatable part, or remove it before simulating." });
      continue;
    }
    for (const l of out) {
      const name = l.trim().split(/\s+/)[0]?.toLowerCase();
      if (name && !name.startsWith(".")) elementMap.set(name, inst.id);
    }
    lines.push(`* ${inst.ref} ${def.name}`, ...out);
  }

  const text = [
    `* SparkBench netlist: ${project.meta.name}`,
    ...lines,
    ...defines.values(),
    analysisCard(project, analysis),
    ".end",
    "",
  ].join("\n");
  return { text, connectivity, diagnostics, elementMap };
}

export { toSpiceNumber };
