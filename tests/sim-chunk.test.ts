// Chunked continuation from saved state must reproduce one continuous ngspice run.
import { describe, expect, it } from "vitest";
import { Builder, engine } from "./helpers";
import { applyInitialState, lastIndexAtOrBefore, simulateChunked, stateAt } from "../src/sim/chunk";
import { runSimulation } from "../src/sim/run";
import { interpolate } from "../src/scope/measure";
import { buildExamples } from "../src/library/examples";
import { parseSI } from "../src/core/units";
import type { Project, SimResult } from "../src/core/types";

const vec = (r: SimResult, name: string) => r.vectors.find((v) => v.name === name)!.real;

/** Times a vector crosses `level` going up and down (linear interpolation between samples). */
function crossings(x: ArrayLike<number>, y: ArrayLike<number>, level: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const a = y[i - 1] - level, b = y[i] - level;
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) out.push(x[i - 1] + (x[i] - x[i - 1]) * a / (a - b));
  }
  return out;
}

/** RMS difference of `name` between two runs on the single run's time grid. */
function rmsDiff(a: SimResult, b: SimResult, name: string): number {
  const xa = a.x!.real, ya = vec(a, name), xb = b.x!.real, yb = vec(b, name);
  let s = 0;
  for (let i = 0; i < xa.length; i++) { const d = ya[i] - interpolate(xb, yb, xa[i]); s += d * d; }
  return Math.sqrt(s / xa.length);
}

async function both(p: Project, total: number, chunk: number, step: number) {
  const single = await runSimulation({ ...p, simulation: { ...p.simulation, tran: { stop: String(total), step: String(step) } } }, engine(), "tran");
  const chunked = await simulateChunked(p, engine(), total, chunk, step);
  expect(single.ok, JSON.stringify(single.diagnostics)).toBe(true);
  expect(chunked.ok, JSON.stringify(chunked.diagnostics)).toBe(true);
  return { single, chunked };
}

function rc(src: "vsine" | "vpulse", props: Record<string, string>) {
  const b = new Builder();
  const V = b.place(src, "V1", 0, 10, props);
  const R = b.place("resistor", "R1", 20, 10, { value: "1k" });
  const C = b.place("capacitor", "C1", 40, 10, { value: "100n" });
  const G = b.place("ground", "#PWR1", 60, 10);
  b.label("in", b.pin(V, "1")).label("in", b.pin(R, "1")).label("out", b.pin(R, "2")).label("out", b.pin(C, "1"));
  b.label("gnd", b.pin(C, "2")).label("gnd", b.pin(V, "2")).label("gnd", b.pin(G, "1"));
  return b.project;
}

