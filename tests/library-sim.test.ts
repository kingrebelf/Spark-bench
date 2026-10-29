// Golden simulation tests for library parts, run through real ngspice (WASM).
import { describe, expect, it } from "vitest";
import { engine } from "./helpers";
import { NetBuilder, at, crossings, errorsOf, opValue, vec } from "./libraryFixtures";
import { libraryParts } from "../src/library";
import { simulate } from "../src/core/simulate";
import { LED_COLORS } from "../src/library/semiconductors";
import type { AnalysisKind } from "../src/core/types";

const run = async (b: NetBuilder, analysis: AnalysisKind) => {
  const r = await simulate(b.project, engine(), analysis);
  const errs = errorsOf(r);
  if (errs.length) throw new Error(`${errs.join("\n")}\n--- netlist ---\n${r.netlist}\n--- log ---\n${r.log.join("\n")}`);
  expect(r.ok).toBe(true);
  return r;
};

describe("every simulatable part runs in a minimal circuit", () => {
  const supplyPins = new Set(["VCC", "vp"]);
  const groundPins = new Set(["GND", "vn"]);
  for (const def of libraryParts.filter((d) => d.spice && !d.role)) {
    for (const analysis of ["op", "tran", "ac"] as AnalysisKind[]) {
      if (def.analyses?.[analysis] === false) continue;
      it(`${def.id} (${analysis})`, async () => {
        // Supply pins to +5 V, ground pins to GND, every other pin through 10 kΩ to GND.
        const b = new NetBuilder();
        b.v("VS", "VCC", "GND", 5);
        b.r("RS", "VCC", "GND", "10k");
        const nets: Record<string, string> = {};
        def.pins.forEach((p, i) => {
          if (supplyPins.has(p.id)) nets[p.id] = "VCC";
          else if (groundPins.has(p.id)) nets[p.id] = "GND";
          else { nets[p.id] = `n${i}`; b.r(`RL${i}`, `n${i}`, "GND", "10k"); }
        });
        b.add(def.id, "U1", nets);
        b.project.simulation.tran = { stop: "20u", step: "100n" };
        b.project.simulation.ac = { sweep: "dec", points: 5, start: "10", stop: "1MEG" };
        await run(b, analysis);
      }, 60_000);
    }
  }
});

