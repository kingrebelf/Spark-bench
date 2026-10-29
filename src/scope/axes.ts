// Axis tick generation with SI labels.
import { formatSI } from "../core/units";

/** "Nice" linear ticks (1/2/5 × 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, target = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Log ticks: every decade, plus 2 and 5 when the range spans few decades. */
export function logTicks(min: number, max: number): { value: number; major: boolean }[] {
  if (!(min > 0) || !(max > min)) return [];
  const d0 = Math.floor(Math.log10(min)), d1 = Math.ceil(Math.log10(max));
  const subs = d1 - d0 <= 3 ? [1, 2, 5] : [1];
  const out: { value: number; major: boolean }[] = [];
  for (let d = d0; d <= d1; d++) for (const s of subs) {
    const v = s * 10 ** d;
    if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) out.push({ value: v, major: s === 1 });
  }
  return out;
}

/** Tick label: SI prefixes for physical units; plain numbers for dB and degrees. */
export function tickLabel(v: number, unit: string): string {
  if (unit === "dB" || unit === "°") return `${Number(v.toPrecision(4))}${unit === "°" ? "°" : ""}`;
  return formatSI(v, unit, 3);
}