describe("chunked continuation matches one run", () => {
  it("sends .save all, .ic for every node, ic= on inductors and uic", () => {
    const t = applyInitialState("* x\nV1 a 0 1\nL1 a b 1m ic=5\nC1 b 0 1u ic=2\n.tran 1e-6 1e-3\n.end\n",
      { t: 1, nodes: { a: 1, b: 0.5, "xu1.q": 3 }, inductors: { l1: 0.25 } });
    expect(t).toMatch(/^\.save all$/m);
    expect(t).toMatch(/^L1 a b 1m ic=2\.5e-1$/m);
    expect(t).toMatch(/^C1 b 0 1u$/m);
    expect(t).toMatch(/^\.ic v\(a\)=1e\+0 v\(b\)=5e-1 v\(xu1\.q\)=3e\+0$/m);
    expect(t).toMatch(/^\.tran 1e-6 1e-3 uic$/m);
  });

  it("finds the last real timepoint at or before a time", () => {
    expect(lastIndexAtOrBefore([0, 1, 2, 3], 2.5)).toBe(2);
    expect(lastIndexAtOrBefore([0, 1, 2, 3], 2)).toBe(2);
    expect(lastIndexAtOrBefore([0, 1, 2, 3], 9)).toBe(3);
    expect(lastIndexAtOrBefore([0, 1, 2, 3], -1)).toBe(0);
  });

  it("sine-driven RC low-pass (chunks not a multiple of the period)", async () => {
    const p = rc("vsine", { amplitude: "1", frequency: "1k" });
    const { single, chunked } = await both(p, 5e-3, 0.7e-3, 5e-6);
    expect(rmsDiff(single, chunked, "v(out)")).toBeLessThan(2e-3);
    expect(rmsDiff(single, chunked, "v(in)")).toBeLessThan(2e-3);
  }, 60_000);

  it("pulse-driven RC (chunks start in the middle of pulses)", async () => {
    const p = rc("vpulse", { low: "0", high: "5", frequency: "1k", duty: "30", edge: "1u" });
    const { single, chunked } = await both(p, 5e-3, 0.37e-3, 5e-6);
    const a = crossings(single.x!.real, vec(single, "v(in)"), 2.5), b = crossings(chunked.x!.real, vec(chunked, "v(in)"), 2.5);
    expect(b.length).toBe(a.length);
    a.forEach((t, i) => expect(Math.abs(t - b[i])).toBeLessThan(2e-6));
    expect(rmsDiff(single, chunked, "v(out)")).toBeLessThan(0.02);
  }, 60_000);

  it("LC tank rings smoothly across chunk boundaries (inductor current carried over)", async () => {
    const b = new Builder();
    const V = b.place("vpulse", "V1", 0, 10, { low: "0", high: "1", frequency: "1", duty: "90", edge: "1u", delay: "10u" });
    const R = b.place("resistor", "R1", 20, 10, { value: "2" });
    const L = b.place("inductor", "L1", 40, 10, { value: "1m" });
    const C = b.place("capacitor", "C1", 60, 10, { value: "1u" });
    const G = b.place("ground", "#PWR1", 80, 10);
    b.label("in", b.pin(V, "1")).label("in", b.pin(R, "1")).label("a", b.pin(R, "2")).label("a", b.pin(L, "1"));
    b.label("out", b.pin(L, "2")).label("out", b.pin(C, "1"));
    b.label("gnd", b.pin(C, "2")).label("gnd", b.pin(V, "2")).label("gnd", b.pin(G, "1"));
    const { single, chunked } = await both(b.project, 2e-3, 0.13e-3, 1e-6);
    // ~5 kHz ring, Q ≈ 16: amplitude and phase continue through every boundary
    const peak = Math.max(...vec(single, "v(out)").map(Math.abs));
    expect(peak).toBeGreaterThan(1.5);
    expect(rmsDiff(single, chunked, "v(out)")).toBeLessThan(0.01 * peak);
    const za = crossings(single.x!.real, vec(single, "v(out)"), 1), zb = crossings(chunked.x!.real, vec(chunked, "v(out)"), 1);
    expect(zb.length).toBe(za.length);
    za.forEach((t, i) => expect(Math.abs(t - zb[i])).toBeLessThan(2e-6));
  }, 60_000);

  // Every shipped example with a transient setup (555 astable and monostable, counter, flip-flop, gates, …):
  // the same edges at the same times when cut into 7 chunks.
  for (const e of buildExamples()) {
    const stop = parseSI(e.project.simulation.tran.stop), step = parseSI(e.project.simulation.tran.step);
    if (!(stop > 0) || e.project.simulation.analysis !== "tran") continue;
    it(`example "${e.project.meta.name}" keeps every edge when chunked`, async () => {
      const { single, chunked } = await both(e.project, stop, stop / 7, step);
      for (const v of single.vectors) {
        if (v.kind !== "voltage") continue;
        const y = v.real, lo = Math.min(...y), hi = Math.max(...y);
        if (hi - lo < 0.5) continue;
        const level = (hi + lo) / 2;
        // (a crossing in the last two steps is an artifact of where the run ends, e.g. a sine ending at 0 V)
        const inside = (t: number) => t < stop - 2 * step;
        const a = crossings(single.x!.real, y, level).filter(inside), b = crossings(chunked.x!.real, vec(chunked, v.name), level).filter(inside);
        expect(b.length, `${v.name} crossings`).toBe(a.length);
        // edge times agree within 0.2 % of the run (slow RC ramps cross the midpoint with a few steps' slack)
        a.forEach((t, i) => expect(Math.abs(t - b[i]), `${v.name} edge ${i} at ${t}`).toBeLessThan(stop * 2e-3 + 2 * step));
      }
    }, 120_000);
  }
});

describe("restart from a real timepoint", () => {
  it("state is read at a sample of the run, never interpolated", async () => {
    const p = rc("vpulse", { low: "0", high: "5", frequency: "1k", duty: "50", edge: "1u" });
    const r = await runSimulation({ ...p, simulation: { ...p.simulation, tran: { stop: "3m", step: "5u" } } }, engine(), "tran");
    const x = r.x!.real;
    const k = lastIndexAtOrBefore(x, 1.2345e-3);
    const s = stateAt(r, k);
    expect(s.t).toBe(x[k]);
    expect(s.t).toBeLessThanOrEqual(1.2345e-3);
    expect(s.nodes.out).toBe(vec(r, "v(out)")[k]);
  }, 60_000);
});
