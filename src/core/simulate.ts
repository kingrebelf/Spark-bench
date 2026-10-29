// Runs a project through a SPICE engine and returns honest results.
// The engine is abstracted so tests use ngspice-WASM in Node and the app uses a Web Worker.
import { hasErrors, runChecks } from "./checks";
import { getPart } from "./library";
import { generateNetlist, type NetlistResult } from "./netlist";
import type { AnalysisKind, ComponentDef, Diagnostic, Project, SimResult, Vector } from "./types";

/** Raw engine output, matching eecircuit-engine's ResultType plus its message log. */
export interface EngineOutput {
  dataType: "real" | "complex";
  variableNames: string[];
  data: { name: string; type: string; values: (number | { real: number; img: number })[] }[];
  numPoints: number;
  /** Lines from ngspice's error/warning stream. */
  messages: string[];
}
export interface SpiceEngine { run(netlist: string): Promise<EngineOutput> }

interface Rule { re: RegExp; code: string; severity: Diagnostic["severity"]; message: (m: RegExpExecArray) => string; fix: string }

// Order matters: first match wins for a line.
const RULES: Rule[] = [
  { re: /circuit not parsed/i, code: "spice-parse", severity: "error", message: () => "ngspice could not parse the generated netlist.", fix: "This usually means a part has an invalid value or model. Check the parts listed above; if none are listed, report this netlist as a bug." },
  { re: /unknown device type|unknown model|could not find (?:a valid )?model|unable to find definition of model/i, code: "spice-unknown-model", severity: "error", message: (m) => `ngspice does not know a device or model used here (${m.input.trim()}).`, fix: "The part's model is unavailable in this engine. Replace the part or import its SPICE model." },
  { re: /singular matrix:\s*check node (\S+)/i, code: "spice-singular", severity: "error", message: (m) => `The circuit equations are singular at node ${m[1]}: that node is floating or shorted by ideal sources.`, fix: "Make sure the node connects to ground through a resistor, and that no two voltage sources (or a source and an inductor) are directly in parallel." },
  { re: /timestep too small/i, code: "spice-timestep", severity: "error", message: () => "Transient simulation failed: the time step became too small (the solver could not converge).", fix: "Try a smaller maximum step, add small series resistance to ideal switches/sources, or add capacitance at fast-switching nodes." },
  { re: /(gmin|source) stepping failed/i, code: "spice-dc-converge", severity: "warning", message: (m) => `DC operating point needed fallback methods (${m[1]} stepping failed).`, fix: "The result may still be valid if a later method succeeded. Check for very large or very small component values." },
  { re: /no convergence|convergence failed|iteration limit reached|doAnalyses: .*(?:failed|aborted)/i, code: "spice-converge", severity: "error", message: (m) => `ngspice failed to converge: ${m.input.trim()}`, fix: "Check for unrealistic values, missing ground paths, or ideal components that form loops. Adding small resistances often helps." },
  { re: /simulation interrupted due to error|fatal error|error:/i, code: "spice-error", severity: "error", message: (m) => `ngspice reported an error: ${m.input.trim()}`, fix: "See the simulation log for details." },
  { re: /^warning:/i, code: "spice-warning", severity: "warning", message: (m) => `ngspice: ${m.input.trim()}`, fix: "" },
];

/** Classify engine messages. Notes are kept in the log only. */
export function classifyMessages(messages: string[], nl?: NetlistResult): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of messages) {
    const line = raw.trim();
    if (!line || /^note:/i.test(line)) continue;
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (!m) continue;
      const msg = r.message(m);
      if (seen.has(r.code + msg)) break;
      seen.add(r.code + msg);
      const d: Diagnostic = { severity: r.severity, code: r.code, message: msg, fix: r.fix || undefined, source: "spice" };
      if (nl && r.code === "spice-singular") {
        const net = nl.connectivity.nets.find((n) => n.name.toLowerCase() === m[1].toLowerCase());
        if (net) { d.netNames = [net.name]; d.componentIds = [...new Set(net.pins.map((p) => p.componentId))]; d.wireIds = net.wireIds; }
      }
      if (nl && r.code === "spice-unknown-model") {
        const el = /^\s*(\S+)/.exec(line.replace(/^.*?:\s*/, ""))?.[1]?.toLowerCase();
        const id = el && nl.elementMap.get(el);
        if (id) d.componentIds = [id];
      }
      out.push(d);
      break;
    }
  }
  return out;
}

