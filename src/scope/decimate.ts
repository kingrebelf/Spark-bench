// Min/max decimation for display: at most two points per pixel column, so a 100k-point trace
// draws as ~2×width segments while keeping every spike visible.
import { lowerBound } from "./measure";

export interface Decimated { x: Float64Array; y: Float64Array; length: number }

/**
 * Decimate (x, y) over the visible range [x0, x1] into `columns` buckets. `toCol` maps x to a column
 * (so log axes work). One sample just outside each edge is kept so lines reach the plot border.
 */
export function decimate(x: ArrayLike<number>, y: ArrayLike<number>, x0: number, x1: number, columns: number,
  toCol: (v: number) => number = (v) => (v - x0) / (x1 - x0) * columns): Decimated {
  const n = x.length;
  let a = Math.max(0, lowerBound(x, x0) - 1);
  let ub = lowerBound(x, x1);
  while (ub < n && x[ub] <= x1) ub++;
  let b = Math.min(n, ub + 1);
  if (b - a <= 2 * columns + 2) {
    const ox = new Float64Array(b - a), oy = new Float64Array(b - a);
    for (let i = a; i < b; i++) { ox[i - a] = x[i]; oy[i - a] = y[i]; }
    return { x: ox, y: oy, length: b - a };
  }
  const cap = 2 * columns + 2;
  const ox = new Float64Array(cap), oy = new Float64Array(cap);
  let k = 0;
  const push = (i: number) => { if (k < cap) { ox[k] = x[i]; oy[k] = y[i]; k++; } };
  // Edge samples outside the visible range.
  if (x[a] < x0) { push(a); a++; }
  const last = b - 1;
  const tail = x[last] > x1 ? last : -1;
  if (tail >= 0) b--;
  const colOf = (v: number) => Math.min(columns - 1, Math.max(0, Math.floor(toCol(v))));
  let i = a;
  while (i < b) {
    const col = colOf(x[i]);
    let lo = i, hi = i;
    let j = i + 1;
    while (j < b && colOf(x[j]) === col) {
      if (y[j] < y[lo]) lo = j;
      if (y[j] > y[hi]) hi = j;
      j++;
    }
    // Keep min and max in time order.
    if (lo === hi) push(lo);
    else if (lo < hi) { push(lo); push(hi); }
    else { push(hi); push(lo); }
    i = j;
  }
  if (tail >= 0) push(tail);
  return { x: ox, y: oy, length: k };
}