describe("passives and sources", () => {
  it("potentiometer divides by wiper position", async () => {
    const b = new NetBuilder();
    b.v("V1", "top", "GND", 10);
    b.add("potentiometer", "RV1", { 1: "top", 2: "w", 3: "GND" }, { value: "10k", position: "25" });
    b.r("RL", "w", "GND", "1G");
    expect(opValue(await run(b, "op"), "w")).toBeCloseTo(2.5, 3);
  }, 60_000);

  it("closed switch conducts, open switch does not", async () => {
    for (const closed of [true, false]) {
      const b = new NetBuilder();
      b.v("V1", "a", "GND", 5);
      b.add("switch_spst", "SW1", { 1: "a", 2: "out" }, { closed });
      b.r("R1", "out", "GND", "1k");
      const v = opValue(await run(b, "op"), "out");
      if (closed) expect(v).toBeGreaterThan(4.99); else expect(v).toBeLessThan(1e-4);
    }
  }, 60_000);

  it("transformer scales voltage by the turns ratio", async () => {
    const b = new NetBuilder();
    b.add("vsine", "V1", { 1: "p", 2: "GND" }, { amplitude: "10", frequency: "1k" });
    b.add("transformer", "T1", { P1: "p", P2: "GND", S1: "s", S2: "GND" }, { ratio: "0.5", lp: "1", k: "0.9999" });
    b.r("RL", "s", "GND", "100k");
    b.project.simulation.tran = { stop: "5m", step: "5u" };
    const r = await run(b, "tran");
    const s = vec(r, "s").real.slice(Math.floor(vec(r, "s").real.length / 2));
    expect(Math.max(...s)).toBeCloseTo(5, 1);
  }, 60_000);

  it("battery sags across its internal resistance; ammeter and voltmeter read correctly", async () => {
    const b = new NetBuilder();
    b.add("battery", "BT1", { 1: "plus", 2: "GND" }, { value: "9", rint: "1" });
    const am = b.add("ammeter", "AM1", { 1: "plus", 2: "load" });
    b.r("RL", "load", "GND", "89");
    b.add("voltmeter", "VM1", { 1: "load", 2: "GND" });
    const r = await run(b, "op");
    expect(opValue(r, "load")).toBeCloseTo(9 * 89 / 90, 2); // 10 MΩ meter barely loads 89 Ω
    const i = r.vectors.find((v) => v.kind === "current" && v.componentId === am.id)!;
    expect(i.real[0]).toBeCloseTo(0.1, 3);
    expect(r.vectors.find((v) => v.name.toLowerCase() === "v(vm_vm1)")!.real[0]).toBeCloseTo(9 * 89 / 90, 2);
  }, 60_000);

  it("triangle source ramps linearly", async () => {
    const b = new NetBuilder();
    b.add("vtriangle", "V1", { 1: "t", 2: "GND" }, { low: "0", high: "4", frequency: "1k", symmetry: "50" });
    b.r("R1", "t", "GND", "1k");
    b.project.simulation.tran = { stop: "1m", step: "1u" };
    const r = await run(b, "tran");
    expect(at(r, "t", 0.25e-3)).toBeCloseTo(2, 1);
    expect(at(r, "t", 0.5e-3)).toBeCloseTo(4, 1);
    expect(at(r, "t", 0.75e-3)).toBeCloseTo(2, 1);
  }, 60_000);

  it("DC current source pushes current out of its bottom pin", async () => {
    const b = new NetBuilder();
    b.add("idc", "I1", { 1: "GND", 2: "x" }, { value: "1m" });
    b.r("R1", "x", "GND", "1k");
    expect(opValue(await run(b, "op"), "x")).toBeCloseTo(1, 4);
  }, 60_000);
});

