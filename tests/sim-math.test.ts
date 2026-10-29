import { describe, expect, it } from "vitest";
import { interpolate, measure } from "../src/scope/measure";
import { decimate } from "../src/scope/decimate";
import { resultToCsv } from "../src/sim/exporting";
import { suggestAc, suggestTran, validateSetup } from "../src/sim/setup";
import { Builder, divider } from "./helpers";
import type { SimResult, Vector } from "../src/core/types";

/** Sine sampled on a deliberately nonuniform time grid, like ngspice's adaptive steps. */
function sine(A: number, f: number, offset: number, periods: number, n = 20000) {
  const T = periods / f;
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const t = T * (u + 0.03 * Math.sin(7 * Math.PI * u) / (7 * Math.PI)); // monotonic, uneven spacing
    x.push(t); y.push(offset + A * Math.sin(2 * Math.PI * f * t));
  }
  return { x, y };
}

describe("measurements", () => {
  it("sine: RMS = A/√2, avg = offset, pk-pk = 2A, frequency within 0.5 %", () => {
    const { x, y } = sine(2, 1000, 0.5, 10);
    const m = measure(x, y)!;
    expect(m.avg).toBeCloseTo(0.5, 3);
    expect(m.min).toBeCloseTo(-1.5, 3);
    expect(m.max).toBeCloseTo(2.5, 3);
    expect(m.pkpk).toBeCloseTo(4, 3);
    // RMS of offset + sine = sqrt(offset² + A²/2)
    expect(m.rms).toBeCloseTo(Math.sqrt(0.25 + 2), 3);
    expect(Math.abs(m.freq! - 1000) / 1000).toBeLessThan(0.005);
  });

  it("is time-weighted on uneven steps", () => {
    // 0 V for 9 s (two samples), then 10 V for 1 s: sample average would be 5, true average is 1.
    const m = measure([0, 9, 9, 10], [0, 0, 10, 10])!;
    expect(m.avg).toBeCloseTo(1, 9);
    expect(m.rms).toBeCloseTo(Math.sqrt(10), 9);
  });

  it("refuses a frequency with fewer than two periods or for DC", () => {
    const { x, y } = sine(1, 50, 0, 1.5);
    expect(measure(x, y)!.freq).toBeNull();
    expect(measure([0, 1, 2], [3, 3, 3])!.freq).toBeNull();
    expect(measure([0], [1])).toBeNull();
  });

  it("measures inside a window only", () => {
    const m = measure([0, 1, 2, 3, 4], [0, 10, 20, 30, 40], 1, 3)!;
    expect(m.min).toBe(10); expect(m.max).toBe(30); expect(m.avg).toBeCloseTo(20, 9); expect(m.n).toBe(3);
  });

  it("interpolates and clamps", () => {
    expect(interpolate([0, 1, 2], [0, 10, 0], 0.25)).toBeCloseTo(2.5);
    expect(interpolate([0, 1, 2], [0, 10, 0], -1)).toBe(0);
    expect(interpolate([0, 1, 2], [0, 10, 5], 9)).toBe(5);
  });
});

describe("decimation", () => {
  const N = 100_000;
  const x = Array.from({ length: N }, (_, i) => i * 1e-6);
  const y = x.map((t) => Math.sin(2 * Math.PI * 50 * t) * 0.1);
  y[54_321] = 7; // single-sample spike

  it("keeps at most 2 points per column plus the two edge samples", () => {
    const d = decimate(x, y, 0, x[N - 1], 800);
    expect(d.length).toBeLessThanOrEqual(2 * 800 + 2);
    expect(d.length).toBeGreaterThan(800);
  });

  it("keeps an isolated spike", () => {
    const d = decimate(x, y, 0, x[N - 1], 300);
    expect(Math.max(...d.y.subarray(0, d.length))).toBe(7);
  });

  it("is time ordered and includes one sample beyond each edge of a zoomed view", () => {
    const x0 = 0.02, x1 = 0.03;
    const d = decimate(x, y, x0, x1, 200);
    const xs = Array.from(d.x.subarray(0, d.length));
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    expect(xs[0]).toBeLessThan(x0);
    expect(xs[xs.length - 1]).toBeGreaterThan(x1);
  });

  it("returns raw samples when there are fewer than the column budget", () => {
    const d = decimate([0, 1, 2, 3], [5, 6, 7, 8], 0, 3, 100);
    expect(Array.from(d.y.subarray(0, d.length))).toEqual([5, 6, 7, 8]);
  });
});

