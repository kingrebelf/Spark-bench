// Analysis setup: validation (blocks Run on settings ngspice would misread) and defaults derived
// from the circuit's sources.
import { getPart } from "../core/library";
import { formatSI, parseSI } from "../core/units";
import type { AnalysisKind, ComponentDef, Diagnostic, Project } from "../core/types";

/** Short SPICE-style number for an input field: 0.0005 -> "500u". */
export function siText(v: number): string {
  return formatSI(v, "", 3).replace(/\s/g, "").replace("µ", "u").replace(/M$/, "MEG");
}

const err = (code: string, message: string, fix: string): Diagnostic => ({ severity: "error", code, message, fix, source: "check" });
const warn = (code: string, message: string, fix: string, componentIds?: string[]): Diagnostic => ({ severity: "warning", code, message, fix, source: "check", componentIds });

/** Signal sources: parts with a "frequency" prop in Hz. */
export function sourceFrequencies(project: Project, lookup: (id: string) => ComponentDef | undefined = getPart): { id: string; ref: string; f: number }[] {
  const out: { id: string; ref: string; f: number }[] = [];
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    const pd = def?.props.find((p) => p.key === "frequency" && p.unit === "Hz");
    if (!pd) continue;
    const f = parseSI((c.props.frequency ?? pd.default) as string);
    if (Number.isFinite(f) && f > 0) out.push({ id: c.id, ref: c.ref, f });
  }
  return out;
}

export interface TranSuggestion { stop: string; step: string; reason: string }

/** Five periods of the slowest source, ~100 points per period of the fastest (capped at 200k points). */
export function suggestTran(project: Project, lookup = getPart): TranSuggestion | null {
  const fs = sourceFrequencies(project, lookup);
  if (!fs.length) return null;
  const lo = fs.reduce((a, b) => (b.f < a.f ? b : a)), hi = fs.reduce((a, b) => (b.f > a.f ? b : a));
  const stop = 5 / lo.f;
  const step = Math.max(1 / (hi.f * 100), stop / 200_000);
  return { stop: siText(stop), step: siText(step),
    reason: `5 periods of ${lo.ref} (${formatSI(lo.f, "Hz")})${hi !== lo ? `, ~100 points per period of ${hi.ref} (${formatSI(hi.f, "Hz")})` : ", ~100 points per period"}` };
}

export interface AcSuggestion { start: string; stop: string; reason: string }

/** Two decades around the source frequencies, or 1 Hz – 1 MHz when there are none. */
export function suggestAc(project: Project, lookup = getPart): AcSuggestion {
  const fs = sourceFrequencies(project, lookup);
  if (!fs.length) return { start: "1", stop: "1MEG", reason: "no source frequencies in the circuit; 1 Hz to 1 MHz" };
  const lo = Math.min(...fs.map((x) => x.f)), hi = Math.max(...fs.map((x) => x.f));
  const start = 10 ** Math.floor(Math.log10(lo) - 2), stop = 10 ** Math.ceil(Math.log10(hi) + 2);
  return { start: siText(start), stop: siText(stop), reason: `two decades around the source frequencies (${fs.map((x) => `${x.ref} ${formatSI(x.f, "Hz")}`).join(", ")})` };
}

/** Sources that drive an AC analysis (nonzero AC magnitude). */
export function acSources(project: Project, lookup = getPart): { ids: string[]; sources: string[] } {
  const ids: string[] = [], sources: string[] = [];
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    const pd = def?.props.find((p) => p.key === "acmag");
    if (!pd) continue;
    sources.push(c.ref);
    const v = parseSI((c.props.acmag ?? pd.default) as string);
    if (Number.isFinite(v) && v !== 0) ids.push(c.id);
  }
  return { ids, sources };
}