describe("semiconductors", () => {
  it("LED + 330 Ω from 5 V: red Vf in 1.7-2.1 V", async () => {
    const b = new NetBuilder();
    b.v("V1", "vcc", "GND", 5);
    b.r("R1", "vcc", "a", "330");
    b.add("led", "D1", { A: "a", K: "GND" }, { color: "red" });
    const vf = opValue(await run(b, "op"), "a");
    expect(vf).toBeGreaterThan(1.7);
    expect(vf).toBeLessThan(2.1);
  }, 60_000);

  it("every LED color hits its preset Vf at 20 mA", async () => {
    for (const [color, vfExpected] of Object.entries(LED_COLORS)) {
      const b = new NetBuilder();
      b.add("idc", "I1", { 1: "GND", 2: "a" }, { value: "20m" });
      b.add("led", "D1", { A: "a", K: "GND" }, { color });
      expect(opValue(await run(b, "op"), "a"), color).toBeCloseTo(vfExpected, 2);
    }
  }, 60_000);

  it("diodes conduct forward, block reverse", async () => {
    for (const type of ["diode", "diode_rectifier", "schottky"]) {
      const b = new NetBuilder();
      b.v("V1", "vcc", "GND", 5);
      b.r("R1", "vcc", "a", "1k");
      b.add(type, "D1", { A: "a", K: "GND" });
      b.r("R2", "vcc", "k", "1k");
      b.add(type, "D2", { A: "GND", K: "k" });
      const r = await run(b, "op");
      const vf = opValue(r, "a");
      expect(vf, type).toBeGreaterThan(type === "schottky" ? 0.1 : 0.5);
      expect(vf, type).toBeLessThan(type === "schottky" ? 0.4 : 0.8);
      expect(opValue(r, "k"), type).toBeGreaterThan(4.9);
    }
  }, 60_000);

  it("Zener regulates near Vz as the input changes", async () => {
    const out: number[] = [];
    for (const vin of [9, 12, 15]) {
      const b = new NetBuilder();
      b.v("V1", "vin", "GND", vin);
      b.r("R1", "vin", "k", "1k");
      b.add("zener", "D1", { K: "k", A: "GND" }, { vz: "5.1" });
      out.push(opValue(await run(b, "op"), "k"));
    }
    for (const v of out) expect(Math.abs(v - 5.1)).toBeLessThan(0.1);
    expect(out[2] - out[0]).toBeLessThan(0.08); // 6 V input change -> < 80 mV output change
  }, 60_000);

  it("BJTs and MOSFETs switch an LED-like load", async () => {
    const cases: { type: string; on: Record<string, string> }[] = [
      { type: "npn", on: { B: "in", C: "c", E: "GND" } }, { type: "2n3904", on: { B: "in", C: "c", E: "GND" } }, { type: "bc547", on: { B: "in", C: "c", E: "GND" } },
      { type: "nmos", on: { G: "in", D: "c", S: "GND" } }, { type: "2n7000", on: { G: "in", D: "c", S: "GND" } },
    ];
    for (const { type, on } of cases) {
      const b = new NetBuilder();
      b.v("V1", "vcc", "GND", 5);
      b.v("V2", "drive", "GND", 5);
      b.r("RB", "drive", "in", type.match(/mos|7000/) ? "100" : "10k");
      b.r("RC", "vcc", "c", "1k");
      b.add(type, "Q1", on);
      expect(opValue(await run(b, "op"), "c"), type).toBeLessThan(0.4);
    }
    for (const type of ["pnp", "2n3906", "bc557", "pmos", "bs250"]) {
      const mos = type.includes("mos") || type === "bs250";
      const b = new NetBuilder();
      b.v("V1", "vcc", "GND", 5);
      b.r("RB", "in", "GND", mos ? "100" : "10k");
      b.r("RC", "c", "GND", "1k");
      b.add(type, "Q1", mos ? { G: "in", S: "vcc", D: "c" } : { B: "in", E: "vcc", C: "c" });
      expect(opValue(await run(b, "op"), "c"), type).toBeGreaterThan(type === "bs250" ? 4.2 : 4.6);
    }
  }, 60_000);

  it("2N3904 common-emitter bias point is plausible", async () => {
    const b = new NetBuilder();
    b.v("V1", "vcc", "GND", 12);
    b.r("R1", "vcc", "b", "47k"); b.r("R2", "b", "GND", "10k");
    b.r("RC", "vcc", "c", "4.7k"); b.r("RE", "e", "GND", "1k");
    b.add("2n3904", "Q1", { B: "b", C: "c", E: "e" });
    const r = await run(b, "op");
    const vbe = opValue(r, "b") - opValue(r, "e");
    expect(vbe).toBeGreaterThan(0.55); expect(vbe).toBeLessThan(0.75);
    expect(opValue(r, "c")).toBeGreaterThan(4); expect(opValue(r, "c")).toBeLessThan(8);
  }, 60_000);
});