function toVector(name: string, type: string, values: EngineOutput["data"][number]["values"], nl: NetlistResult): Vector {
  const lower = name.toLowerCase();
  const complex = typeof values[0] === "object";
  const real = values.map((v) => (typeof v === "number" ? v : v.real));
  const imag = complex ? values.map((v) => (typeof v === "number" ? 0 : v.img)) : undefined;
  if (lower === "time") return { name, kind: "time", unit: "s", real };
  if (lower === "frequency") return { name, kind: "frequency", unit: "Hz", real };
  let m = /^v\((.+)\)$/.exec(lower);
  if (m || type === "voltage") {
    const node = m ? m[1] : lower;
    const net = nl.connectivity.nets.find((n) => n.name.toLowerCase() === node);
    return { name, kind: "voltage", unit: "V", netName: net?.name ?? node, real, imag };
  }
  m = /^i\((.+)\)$/.exec(lower) ?? /^@(.+)\[i\w*\]$/.exec(lower) ?? /^(.+)#branch$/.exec(lower);
  if (m || type === "current") {
    const el = m ? m[1] : lower;
    return { name, kind: "current", unit: "A", componentId: nl.elementMap.get(el), real, imag };
  }
  return { name, kind: "other", unit: "", real, imag };
}

export async function simulate(
  project: Project,
  engine: SpiceEngine,
  analysis: AnalysisKind = project.simulation.analysis,
  lookup: (id: string) => ComponentDef | undefined = getPart,
): Promise<SimResult> {
  const t0 = Date.now();
  const nl = generateNetlist(project, analysis, lookup);
  const pre = [...runChecks(project, lookup, nl.connectivity), ...nl.diagnostics];
  const base = { analysis, netlist: nl.text, vectors: [] as Vector[], log: [] as string[] };
  if (hasErrors(pre)) return { ...base, ok: false, diagnostics: pre, elapsedMs: Date.now() - t0 };

  let out: EngineOutput;
  try {
    out = await engine.run(nl.text);
  } catch (e) {
    return { ...base, ok: false, elapsedMs: Date.now() - t0, diagnostics: [...pre, { severity: "error", code: "engine-crash", source: "spice",
      message: `The simulation engine stopped unexpectedly: ${(e as Error).message}`, fix: "Reset the simulator and try again. If it repeats, save the project and report the netlist." }] };
  }
  const spiceDiag = classifyMessages(out.messages, nl);
  const diagnostics = [...pre, ...spiceDiag];
  const log = out.messages;
  // A failed parse still yields a result object with no variables; never present it as data.
  if (hasErrors(spiceDiag) || out.variableNames.length === 0 || out.numPoints === 0) {
    if (!hasErrors(diagnostics)) diagnostics.push({ severity: "error", code: "spice-no-data", source: "spice",
      message: "ngspice finished without producing any results.", fix: "Check the simulation log; the analysis settings may be invalid." });
    return { ...base, ok: false, diagnostics, log, elapsedMs: Date.now() - t0 };
  }
  const vectors = out.data.map((d) => toVector(d.name, d.type, d.values, nl));
  const x = vectors.find((v) => v.kind === "time" || v.kind === "frequency");
  const bad = vectors.some((v) => v.real.some((n) => !Number.isFinite(n)));
  if (bad) diagnostics.push({ severity: "error", code: "spice-nan", source: "spice",
    message: "The results contain non-finite values (NaN or infinity).", fix: "The circuit likely has an unrealistic value or an ideal short. Results are hidden." });
  return {
    ok: !bad, analysis, netlist: nl.text, log, diagnostics,
    x, vectors: bad ? [] : vectors.filter((v) => v !== x), elapsedMs: Date.now() - t0,
  };
}
