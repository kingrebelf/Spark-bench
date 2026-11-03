// Value tuning: E-series stepping, the tune slider's value mapping, debounced apply of typed values and
// undo sessions that fold a whole tuning gesture (typing, arrow/wheel steps, slider drags) into one step.
// Pure logic; the field components live in TuneField.tsx.
import type { ComponentDef, PropDef, Project } from "../core/types";
import { formatSI, parseSI } from "../core/units";

export type Series = "E12" | "E24" | "E96";

// Standard IEC 60063 mantissas (E12/E24 are not 10^(i/n) rounded, so they are listed).
export const SERIES: Record<Series, number[]> = {
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
  E96: [1.00, 1.02, 1.05, 1.07, 1.10, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.30, 1.33, 1.37, 1.40, 1.43, 1.47, 1.50, 1.54, 1.58,
    1.62, 1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.00, 2.05, 2.10, 2.15, 2.21, 2.26, 2.32, 2.37, 2.43, 2.49, 2.55,
    2.61, 2.67, 2.74, 2.80, 2.87, 2.94, 3.01, 3.09, 3.16, 3.24, 3.32, 3.40, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12,
    4.22, 4.32, 4.42, 4.53, 4.64, 4.75, 4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.90, 6.04, 6.19, 6.34, 6.49, 6.65,
    6.81, 6.98, 7.15, 7.32, 7.50, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76],
};

const EPS = 1e-9;
/** Round away float noise (4.7 * 1e3 = 4700.000000000001). */
const clean = (x: number) => Number(x.toPrecision(12));

/** Preferred-value series used for a unit: resistors E24, capacitors and inductors E12, others none. */
export function seriesFor(unit: string | undefined): Series | null {
  return unit === "Ω" ? "E24" : unit === "F" || unit === "H" ? "E12" : null;
}

/** Split a positive value into decade exponent and mantissa in [1, 10). */
function decade(v: number): { e: number; m: number } {
  let e = Math.floor(Math.log10(v));
  let m = v / 10 ** e;
  if (m >= 10 - EPS) { e += 1; m /= 10; }
  if (m < 1 - EPS) { e -= 1; m *= 10; }
  return { e, m };
}

/** Next series value strictly above (dir 1) or below (dir -1) v, from where v really is (5k ↑ E24 = 5.1k). */
export function nextInSeries(v: number, dir: 1 | -1, series: Series): number {
  const vals = SERIES[series];
  const { e, m } = decade(v);
  if (dir > 0) {
    const hit = vals.find((x) => x > m * (1 + EPS));
    return clean((hit ?? 10) * 10 ** e);
  }
  const below = vals.filter((x) => x < m * (1 - EPS));
  return below.length ? clean(below[below.length - 1] * 10 ** e) : clean(vals[vals.length - 1] * 10 ** (e - 1));
}

/** Nearest series value (log distance). */
export function snapToSeries(v: number, series: Series): number {
  if (!(v > 0)) return v;
  const { e, m } = decade(v);
  const cands = [...SERIES[series].map((x) => x * 10 ** e), 10 ** (e + 1), SERIES[series][SERIES[series].length - 1] * 10 ** (e - 1)];
  let best = cands[0];
  for (const c of cands) if (Math.abs(Math.log(c / v)) < Math.abs(Math.log(best / v))) best = c;
  return clean(best);
}

/** Largest 1-2-5 number not above x (x > 0). */
export function nice125(x: number): number {
  const e = Math.floor(Math.log10(x));
  const m = x / 10 ** e;
  return clean((m >= 5 - EPS ? 5 : m >= 2 - EPS ? 2 : 1) * 10 ** e);
}

export interface StepMods { shift?: boolean; ctrl?: boolean }

/**
 * One ↑/↓ step of a numeric value.
 * - Ω / F / H: next value of the preferred series (E24 for Ω, E12 for F/H; Shift = E96); Ctrl = ×10 / ÷10.
 * - %: 5 (Shift 1, Ctrl 10).
 * - other units: about 10 % of the value rounded to a 1-2-5 increment (Shift about 1 %); Ctrl = ×10 / ÷10.
 * The result is clamped to [min, max].
 */
