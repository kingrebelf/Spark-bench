// Every example project is current with its generator, loads cleanly, is wired without
// accidental joins, and simulates with the behavior its description promises.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { engine } from "./helpers";
import { at, crossings, errorsOf, opValue, vec } from "./libraryFixtures";
import "../src/library";
import { buildExamples, exampleText } from "../src/library/examples";
import { partTypes, getPart } from "../src/core/library";
import { parseProject } from "../src/core/project";
import { simulate } from "../src/core/simulate";
import { pinWorldPosition, onSegment } from "../src/core/geometry";
import type { AnalysisKind, Project, SimResult } from "../src/core/types";

const examples = buildExamples();
const load = (file: string): Project => {
  const { project, diagnostics } = parseProject(readFileSync(join(__dirname, "..", "examples", `${file}.sbproj`), "utf8"), partTypes());
  expect(diagnostics).toEqual([]);
  return project!;
};
const sim = async (p: Project, analysis: AnalysisKind = p.simulation.analysis) => {
  const r = await simulate(p, engine(), analysis);
  const errs = errorsOf(r);
  if (errs.length) throw new Error(`${errs.join("\n")}\n${r.netlist}`);
  expect(r.ok).toBe(true);
  return r;
};
const mag = (r: SimResult, net: string, f: number) => {
  const fs = r.x!.real, v = vec(r, net);
  const k = fs.reduce((best, x, i) => (Math.abs(Math.log(x / f)) < Math.abs(Math.log(fs[best] / f)) ? i : best), 0);
  return Math.hypot(v.real[k], v.imag![k]);
};
const window = (r: SimResult, net: string, t0: number, t1: number) =>
  vec(r, net).real.filter((_, i) => r.x!.real[i] >= t0 && r.x!.real[i] <= t1);

describe("example files", () => {
  it("covers the documented set", () => {
    expect(examples.map((e) => e.file)).toEqual([
      "resistor-divider", "rc-charging", "rc-lowpass-bode", "led-resistor", "half-wave-rectifier", "bjt-common-emitter",
      "opamp-inverting", "555-astable-blinker", "555-monostable", "logic-gates", "counter-4bit",
    ]);
  });
  for (const e of examples) {
    it(`${e.file}.sbproj is up to date (run: npx tsx examples/build.ts)`, () => {
      expect(readFileSync(join(__dirname, "..", "examples", `${e.file}.sbproj`), "utf8").replace(/\r\n/g, "\n")).toBe(exampleText(e));
    });
    it(`${e.file}: no pin sits in the middle of a wire (accidental join)`, () => {
      const p = load(e.file);
      for (const c of p.schematic.components) {
        for (const pin of getPart(c.type)!.pins) {
          const pt = pinWorldPosition(c, getPart(c.type)!, pin.id)!;
          for (const w of p.schematic.wires) {
            for (let i = 1; i < w.points.length; i++) {
              const a = w.points[i - 1], b = w.points[i];
              const endpoint = (a.x === pt.x && a.y === pt.y) || (b.x === pt.x && b.y === pt.y);
              expect(!endpoint && onSegment(pt, a, b), `${c.ref}.${pin.id} lies inside wire ${w.id}`).toBe(false);
            }
          }
        }
      }
    });
  }
});