describe("analog ICs", () => {
  for (const type of ["opamp", "lm358", "tl072"]) {
    it(`${type}: inverting amplifier gain −10 within 1 %`, async () => {
      const b = new NetBuilder();
      b.v("VP", "vp", "GND", 15); b.v("VN", "GND", "vn", 15);
      b.v("VI", "in", "GND", "0.5");
      b.r("R1", "in", "m", "10k"); b.r("R2", "m", "out", "100k");
      b.add(type, "U1", { inp: "GND", inn: "m", vp: "vp", vn: "vn", out: "out" });
      const v = opValue(await run(b, "op"), "out");
      expect(Math.abs(v / 0.5 + 10)).toBeLessThan(0.1);
    }, 60_000);
  }

  it("op-amp output clips at the rails minus headroom (LM358 high ≈ V+ − 1.5 V)", async () => {
    const b = new NetBuilder();
    b.v("VP", "vp", "GND", 5);
    b.v("VI", "in", "GND", "1");
    b.add("lm358", "U1", { inp: "in", inn: "GND", vp: "vp", vn: "GND", out: "out" });
    b.r("RL", "out", "GND", "10k");
    expect(opValue(await run(b, "op"), "out")).toBeCloseTo(3.5, 1);
  }, 60_000);

  it("op-amp slew rate limits a large step", async () => {
    const b = new NetBuilder();
    b.v("VP", "vp", "GND", 15); b.v("VN", "GND", "vn", 15);
    b.add("vpulse", "VI", { 1: "in", 2: "GND" }, { low: "-5", high: "5", frequency: "10k", duty: "50", edge: "1n" });
    b.add("opamp", "U1", { inp: "in", inn: "out", vp: "vp", vn: "vn", out: "out" }, { sr: "1MEG" });
    b.r("RL", "out", "GND", "10k");
    b.project.simulation.tran = { stop: "60u", step: "50n" };
    const r = await run(b, "tran");
    const up = crossings(r, "out", -4, "rise")[0], top = crossings(r, "out", 4, "rise")[0];
    expect((top - up) * 1e6).toBeGreaterThan(7); // 8 V at 1 V/µs ≈ 8 µs
    expect((top - up) * 1e6).toBeLessThan(9);
  }, 60_000);

  for (const output of ["open-collector", "push-pull"]) {
    it(`comparator (${output}) switches on the input difference`, async () => {
      for (const [p, nn, high] of [[2, 1, true], [1, 2, false]] as const) {
        const b = new NetBuilder();
        b.v("VP", "vp", "GND", 5);
        b.v("VA", "a", "GND", p); b.v("VB", "b", "GND", nn);
        b.add("comparator", "U1", { inp: "a", inn: "b", vp: "vp", vn: "GND", out: "out" }, { output });
        b.r("RP", "vp", "out", "10k");
        const v = opValue(await run(b, "op"), "out");
        if (high) expect(v).toBeGreaterThan(4.9); else expect(v).toBeLessThan(0.1);
      }
    }, 60_000);
  }
});

