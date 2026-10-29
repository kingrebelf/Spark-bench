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
import { runSimulation } from "../src/sim/run";
import { toPwl } from "../src/sim/live";
import { detectFailure } from "../src/sim/stress";
import type { AnalysisKind, Project, PropValue, SimResult } from "../src/core/types";

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
      "led-switch", "pot-dimmer", "555-adjustable-blinker",
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
    expect(Math.abs(1 / per / f - 1)).toBeLessThan(0.03);
    const t0 = rise[1], t1 = fall.find((t) => t > t0)!;
    expect(Math.abs((t1 - t0) / per - 78 / 146)).toBeLessThan(0.02);
    const cap = window(r, "cap", 2, 5);
    expect(Math.max(...cap)).toBeCloseTo(6, 0); expect(Math.min(...cap)).toBeCloseTo(3, 0);
  }, 120_000);

  // The latch must flip at every threshold crossing whatever the step: a regenerative latch with a
  // ns time constant used to settle half-set (cap stuck at 6.00 V) after 2.57 s at 1 ms / 100 µs steps.
  for (const step of ["1m", "200u", "100u"]) {
    it(`555 astable keeps oscillating for 20 s at max step ${step}`, async () => {
      const p = load("555-astable-blinker");
      p.simulation.tran = { ...p.simulation.tran, stop: "20", step };
      const r = await sim(p);
      const rise = crossings(r, "out", 3.5, "rise");
      expect(rise.length).toBeGreaterThanOrEqual(19);
      expect(rise[rise.length - 1]).toBeGreaterThan(19);
      const per = (rise[rise.length - 1] - rise[1]) / (rise.length - 2);
      expect(Math.abs(per * 1.44 / ((10e3 + 2 * 68e3) * 10e-6) - 1)).toBeLessThan(0.03);
    }, 120_000);
  }

  it("555 monostable: one ≈ 1.1 s pulse after the trigger", async () => {
    const r = await sim(load("555-monostable"));
    expect(at(r, "out", 5e-3)).toBeLessThan(0.1);
    const up = crossings(r, "out", 3.5, "rise"), down = crossings(r, "out", 3.5, "fall");
    expect(up.length).toBe(1);
    expect(up[0]).toBeGreaterThan(10e-3); expect(up[0]).toBeLessThan(11e-3);
    expect(Math.abs((down[0] - up[0]) / 1.1 - 1)).toBeLessThan(0.02);
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

// Interactive examples: the saved state, the other extreme of each control, and a live change (the
// sim layer's PWL schedule, as when the user clicks or drags during a run). None may trip the damage rules.
describe("interactive examples", () => {
  const withProp = (p: Project, ref: string, key: string, value: PropValue) => {
    const q = structuredClone(p);
    q.schematic.components.find((c) => c.ref === ref)!.props[key] = value;
    return q;
  };
  const ledCurrent = (p: Project, r: SimResult, t: number) => {
    const led = p.schematic.components.find((c) => c.type === "led")!;
    const v = r.vectors.find((x) => x.kind === "current" && x.componentId === led.id)!;
    const k = r.x!.real.findIndex((x) => x >= t);
    return Math.abs(v.real[k]);
  };
  const live = async (p: Project, ref: string, initial: number, changes: [number, number][]) => {
    const c = p.schematic.components.find((x) => x.ref === ref)!;
    const r = await runSimulation(p, engine(), "tran", { schedules: new Map([[c.id, toPwl(initial, changes, 1e-6)]]) });
    expect(r.ok).toBe(true);
    return r;
  };
  // runSimulation (the sim layer) also saves the probed branch currents.
  const run = async (p: Project) => { const r = await runSimulation(p, engine(), "tran"); expect(r.ok).toBe(true); return r; };
  const noDamage = (p: Project, r: SimResult) => expect(detectFailure(p, r, {})?.damage.message).toBeUndefined();

  it("LED with switch: off as saved, ≈ 15 mA when closed, follows a live click", async () => {
    const p = load("led-switch");
    p.simulation.tran = { stop: "1", step: "1m" };
    expect(ledCurrent(p, await run(p), 0.5)).toBeLessThan(1e-6);
    const on = withProp(p, "SW1", "closed", true);
    const r = await run(on);
    expect(ledCurrent(on, r, 0.5) * 1e3).toBeGreaterThan(14); expect(ledCurrent(on, r, 0.5) * 1e3).toBeLessThan(16.5);
    noDamage(on, r);
    const l = await live(p, "SW1", 0, [[0.3, 1], [0.6, 0]]);
    expect(ledCurrent(p, l, 0.2)).toBeLessThan(1e-6);
    expect(ledCurrent(p, l, 0.45)).toBeGreaterThan(14e-3);
    expect(ledCurrent(p, l, 0.8)).toBeLessThan(1e-6);
    noDamage(p, l);
  }, 60_000);

  it("pot dimmer: ≈ 6 mA at 50 %, ≈ 19 mA at the top, off at the bottom, follows a live drag", async () => {
    const p = load("pot-dimmer");
    p.simulation.tran = { stop: "1", step: "1m" };
    const mid = ledCurrent(p, await run(p), 0.5) * 1e3;
    expect(mid).toBeGreaterThan(5); expect(mid).toBeLessThan(7);
    const top = withProp(p, "RV1", "position", "100");
    const rt = await run(top);
    expect(ledCurrent(top, rt, 0.5) * 1e3).toBeGreaterThan(17); expect(ledCurrent(top, rt, 0.5) * 1e3).toBeLessThan(21);
    noDamage(top, rt);
    const bottom = withProp(p, "RV1", "position", "0");
    expect(ledCurrent(bottom, await run(bottom), 0.5)).toBeLessThan(1e-5);
    const l = await live(p, "RV1", 50, [[0.3, 100], [0.6, 0]]);
    expect(ledCurrent(p, l, 0.2) * 1e3).toBeCloseTo(mid, 0);
    expect(ledCurrent(p, l, 0.45) * 1e3).toBeGreaterThan(17);
    expect(ledCurrent(p, l, 0.8)).toBeLessThan(1e-5);
    noDamage(p, l);
  }, 60_000);

  it("555 with speed control: ≈ 1.19 Hz as saved, ≈ 6.9 Hz at the top, ≈ 0.65 Hz at the bottom, speeds up on a live drag", async () => {
    const freq = (r: SimResult, t0: number, t1: number) => {
      const rise = crossings(r, "out", 3.5, "rise").filter((t) => t >= t0 && t <= t1);
      return (rise.length - 1) / (rise[rise.length - 1] - rise[0]);
    };
    const f = (rv: number) => 1.44 / ((1e3 + 2 * (10e3 + rv)) * 10e-6);
    const p = load("555-adjustable-blinker");
    const r = await run(p);
    expect(Math.abs(freq(r, 1.5, 5) / f(50e3) - 1)).toBeLessThan(0.03);
    noDamage(p, r);
    const top = withProp(p, "RV1", "position", "100");
    top.simulation.tran = { stop: "2", step: "1m" };
    const rt = await run(top);
    expect(Math.abs(freq(rt, 0.5, 2) / f(0) - 1)).toBeLessThan(0.03);
    noDamage(top, rt);
    const bottom = withProp(p, "RV1", "position", "0");
    bottom.simulation.tran = { stop: "8", step: "1m" };
    expect(Math.abs(freq(await run(bottom), 2, 8) / f(100e3) - 1)).toBeLessThan(0.03);
    const l = await live(p, "RV1", 50, [[3, 100]]);
    expect(freq(l, 3.5, 5)).toBeGreaterThan(6);
    noDamage(p, l);
  }, 120_000);
});