describe("examples simulate as documented", () => {
  it("resistor divider: 3 V", async () => {
    expect(opValue(await sim(load("resistor-divider")), "out")).toBeCloseTo(3, 6);
  }, 60_000);

  it("RC charging: 63 % at τ, full at 5τ, discharge", async () => {
    const r = await sim(load("rc-charging"));
    expect(at(r, "vc", 1e-3) / 5).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(at(r, "vc", 5e-3)).toBeGreaterThan(4.95);
    expect(at(r, "vc", 6e-3)).toBeCloseTo(5 * Math.exp(-1), 1);
  }, 60_000);

  it("RC low-pass: −3 dB at 1 kHz, −20 dB at 10 kHz", async () => {
    const r = await sim(load("rc-lowpass-bode"));
    expect(mag(r, "out", 1e3)).toBeCloseTo(Math.SQRT1_2, 1);
    expect(mag(r, "out", 1e4)).toBeCloseTo(0.1, 2);
    expect(mag(r, "out", 10)).toBeGreaterThan(0.999);
  }, 60_000);

  it("LED + resistor: Vf 1.7-2.1 V, ≈ 9.4 mA", async () => {
    const p = load("led-resistor");
    const r = await sim(p);
    const vf = opValue(r, "a");
    expect(vf).toBeGreaterThan(1.7); expect(vf).toBeLessThan(2.1);
    const led = p.schematic.components.find((c) => c.type === "led")!;
    const i = r.vectors.find((v) => v.kind === "current" && v.componentId === led.id);
    expect(((5 - vf) / 330) * 1e3).toBeGreaterThan(8.5);
    if (i) expect(Math.abs(i.real[0])).toBeCloseTo((5 - vf) / 330, 4);
  }, 60_000);

  it("half-wave rectifier: peak ≈ 9.2 V, ripple ≈ 1.8 V", async () => {
    const r = await sim(load("half-wave-rectifier"));
    const late = window(r, "out", 60e-3, 100e-3);
    expect(Math.max(...late)).toBeGreaterThan(9.0); expect(Math.max(...late)).toBeLessThan(9.5);
    const ripple = Math.max(...late) - Math.min(...late);
    expect(ripple).toBeGreaterThan(1.3); expect(ripple).toBeLessThan(2.3);
  }, 60_000);

  it("BJT common-emitter: inverted, gain ≈ 4.3", async () => {
    const p = load("bjt-common-emitter");
    const r = await sim(p);
    const out = window(r, "out", 3e-3, 5e-3);
    const amp = (Math.max(...out) - Math.min(...out)) / 2;
    expect(amp / 0.02).toBeGreaterThan(3.8); expect(amp / 0.02).toBeLessThan(4.8);
    // Inverting: output minimum near the input maximum (t = 3.25 ms).
    expect(at(r, "out", 3.25e-3)).toBeLessThan(0);
    const ac = await sim(p, "ac");
    expect(mag(ac, "out", 10e3)).toBeGreaterThan(3.8); expect(mag(ac, "out", 10e3)).toBeLessThan(4.8);
    const dc = await sim(p, "op");
    expect(opValue(dc, "c")).toBeGreaterThan(4); expect(opValue(dc, "c")).toBeLessThan(7);
  }, 60_000);

  it("op-amp inverting: −10 × input", async () => {
    const p = load("opamp-inverting");
    const r = await sim(p);
    // Within 0.1 V everywhere: the closed-loop bandwidth (≈ 90 kHz) delays the output ≈ 1.8 µs,
    // which is ≈ 55 mV at the 31 V/ms zero crossing.
    for (const t of [2.25e-3, 2.5e-3, 2.75e-3]) expect(Math.abs(at(r, "out", t) + 10 * at(r, "in", t))).toBeLessThan(0.1);
    const out = window(r, "out", 1e-3, 3e-3);
    expect(Math.abs(Math.max(...out) / 5 - 1)).toBeLessThan(0.01);
    const ac = await sim(p, "ac");
    expect(mag(ac, "out", 1e3)).toBeCloseTo(10, 1);
  }, 60_000);

  it("555 astable: ≈ 0.99 Hz, duty ≈ 54 %", async () => {
    const r = await sim(load("555-astable-blinker"));
    const rise = crossings(r, "out", 3.5, "rise"), fall = crossings(r, "out", 3.5, "fall");
    const f = 1.44 / ((10e3 + 2 * 68e3) * 10e-6);
    const per = (rise[rise.length - 1] - rise[1]) / (rise.length - 2);
    expect(Math.abs(1 / per / f - 1)).toBeLessThan(0.1);
    const t0 = rise[1], t1 = fall.find((t) => t > t0)!;
    expect(Math.abs((t1 - t0) / per - 78 / 146)).toBeLessThan(0.05);
    const cap = window(r, "cap", 2, 5);
    expect(Math.max(...cap)).toBeCloseTo(6, 0); expect(Math.min(...cap)).toBeCloseTo(3, 0);
  }, 120_000);

  it("555 monostable: one ≈ 1.1 s pulse after the trigger", async () => {
    const r = await sim(load("555-monostable"));
    expect(at(r, "out", 5e-3)).toBeLessThan(0.1);
    const up = crossings(r, "out", 3.5, "rise"), down = crossings(r, "out", 3.5, "fall");
    expect(up.length).toBe(1);
    expect(up[0]).toBeGreaterThan(10e-3); expect(up[0]).toBeLessThan(11e-3);
    expect(Math.abs((down[0] - up[0]) / 1.1 - 1)).toBeLessThan(0.05);
  }, 120_000);

  it("logic gates: truth tables over time", async () => {
    const r = await sim(load("logic-gates"));
    // A = 1 kHz (high first 0.5 ms of each ms), B = 500 Hz (high first 1 ms of each 2 ms).
    for (const t of [0.25e-3, 0.75e-3, 1.25e-3, 1.75e-3, 2.25e-3, 2.75e-3, 3.25e-3, 3.75e-3]) {
      const a = at(r, "A", t) > 2.5, b = at(r, "B", t) > 2.5;
      expect(at(r, "and", t) > 2.5, `AND @${t}`).toBe(a && b);
      expect(at(r, "or", t) > 2.5, `OR @${t}`).toBe(a || b);
      expect(at(r, "xor", t) > 2.5, `XOR @${t}`).toBe(a !== b);
    }
  }, 60_000);

  it("4-bit counter: counts in binary and wraps after 15", async () => {
    const r = await sim(load("counter-4bit"));
    const value = (t: number) => ["q0", "q1", "q2", "q3"].reduce((acc, q, i) => acc + (at(r, q, t) > 2.5 ? 1 << i : 0), 0);
    // Clock falls at 0.5 ms + k ms.
    for (let k = 0; k < 19; k++) expect(value(k * 1e-3 + 0.9e-3), `after ${k + 1} edges`).toBe((k + 1) % 16);
  }, 60_000);
});