describe("digital (behavioral)", () => {
  const truth: Record<string, (a: boolean, b: boolean) => boolean> = {
    gate_and: (a, b) => a && b, gate_nand: (a, b) => !(a && b), gate_or: (a, b) => a || b,
    gate_nor: (a, b) => !(a || b), gate_xor: (a, b) => a !== b,
  };
  for (const [type, fn] of Object.entries(truth)) {
    it(`${type} truth table`, async () => {
      for (const a of [false, true]) for (const bIn of [false, true]) {
        const b = new NetBuilder();
        b.v("VS", "vcc", "GND", 5);
        b.v("VA", "a", "GND", a ? 5 : 0); b.v("VB", "b", "GND", bIn ? 5 : 0);
        b.add(type, "U1", { A: "a", B: "b", Y: "y", VCC: "vcc", GND: "GND" });
        b.r("RL", "y", "GND", "10k");
        const y = opValue(await run(b, "op"), "y");
        if (fn(a, bIn)) expect(y, `${a},${bIn}`).toBeGreaterThan(4.9); else expect(y, `${a},${bIn}`).toBeLessThan(0.1);
      }
    }, 60_000);
  }

  it("NOT gate inverts at 3.3 V supply, with the set propagation delay", async () => {
    const b = new NetBuilder();
    b.v("VS", "vcc", "GND", 3.3);
    b.add("vpulse", "VA", { 1: "a", 2: "GND" }, { low: "0", high: "3.3", frequency: "1MEG", duty: "50", edge: "1n" });
    b.add("gate_not", "U1", { A: "a", Y: "y", VCC: "vcc", GND: "GND" }, { td: "20n" });
    b.r("RL", "y", "GND", "10k");
    b.project.simulation.tran = { stop: "3u", step: "1n" };
    const r = await run(b, "tran");
    const inRise = crossings(r, "a", 1.65, "rise")[1], outFall = crossings(r, "y", 1.65 * 10 / 10.05, "fall").find((t) => t > inRise)!;
    expect((outFall - inRise) * 1e9).toBeGreaterThan(15);
    expect((outFall - inRise) * 1e9).toBeLessThan(25);
    expect(at(r, "y", 0.25e-6)).toBeLessThan(0.1);
    expect(at(r, "y", 0.75e-6)).toBeGreaterThan(3.2);
  }, 60_000);

  it("D flip-flop with D = ~Q toggles on each rising clock edge", async () => {
    const b = new NetBuilder();
    b.v("VS", "vcc", "GND", 5);
    b.add("vpulse", "VC", { 1: "clk", 2: "GND" }, { low: "0", high: "5", frequency: "100k", duty: "50", edge: "10n", delay: "2u" });
    b.add("dff", "U1", { D: "qn", C: "clk", Q: "q", QN: "qn", PRE: "vcc", CLR: "vcc", VCC: "vcc", GND: "GND" });
    b.r("RL", "q", "GND", "10k");
    b.project.simulation.tran = { stop: "100u", step: "50n" };
    const r = await run(b, "tran");
    const clk = crossings(r, "clk", 2.5, "rise"), q = crossings(r, "q", 2.5, "rise"), qf = crossings(r, "q", 2.5, "fall");
    expect(at(r, "q", 1e-6)).toBeLessThan(0.1); // starts at 0
    expect(q.length + qf.length).toBe(clk.length); // one Q transition per rising edge
    for (const t of q) expect(clk.some((c) => t - c > 0 && t - c < 100e-9)).toBe(true);
  }, 60_000);

  it("D flip-flop: ~CLR forces Q low, ~PRE forces Q high", async () => {
    for (const [pre, clr, expectHigh] of [[0, 5, true], [5, 0, false]] as const) {
      const b = new NetBuilder();
      b.v("VS", "vcc", "GND", 5);
      b.v("VP", "pre", "GND", pre); b.v("VR", "clr", "GND", clr); b.v("VD", "d", "GND", expectHigh ? 0 : 5);
      b.add("dff", "U1", { D: "d", C: "GND", Q: "q", QN: "qn", PRE: "pre", CLR: "clr", VCC: "vcc", GND: "GND" });
      b.r("RL", "q", "GND", "10k"); b.r("RL2", "qn", "GND", "10k");
      const r = await run(b, "op");
      if (expectHigh) expect(opValue(r, "q")).toBeGreaterThan(4.9); else expect(opValue(r, "q")).toBeLessThan(0.1);
      expect(opValue(r, "qn") > 2.5).toBe(!expectHigh);
    }
  }, 60_000);

  it("JK flip-flop with J = K = 1 divides the clock by two (falling edges)", async () => {
    const b = new NetBuilder();
    b.v("VS", "vcc", "GND", 5);
    b.add("vpulse", "VC", { 1: "clk", 2: "GND" }, { low: "0", high: "5", frequency: "100k", duty: "50", edge: "10n", delay: "2u" });
    b.add("jkff", "U1", { J: "vcc", K: "vcc", C: "clk", Q: "q", QN: "qn", R: "vcc", VCC: "vcc", GND: "GND" });
    b.r("RL", "q", "GND", "10k"); b.r("RL2", "qn", "GND", "10k");
    b.project.simulation.tran = { stop: "100u", step: "50n" };
    const r = await run(b, "tran");
    const fall = crossings(r, "clk", 2.5, "fall");
    const qt = [...crossings(r, "q", 2.5, "rise"), ...crossings(r, "q", 2.5, "fall")].sort((x, y) => x - y);
    expect(qt.length).toBe(fall.length);
    qt.forEach((t, i) => expect(t - fall[i]).toBeGreaterThan(0));
    qt.forEach((t, i) => expect(t - fall[i]).toBeLessThan(100e-9));
  }, 60_000);

  it("JK flip-flop: J=1,K=0 sets and J=0,K=1 resets", async () => {
    for (const [j, k, high] of [[5, 0, true], [0, 5, false]] as const) {
      const b = new NetBuilder();
      b.v("VS", "vcc", "GND", 5);
      b.v("VJ", "j", "GND", j); b.v("VK", "k", "GND", k);
      b.add("vpulse", "VC", { 1: "clk", 2: "GND" }, { low: "0", high: "5", frequency: "100k", duty: "50", edge: "10n" });
      b.add("jkff", "U1", { J: "j", K: "k", C: "clk", Q: "q", QN: "qn", R: "vcc", VCC: "vcc", GND: "GND" });
      b.r("RL", "q", "GND", "10k"); b.r("RL2", "qn", "GND", "10k");
      b.project.simulation.tran = { stop: "40u", step: "50n" };
      const r = await run(b, "tran");
      const v = at(r, "q", 38e-6);
      if (high) expect(v).toBeGreaterThan(4.9); else expect(v).toBeLessThan(0.1);
    }
  }, 60_000);

  it("4-bit counter counts 0..15 and wraps", async () => {
    const b = new NetBuilder();
    b.v("VS", "vcc", "GND", 5);
    // Clock falls at 5 µs + k·10 µs.
    b.add("vpulse", "VC", { 1: "clk", 2: "GND" }, { low: "0", high: "5", frequency: "100k", duty: "50", edge: "10n" });
    b.add("counter4", "U1", { CP0: "clk", CP1: "q0", R1: "GND", R2: "GND", Q0: "q0", Q1: "q1", Q2: "q2", Q3: "q3", VCC: "vcc", GND: "GND" });
    for (const q of ["q1", "q2", "q3"]) b.r(`RL${q}`, q, "GND", "10k");
    b.project.simulation.tran = { stop: "200u", step: "50n" };
    const r = await run(b, "tran");
    const value = (t: number) => ["q0", "q1", "q2", "q3"].reduce((acc, q, i) => acc + (at(r, q, t) > 2.5 ? 1 << i : 0), 0);
    for (let k = 0; k < 19; k++) expect(value(k * 10e-6 + 9e-6), `after ${k + 1} falling edges`).toBe((k + 1) % 16);
  }, 60_000);

  it("4-bit counter resets when R0(1) and R0(2) are high", async () => {
    const b = new NetBuilder();
    b.v("VS", "vcc", "GND", 5);
    b.add("vpulse", "VC", { 1: "clk", 2: "GND" }, { low: "0", high: "5", frequency: "100k", duty: "50", edge: "10n" });
    b.add("vpulse", "VR", { 1: "rst", 2: "GND" }, { low: "0", high: "5", frequency: "10k", duty: "10", edge: "10n", delay: "52u" });
    b.add("counter4", "U1", { CP0: "clk", CP1: "q0", R1: "rst", R2: "vcc", Q0: "q0", Q1: "q1", Q2: "q2", Q3: "q3", VCC: "vcc", GND: "GND" });
    for (const q of ["q1", "q2", "q3"]) b.r(`RL${q}`, q, "GND", "10k");
    b.project.simulation.tran = { stop: "80u", step: "50n" };
    const r = await run(b, "tran");
    expect(at(r, "q2", 49e-6)).toBeGreaterThan(2.5); // count 5 = 0101
    for (const q of ["q0", "q1", "q2", "q3"]) expect(at(r, q, 58e-6), q).toBeLessThan(0.1);
  }, 60_000);
});

