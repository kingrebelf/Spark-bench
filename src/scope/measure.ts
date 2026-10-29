// Waveform measurements on nonuniformly sampled data (ngspice transient steps vary).
// Averages and RMS are time-weighted (trapezoidal); frequency needs at least two full periods.

export interface Measurements {
  min: number;
  max: number;
  pkpk: number;
  avg: number;
  rms: number;
  /** Fundamental frequency from mean crossings, or null when the signal is not clearly periodic in the window. */
  freq: number | null;
  /** Number of samples measured. */
  n: number;
}

/** Index of the first sample with x >= v (x ascending). */
export function lowerBound(x: ArrayLike<number>, v: number): number {
  let lo = 0, hi = x.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Linear interpolation of y at x = t (clamped to the ends). */
export function interpolate(x: ArrayLike<number>, y: ArrayLike<number>, t: number): number {
  const n = x.length;
  if (!n) return NaN;
  if (t <= x[0]) return y[0];
  if (t >= x[n - 1]) return y[n - 1];
  const i = lowerBound(x, t);
  const x0 = x[i - 1], x1 = x[i];
  return x1 === x0 ? y[i] : y[i - 1] + (y[i] - y[i - 1]) * (t - x0) / (x1 - x0);
}

/** Measure y over x in [x0, x1] (whole range when omitted). Returns null when there are fewer than 2 samples. */
export function measure(x: ArrayLike<number>, y: ArrayLike<number>, x0 = -Infinity, x1 = Infinity): Measurements | null {
  const a = Math.max(0, lowerBound(x, x0));
  const b = Math.min(x.length, lowerBound(x, x1 + Number.EPSILON * Math.abs(x1)) );
  const n = b - a;
  if (n < 2) return null;
  let min = Infinity, max = -Infinity, area = 0, area2 = 0;
  for (let i = a; i < b; i++) {
    const v = y[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (i > a) {
      const dt = x[i] - x[i - 1], p = y[i - 1];
      area += (p + v) * 0.5 * dt;
      // Exact integral of the square of a linear segment.
      area2 += (p * p + p * v + v * v) / 3 * dt;
    }
  }
  const span = x[b - 1] - x[a];
  const avg = span > 0 ? area / span : y[a];
  const rms = span > 0 ? Math.sqrt(Math.max(0, area2 / span)) : Math.abs(y[a]);
  return { min, max, pkpk: max - min, avg, rms, freq: frequency(x, y, a, b, avg, max - min), n };
}

/**
 * Frequency from rising crossings of the mean level with 10 % hysteresis.
 * Requires at least two full periods (three rising crossings) and consistent periods (±20 %).
 */
export function frequency(x: ArrayLike<number>, y: ArrayLike<number>, a: number, b: number, mid: number, pkpk: number): number | null {
  if (!(pkpk > 0)) return null;
  const hyst = pkpk * 0.1;
  const rising: number[] = [];
  let armed = false;
  for (let i = a + 1; i < b; i++) {
    if (y[i] < mid - hyst) armed = true;
    if (armed && y[i - 1] < mid && y[i] >= mid) {
      const t = x[i - 1] + (mid - y[i - 1]) * (x[i] - x[i - 1]) / (y[i] - y[i - 1]);
      rising.push(t);
      armed = false;
    }
  }
  if (rising.length < 3) return null;
  const periods = rising.slice(1).map((t, i) => t - rising[i]);
  const mean = (rising[rising.length - 1] - rising[0]) / periods.length;
  if (!(mean > 0) || periods.some((p) => Math.abs(p - mean) > 0.2 * mean)) return null;
  return 1 / mean;
}