export function stepValue(v: number, dir: 1 | -1, unit: string | undefined, mods: StepMods = {}, min?: number, max?: number): number {
  const clamp = (x: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, x));
  const series = seriesFor(unit);
  if (unit === "%") {
    const inc = mods.ctrl ? 10 : mods.shift ? 1 : 5;
    return clamp(clean((Math.round(v / inc) === v / inc ? v / inc + dir : (dir > 0 ? Math.ceil(v / inc) : Math.floor(v / inc))) * inc));
  }
  if (mods.ctrl && v !== 0) return clamp(clean(dir > 0 ? v * 10 : v / 10));
  if (series) {
    if (v > 0) return clamp(nextInSeries(v, dir, mods.shift ? "E96" : series));
    return clamp(dir > 0 ? (unit === "F" ? 1e-9 : unit === "H" ? 1e-6 : 1) : v);
  }
  const inc = v === 0 ? (mods.shift ? 0.1 : 1) : nice125(Math.abs(v) / (mods.shift ? 100 : 10));
  const q = v / inc;
  const n = Math.abs(q - Math.round(q)) < 1e-6 ? Math.round(q) + dir : dir > 0 ? Math.ceil(q) : Math.floor(q);
  return clamp(clean(n * inc));
}

// ---------------------------------------------------------------- storage format

const STORE_PREFIX: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];

/** Compact SI text for a prop, in the library's style: 4700 → "4.7k", 2.2e-5 → "22u", 1e6 → "1M" (parseSI: M = mega). */
export function toStored(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const abs = Math.abs(v);
  for (const [s, p] of STORE_PREFIX) if (abs >= s * (1 - EPS)) return `${Number((v / s).toPrecision(4))}${p}`;
  return `${Number((v / 1e-15).toPrecision(4))}f`;
}

// ---------------------------------------------------------------- tune slider

/**
 * Slider range. "series": positions are the preferred values between lo and hi (log spacing, every
 * position is a real part value). "linear": 200 even positions between lo and hi snapped to a 1-2-5 step.
 */
export interface TuneRange { kind: "series" | "linear"; lo: number; hi: number; series?: Series }

export const LINEAR_STEPS = 200;

/** Default slider range around a value: ÷10 to ×10 on preferred values; 0-100 for %; linear around 0 / negatives. */
export function defaultRange(v: number, unit: string | undefined, min?: number): TuneRange {
  if (unit === "%") return { kind: "linear", lo: Math.max(0, min ?? 0), hi: 100 };
  if (v > 0) {
    const series = seriesFor(unit) ?? "E24";
    return { kind: "series", series, lo: snapToSeries(v / 10, series), hi: snapToSeries(v * 10, series) };
  }
  const span = v === 0 ? 10 : Math.abs(v) * 10;
  return { kind: "linear", lo: Math.max(min ?? -Infinity, -span), hi: span };
}

/** A range with user-edited ends (kept valid: lo < hi, log ranges positive). */
export function withEnds(r: TuneRange, lo: number, hi: number): TuneRange | null {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null;
  if (r.kind === "series" && lo <= 0) return null;
  return { ...r, lo, hi };
}

/** The preferred values covered by a series range, ascending. */
export function rangePoints(r: TuneRange): number[] {
  if (r.kind !== "series") return [];
  const s = r.series ?? "E24";
  const out: number[] = [];
  let x = snapToSeries(r.lo, s);
  if (x < r.lo * (1 - EPS)) x = nextInSeries(x, 1, s);
  for (let guard = 0; x <= r.hi * (1 + EPS) && guard < 2000; guard++) { out.push(x); x = nextInSeries(x, 1, s); }
  return out;
}

/** Number of slider positions minus one (the slider's max). */
export function sliderMax(r: TuneRange): number {
  return r.kind === "series" ? Math.max(0, rangePoints(r).length - 1) : LINEAR_STEPS;
}