describe("555 timer", () => {
  const astable = (r1: string, r2: string, c: string) => {
    const b = new NetBuilder();
    b.v("VS", "vcc", "GND", 9);
    b.r("R1", "vcc", "dis", r1); b.r("R2", "dis", "th", r2); b.c("C1", "th", "GND", c);
    b.add("timer555", "U1", { GND: "GND", TRIG: "th", OUT: "out", RST: "vcc", THR: "th", DIS: "dis", VCC: "vcc" });
    b.r("RL", "out", "GND", "1k");
    return b;
  };
  for (const [r1, r2, c] of [["1k", "10k", "10n"], ["10k", "47k", "100n"]]) {
    it(`astable f ≈ 1.44/((R1+2R2)C) within 3 %, duty ≈ (R1+R2)/(R1+2R2) ± 2 points (R1=${r1}, R2=${r2}, C=${c})`, async () => {
      const R1 = Number(r1.replace("k", "e3")), R2 = Number(r2.replace("k", "e3")), C = Number(c.replace("n", "e-9"));
      const f = 1.44 / ((R1 + 2 * R2) * C);
      const b = astable(r1, r2, c);
      b.project.simulation.tran = { stop: String(8 / f), step: String(1 / f / 400) };
      const r = await run(b, "tran");
      const rise = crossings(r, "out", 3.5, "rise"), fall = crossings(r, "out", 3.5, "fall");
      if (rise.length < 4) throw new Error(`only ${rise.length} rising edges; out max ${Math.max(...vec(r, "out").real)}, th range ${Math.min(...vec(r, "th").real)}..${Math.max(...vec(r, "th").real)}, tstop ${b.project.simulation.tran.stop}`);
      const periods = rise.slice(2).map((t, i) => t - rise[i + 1]);
      const fMeas = 1 / (periods.reduce((a, x) => a + x, 0) / periods.length);
      expect(Math.abs(fMeas / f - 1)).toBeLessThan(0.03);
      const t0 = rise[2], t1 = fall.find((t) => t > t0)!;
      const duty = (t1 - t0) * fMeas;
      expect(Math.abs(duty - (R1 + R2) / (R1 + 2 * R2))).toBeLessThan(0.02);
      // Capacitor swings between VCC/3 and 2VCC/3.
      const th = vec(r, "th").real.slice(Math.floor(vec(r, "th").real.length / 2));
      expect(Math.max(...th)).toBeCloseTo(6, 0);
      expect(Math.min(...th)).toBeCloseTo(3, 0);
    }, 120_000);
  }

  it("monostable pulse ≈ 1.1·R·C", async () => {
    const b = new NetBuilder();
    b.v("VS", "vcc", "GND", 5);
    b.add("vpulse", "VT", { 1: "trig", 2: "GND" }, { low: "5", high: "0", frequency: "50", duty: "1", edge: "1u", delay: "1m" });
    b.r("R1", "vcc", "th", "10k"); b.c("C1", "th", "GND", "100n");
    b.add("timer555", "U1", { GND: "GND", TRIG: "trig", OUT: "out", RST: "vcc", THR: "th", DIS: "th", VCC: "vcc" });
    b.r("RL", "out", "GND", "1k");
    b.project.simulation.tran = { stop: "5m", step: "2u" };
    const r = await run(b, "tran");
    const up = crossings(r, "out", 1.6, "rise")[0], down = crossings(r, "out", 1.6, "fall").find((t) => t > up)!;
    expect(Math.abs((down - up) / (1.1 * 10e3 * 100e-9) - 1)).toBeLessThan(0.02);
    expect(at(r, "out", 0.5e-3)).toBeLessThan(0.1); // idle low before the trigger
  }, 60_000);

  it("~RESET low holds the output low", async () => {
    const b = astable("1k", "10k", "10n");
    const rst = b.project.schematic.labels.find((l) => l.name === "vcc" && b.project.schematic.components.some((c) => c.type === "timer555" && b.pin(c, "RST").x === l.position.x && b.pin(c, "RST").y === l.position.y))!;
    rst.name = "GND";
    b.project.simulation.tran = { stop: "1m", step: "1u" };
    const r = await run(b, "tran");
    expect(Math.max(...vec(r, "out").real)).toBeLessThan(0.1);
  }, 60_000);
});