describe("CSV export", () => {
  const v = (name: string, real: number[], unit = "V", imag?: number[]): Vector => ({ name, kind: unit === "V" ? "voltage" : "current", unit, real, imag });
  const base = { ok: true, diagnostics: [], netlist: "", log: [], elapsedMs: 0 };

  it("transient: time column then one column per trace", () => {
    const r: SimResult = { ...base, analysis: "tran", x: { name: "time", kind: "time", unit: "s", real: [0, 1e-3] }, vectors: [] };
    const csv = resultToCsv(r, [{ label: "V(out)", vector: v("v(out)", [0, 2.5]) }, { label: "I(R1, x)", vector: v("i", [1e-3, NaN], "A") }]);
    expect(csv).toBe('time (s),V(out) (V),"I(R1, x) (A)"\n0,0,0.001\n0.001,2.5,\n');
  });

  it("ac: magnitude, dB and phase", () => {
    const r: SimResult = { ...base, analysis: "ac", x: { name: "frequency", kind: "frequency", unit: "Hz", real: [10] }, vectors: [] };
    const csv = resultToCsv(r, [{ label: "V(vc)", vector: v("v(vc)", [0.5], "V", [-0.5]) }]).trim().split("\n");
    expect(csv[0]).toBe("frequency (Hz),|V(vc)| (V),V(vc) (dB),V(vc) phase (deg)");
    const [f, m, db, ph] = csv[1].split(",").map(Number);
    expect(f).toBe(10); expect(m).toBeCloseTo(Math.SQRT1_2, 12); expect(db).toBeCloseTo(-3.0103, 4); expect(ph).toBeCloseTo(-45, 9);
  });

  it("op: a header and one row", () => {
    const r: SimResult = { ...base, analysis: "op", vectors: [] };
    expect(resultToCsv(r, [{ label: "V(out)", vector: v("v(out)", [5]) }])).toBe("V(out) (V)\n5\n");
  });
});

describe("analysis setup", () => {
  it("suggests 5 periods and 100 points per period from source frequencies", () => {
    const b = new Builder();
    b.place("vsine", "V1", 0, 0, { frequency: "1k" });
    b.place("vpulse", "V2", 10, 0, { frequency: "10k" });
    const s = suggestTran(b.project)!;
    expect(s.stop).toBe("5m");
    expect(s.step).toBe("1u");
    expect(s.reason).toMatch(/V1/);
    expect(suggestTran(divider().b.project)).toBeNull();
    expect(suggestAc(b.project)).toMatchObject({ start: "10", stop: "1MEG" });
  });

  it("blocks invalid transient settings with a fix", () => {
    const { b } = divider();
    b.project.simulation.tran = { stop: "abc", step: "1m" };
    const d = validateSetup(b.project, "tran");
    expect(d.find((x) => x.code === "setup-tran-stop")?.severity).toBe("error");
    b.project.simulation.tran = { stop: "1m", step: "10m" };
    expect(validateSetup(b.project, "tran").some((x) => x.code === "setup-tran-order")).toBe(true);
    b.project.simulation.tran = { stop: "10m", step: "10u" };
    expect(validateSetup(b.project, "tran")).toEqual([]);
  });

  it("refuses an AC run when no source has an AC magnitude, naming the source", () => {
    const { b, V1 } = divider();
    const d = validateSetup(b.project, "ac");
    const e = d.find((x) => x.code === "setup-ac-nosource")!;
    expect(e.severity).toBe("error");
    expect(e.componentIds).toEqual([V1.id]);
    expect(e.fix).toMatch(/V1/);
    b.project.simulation.ac.start = "0";
    expect(validateSetup(b.project, "ac").some((x) => x.code === "setup-ac-start")).toBe(true);
  });
});