/** Value at a slider position. */
export function sliderToValue(r: TuneRange, pos: number): number {
  if (r.kind === "series") {
    const pts = rangePoints(r);
    return pts[Math.max(0, Math.min(pts.length - 1, Math.round(pos)))] ?? r.lo;
  }
  const raw = r.lo + (r.hi - r.lo) * Math.max(0, Math.min(LINEAR_STEPS, pos)) / LINEAR_STEPS;
  const inc = nice125((r.hi - r.lo) / LINEAR_STEPS);
  return clean(Math.round(raw / inc) * inc);
}

/** Slider position nearest to a value (clamped to the ends). */
export function valueToSlider(r: TuneRange, v: number): number {
  if (r.kind === "series") {
    const pts = rangePoints(r);
    if (!(v > 0) || !pts.length) return 0;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(Math.log(pts[i] / v)) < Math.abs(Math.log(pts[best] / v))) best = i;
    return best;
  }
  return Math.max(0, Math.min(LINEAR_STEPS, Math.round((v - r.lo) / (r.hi - r.lo) * LINEAR_STEPS)));
}

// ---------------------------------------------------------------- apply and undo

export interface Timers { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * Typed-value applier: a valid text applies `delay` ms after the last keystroke, or at once on `flush`
 * (Enter / blur). Invalid text never applies. The same text is never applied twice in a row.
 */
export function createApplier(opts: { delay?: number; isValid: (text: string) => boolean; apply: (text: string) => void; timers?: Timers }) {
  const delay = opts.delay ?? 250, t = opts.timers ?? realTimers;
  let pending: string | null = null, handle: unknown = null, last: string | null = null;
  const stop = () => { if (handle != null) t.clear(handle); handle = null; };
  const run = () => {
    stop();
    const text = pending;
    pending = null;
    if (text == null || text === last || !opts.isValid(text)) return false;
    last = text;
    opts.apply(text);
    return true;
  };
  return {
    /** The text currently stored, so re-typing it applies nothing. */
    reset(applied: string) { stop(); pending = null; last = applied; },
    edit(text: string) { pending = text; stop(); handle = t.set(run, delay); },
    /** Apply the pending text now; true when something was applied. */
    flush: run,
    cancel() { stop(); pending = null; },
    /** Record a value applied by other means (a step or the slider), cancelling any pending text. */
    applied(text: string) { stop(); pending = null; last = text; },
    get pending() { return pending; },
  };
}

type Update = (label: string, recipe: (d: Project) => void, opts?: { merge?: boolean }) => void;

/**
 * Undo session for one field: the first change after `begin` opens a new undo step, later changes fold
 * into it (the label must stay the same for the store to merge them).
 */
export function createEditSession(update: () => Update) {
  let fresh = true;
  return {
    begin() { fresh = true; },
    commit(label: string, recipe: (d: Project) => void) {
      update()(label, recipe, { merge: !fresh });
      fresh = false;
    },
  };
}

/** The main values of a part worth tuning (numbers that are neither model parameters nor ratings). */
export function tunableProps(def: ComponentDef): PropDef[] {
  const ratings = new Set((def.ratings ?? []).map((r) => r.prop));
  return def.props.filter((p) => p.kind === "number" && !p.model && !ratings.has(p.key));
}

/** Validate a numeric prop value. Returns the parsed number, an error or a warning. */
export function checkNumber(raw: string, p: PropDef): { value?: number; error?: string; warning?: string } {
  if (raw.trim() === "") return p.default === "" ? {} : { error: "Required. Enter a number such as 4.7k, 100n or 1MEG." };
  const v = parseSI(raw);
  if (Number.isNaN(v)) return { error: "Not a number. Use e.g. 4.7k, 100n, 2.2u, 1MEG (M = mega, m = milli)." };
  if (p.min !== undefined && v < p.min) return { value: v, error: `Must be at least ${formatSI(p.min, p.unit ?? "")}.` };
  if (p.min === 0 && v === 0 && /Ω|F|H/.test(p.unit ?? "")) return { value: v, warning: "Zero may make the circuit unsolvable." };
  if (/^\s*[-+]?[\d.]+\s*m\s*(Ω|ohm)?\s*$/i.test(raw) && p.unit === "Ω") return { value: v, warning: "“m” means milli (×0.001). For mega use “M” or “MEG”." };
  return { value: v };
}