/** Validate analysis settings. Errors block Run; warnings are shown with the result. */
export function validateSetup(project: Project, analysis: AnalysisKind = project.simulation.analysis, lookup = getPart): Diagnostic[] {
  const s = project.simulation;
  const out: Diagnostic[] = [];
  if (analysis === "tran") {
    const stop = parseSI(s.tran.stop), step = parseSI(s.tran.step);
    const start = s.tran.start?.trim() ? parseSI(s.tran.start) : 0;
    if (!(stop > 0)) out.push(err("setup-tran-stop", `Transient stop time "${s.tran.stop}" is not a positive time.`, "Enter a stop time such as 10m (10 ms) or 1u (1 µs)."));
    if (!(step > 0)) out.push(err("setup-tran-step", `Transient max step "${s.tran.step}" is not a positive time.`, "Enter a step such as 10u. Smaller steps give smoother waveforms but take longer."));
    if (!Number.isFinite(start) || start < 0) out.push(err("setup-tran-start", `Transient start time "${s.tran.start}" is not a valid time.`, "Leave it empty to save data from 0 s, or enter a time before the stop time."));
    if (stop > 0 && step > 0) {
      if (step > stop) out.push(err("setup-tran-order", `Max step (${formatSI(step, "s")}) is larger than the stop time (${formatSI(stop, "s")}).`, "Make the max step smaller than the stop time, e.g. stop/1000."));
      if (start >= stop) out.push(err("setup-tran-window", `Start time (${formatSI(start, "s")}) must be before the stop time (${formatSI(stop, "s")}).`, "Lower the start time or raise the stop time."));
      const pts = (stop - start) / step;
      if (pts > 2_000_000) out.push(err("setup-tran-huge", `This run would need at least ${Math.round(pts).toLocaleString()} time points.`, "Raise the max step or shorten the stop time; more than 2 million points will exhaust memory."));
      else if (pts > 200_000) out.push(warn("setup-tran-large", `This run will produce at least ${Math.round(pts).toLocaleString()} time points and may take a while.`, "Raise the max step if you don't need that resolution."));
    }
  } else if (analysis === "ac") {
    const f0 = parseSI(s.ac.start), f1 = parseSI(s.ac.stop);
    if (!(f0 > 0)) out.push(err("setup-ac-start", `AC start frequency "${s.ac.start}" must be a positive frequency.`, s.ac.sweep === "lin" ? "Enter a start frequency such as 1 or 10k." : "Logarithmic sweeps can't start at 0 Hz; enter e.g. 1 or 10."));
    if (!(f1 > 0)) out.push(err("setup-ac-stop", `AC stop frequency "${s.ac.stop}" must be a positive frequency.`, "Enter a stop frequency such as 1MEG."));
    if (f0 > 0 && f1 > 0 && f1 < f0) out.push(err("setup-ac-order", `AC stop frequency (${formatSI(f1, "Hz")}) is below the start (${formatSI(f0, "Hz")}).`, "Swap the start and stop frequencies."));
    if (!(Number.isInteger(s.ac.points) && s.ac.points >= 1)) out.push(err("setup-ac-points", `AC points "${s.ac.points}" must be a whole number of at least 1.`, s.ac.sweep === "lin" ? "Enter the total number of points, e.g. 100." : `Enter points per ${s.ac.sweep === "dec" ? "decade" : "octave"}, e.g. 20.`));
    else if (s.ac.points > 10_000) out.push(err("setup-ac-points", `${s.ac.points} AC points is more than this app plots.`, "Use at most 10 000 points."));
    const src = acSources(project, lookup);
    if (!src.ids.length) {
      out.push(warn("setup-ac-nosource", src.sources.length
        ? `No source has a nonzero AC magnitude (${src.sources.join(", ")} ${src.sources.length > 1 ? "are" : "is"} 0), so every AC result would be zero.`
        : "The circuit has no source with an AC magnitude, so every AC result would be zero.",
        src.sources.length ? `Select ${src.sources[0]} and set its AC magnitude (under Model) to 1 V.` : "Add a sine source (its AC magnitude defaults to 1 V)."));
      out[out.length - 1].severity = "error";
      out[out.length - 1].componentIds = project.schematic.components.filter((c) => src.sources.includes(c.ref)).map((c) => c.id);
    }
  }
  return out;
}
