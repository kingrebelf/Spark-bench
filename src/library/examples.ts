// Example projects, generated in code so they always match the current library.
// `npx tsx examples/build.ts` writes them to examples/*.sbproj; tests check the files are current
// and that each one simulates with its documented behavior.
import { getPart } from "../core/library";
import { pinWorldPosition } from "../core/geometry";
import { APP_VERSION } from "../core/project";
import type { AnalysisKind, ComponentInstance, Point, Project, PropValue, Rotation, SimConfig } from "../core/types";

const STAMP = "2026-10-28T00:00:00.000Z";
const COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176"];

export interface Example {
  /** File name without extension. */
  file: string;
  project: Project;
  /** What the user should see when they run it (also in meta.description). */
  expected: string;
}

class Sheet {
  project: Project;
  private n = 0;
  private probes = 0;
  constructor(name: string, description: string, analysis: AnalysisKind, sim: Partial<SimConfig> = {}) {
    this.project = {
      format: "sparkbench-project", version: 1,
      meta: { name, created: STAMP, modified: STAMP, appVersion: APP_VERSION, description },
      schematic: { components: [], wires: [], labels: [] },
      simulation: {
        analysis,
        tran: { stop: "10m", step: "10u" },
        ac: { sweep: "dec", points: 20, start: "1", stop: "1MEG" },
        probes: [],
        ...sim,
      },
      models: [],
      kicad: {},
    };
  }
  private id(prefix: string) { return `${prefix}_${(++this.n).toString().padStart(3, "0")}`; }
  part(type: string, ref: string, x: number, y: number, props: Record<string, PropValue> = {}, rotation: Rotation = 0): ComponentInstance {
    if (!getPart(type)) throw new Error(`unknown part ${type}`);
    const c: ComponentInstance = { id: this.id("c"), type, ref, position: { x, y }, rotation, props };
    this.project.schematic.components.push(c);
    return c;
  }
  pin(c: ComponentInstance, pinId: string): Point {
    const p = pinWorldPosition(c, getPart(c.type)!, pinId);
    if (!p) throw new Error(`${c.ref} has no pin ${pinId}`);
    return p;
  }
  wire(...pts: Point[]) {
    this.project.schematic.wires.push({ id: this.id("w"), points: pts });
  }
  label(name: string, at: Point) {
    this.project.schematic.labels.push({ id: this.id("l"), name, position: at, rotation: 0 });
  }
  gnd(at: Point) {
    const g = this.part("ground", `#PWR${(this.project.schematic.components.filter((c) => c.type === "ground").length + 1).toString().padStart(2, "0")}`, at.x, at.y);
    return g;
  }
  probeV(netName: string, label = netName) {
    this.project.simulation.probes.push({ id: this.id("p"), kind: "voltage", target: { netName }, label, color: COLORS[this.probes++ % COLORS.length] });
  }
  probeI(c: ComponentInstance, label: string) {
    this.project.simulation.probes.push({ id: this.id("p"), kind: "current", target: { componentId: c.id }, label, color: COLORS[this.probes++ % COLORS.length] });
  }
}

const P = (x: number, y: number): Point => ({ x, y });

/** Source on the left, series part along the top, shunt part to ground on the right. */
function seriesShunt(s: Sheet, source: [string, Record<string, PropValue>], series: [string, Record<string, PropValue>, Rotation], shunt: [string, Record<string, PropValue>, Rotation], outName: string) {
  const v = s.part(source[0], "V1", 0, 10, source[1]);
  const a = s.part(series[0], series[0] === "resistor" ? "R1" : "D1", 7, 0, series[1], series[2]);
  const b = s.part(shunt[0], shunt[0] === "capacitor" ? "C1" : shunt[0] === "led" ? "D1" : "R2", 14, shunt[0] === "led" ? 4 : 3, shunt[1], shunt[2]);
  const aPins = getPart(a.type)!.pins.map((p) => s.pin(a, p.id)).sort((p, q) => p.x - q.x);
  const bPins = getPart(b.type)!.pins.map((p) => s.pin(b, p.id)).sort((p, q) => p.y - q.y);
  s.wire(s.pin(v, "1"), P(0, 0), aPins[0]);
  s.wire(aPins[1], P(14, 0));
  if (bPins[0].y !== 0) s.wire(P(14, 0), bPins[0]);
  s.label(outName, P(14, 0));
  s.gnd(s.pin(v, "2"));
  s.gnd(bPins[1]);
  return { v, a, b };
}

function divider(): Example {
  const s = new Sheet("Resistor divider", "9 V across 2 kΩ + 1 kΩ. The output is 9 V × 1k / (2k + 1k) = 3 V.", "op");
  const v = s.part("vdc", "V1", 0, 10, { value: "9" });
  const r1 = s.part("resistor", "R1", 10, 3, { value: "2k" });
  const r2 = s.part("resistor", "R2", 10, 13, { value: "1k" });
  s.wire(s.pin(v, "1"), P(0, 0), s.pin(r1, "1"));
  s.wire(s.pin(r1, "2"), s.pin(r2, "1"));
  s.label("out", s.pin(r2, "1"));
  s.gnd(s.pin(v, "2"));
  s.gnd(s.pin(r2, "2"));
  s.probeV("out", "Vout");
  return { file: "resistor-divider", project: s.project, expected: "Operating point: V(out) = 3.000 V; 3 mA flows from V1." };
}

function rcCharging(): Example {
  const s = new Sheet("RC charging", "A 5 V step charges 1 µF through 1 kΩ. τ = RC = 1 ms: after 1 ms the capacitor reaches 63 % (3.16 V), after 5 ms it is essentially full. The source then steps back to 0 V and it discharges.", "tran",
    { tran: { stop: "20m", step: "10u" } });
  seriesShunt(s, ["vpulse", { low: "0", high: "5", frequency: "100", duty: "50", edge: "1u" }], ["resistor", { value: "1k" }, 270], ["capacitor", { value: "1u" }, 0], "vc");
  s.probeV("vc", "Vc");
  return { file: "rc-charging", project: s.project, expected: "V(vc) ≈ 3.16 V at t = 1 ms and ≈ 4.97 V at 5 ms; falls to 1.84 V at 6 ms." };
}

function rcLowpass(): Example {
  const s = new Sheet("RC low-pass (Bode)", "First-order low-pass: R = 1.59 kΩ, C = 100 nF, corner frequency fc = 1/(2πRC) ≈ 1 kHz. Above fc the output falls 20 dB per decade.", "ac",
    { ac: { sweep: "dec", points: 20, start: "10", stop: "1MEG" } });
  seriesShunt(s, ["vsine", { amplitude: "1", frequency: "1k", acmag: "1" }], ["resistor", { value: "1.59k" }, 270], ["capacitor", { value: "100n" }, 0], "out");
  s.probeV("out", "Vout");
  return { file: "rc-lowpass-bode", project: s.project, expected: "|V(out)| = −3 dB (0.707) at 1 kHz, −20 dB (0.1) at 10 kHz, flat 0 dB below 100 Hz." };
}

function ledResistor(): Example {
  const s = new Sheet("LED with series resistor", "5 V through 330 Ω into a red LED: about 1.9 V across the LED and (5 − 1.9)/330 ≈ 9.4 mA.", "op");
  const { b } = seriesShunt(s, ["vdc", { value: "5" }], ["resistor", { value: "330" }, 270], ["led", { color: "red" }, 270], "a");
  s.probeV("a", "V(LED)");
  s.probeI(b, "I(LED)");
  return { file: "led-resistor", project: s.project, expected: "V(a) between 1.7 and 2.1 V; LED current ≈ 9-10 mA." };
}

function halfWave(): Example {
  const s = new Sheet("Half-wave rectifier with smoothing", "10 V peak, 50 Hz through a 1N4007-like diode into 100 µF and a 1 kΩ load. The capacitor holds the peak (≈ 9.2 V) and sags ≈ 1.8 V between peaks (ripple ≈ I/(f·C)).", "tran",
    { tran: { stop: "100m", step: "20u" } });
  const v = s.part("vsine", "V1", 0, 10, { amplitude: "10", frequency: "50" });
  const d = s.part("diode_rectifier", "D1", 7, 0, {}, 180);
  const c = s.part("capacitor_polarized", "C1", 14, 3, { value: "100u" });
  const r = s.part("resistor", "R1", 20, 3, { value: "1k" });
  s.wire(s.pin(v, "1"), P(0, 0), s.pin(d, "A"));
  s.wire(s.pin(d, "K"), s.pin(c, "1"));
  s.wire(s.pin(c, "1"), s.pin(r, "1"));
  s.label("in", P(0, 0));
  s.label("out", s.pin(r, "1"));
  s.gnd(s.pin(v, "2")); s.gnd(s.pin(c, "2")); s.gnd(s.pin(r, "2"));
  s.probeV("in", "Vin"); s.probeV("out", "Vout");
  return { file: "half-wave-rectifier", project: s.project, expected: "After the first cycles V(out) peaks ≈ 9.1-9.4 V and dips to ≈ 7.3-7.8 V once per 20 ms." };
}

function bjtAmp(): Example {
  const s = new Sheet("BJT common-emitter amplifier", "2N3904-like transistor biased by 47 k/10 k from 12 V, RC = 4.7 kΩ, RE = 1 kΩ (unbypassed). Voltage gain ≈ −RC/RE ≈ −4.3 with the 100 kΩ load. Input 20 mV peak at 1 kHz.", "tran",
    { tran: { stop: "5m", step: "2u" }, ac: { sweep: "dec", points: 20, start: "10", stop: "10MEG" } });
  const vin = s.part("vsine", "V1", 0, 14, { amplitude: "20m", frequency: "1k", acmag: "1" });
  const c1 = s.part("capacitor", "C1", 8, 10, { value: "10u" }, 270);
  const r1 = s.part("resistor", "R1", 12, 4, { value: "47k" });
  const r2 = s.part("resistor", "R2", 12, 14, { value: "10k" });
  const q = s.part("2n3904", "Q1", 20, 10);
  const rc = s.part("resistor", "RC", 22, 1, { value: "4.7k" });
  const re = s.part("resistor", "RE", 22, 18, { value: "1k" });
  const c2 = s.part("capacitor", "C2", 26, 5, { value: "10u" }, 270);
  const rl = s.part("resistor", "RL", 32, 8, { value: "100k" });
  const vcc = s.part("vdc", "V2", -8, 10, { value: "12" });
  s.wire(s.pin(vin, "1"), s.pin(c1, "1"));                // (0,10) -> (5,10)
  s.wire(s.pin(c1, "2"), P(12, 10));
  s.wire(P(12, 10), s.pin(q, "B"));
  s.wire(s.pin(r1, "2"), s.pin(r2, "1"));                 // (12,7) -> (12,11), base node at (12,10)
  s.wire(s.pin(rc, "2"), s.pin(q, "C"));                  // (22,4) -> (22,6)
  s.wire(P(22, 5), s.pin(c2, "1"));                       // collector tap -> C2
  s.wire(s.pin(q, "E"), s.pin(re, "1"));                  // (22,14) -> (22,15)
  s.wire(s.pin(c2, "2"), s.pin(rl, "1"));                 // (29,5) -> (32,5)
  s.label("VCC", s.pin(r1, "1")); s.label("VCC", s.pin(rc, "1")); s.label("VCC", s.pin(vcc, "1"));
  s.label("in", s.pin(vin, "1")); s.label("out", s.pin(rl, "1")); s.label("c", s.pin(q, "C"));
  s.gnd(s.pin(vin, "2")); s.gnd(s.pin(r2, "2")); s.gnd(s.pin(re, "2")); s.gnd(s.pin(rl, "2")); s.gnd(s.pin(vcc, "2"));
  s.probeV("in", "Vin"); s.probeV("out", "Vout");
  return { file: "bjt-common-emitter", project: s.project, expected: "V(out) is an inverted sine of ≈ 85 mV peak (gain ≈ −4.3); the collector sits near 5.7 V. AC analysis: |gain| ≈ 4.3 in the midband." };
}

function opampInverting(): Example {
  const s = new Sheet("Op-amp inverting amplifier", "Gain = −Rf/Rin = −100k/10k = −10. A 0.5 V peak, 1 kHz input gives a 5 V peak inverted output (±12 V supplies).", "tran",
    { tran: { stop: "3m", step: "2u" }, ac: { sweep: "dec", points: 20, start: "10", stop: "10MEG" } });
  const vin = s.part("vsine", "V1", 0, 14, { amplitude: "0.5", frequency: "1k", acmag: "1" });
  const rin = s.part("resistor", "Rin", 8, 10, { value: "10k" }, 270);
  const u = s.part("opamp", "U1", 20, 8);
  const rf = s.part("resistor", "Rf", 20, 18, { value: "100k" }, 270);
  const rl = s.part("resistor", "RL", 32, 11, { value: "10k" });
  const vp = s.part("vdc", "V2", 40, 10, { value: "12" });
  const vn = s.part("vdc", "V3", 46, 10, { value: "12" });
  s.wire(s.pin(vin, "1"), s.pin(rin, "1"));               // (0,10) -> (5,10)
  s.wire(s.pin(rin, "2"), P(12, 10), s.pin(u, "inn"));     // (11,10) -> (14,10)
  s.wire(P(12, 10), P(12, 18), s.pin(rf, "1"));            // to Rf (17,18)
  s.wire(s.pin(rf, "2"), P(28, 18), P(28, 8));             // (23,18) -> (28,8)
  s.wire(s.pin(u, "out"), P(28, 8), s.pin(rl, "1"));       // (26,8) -> (32,8)
  s.wire(s.pin(u, "inp"), P(12, 6));
  s.gnd(P(12, 6));
  s.label("VP", s.pin(u, "vp")); s.label("VN", s.pin(u, "vn"));
  s.label("VP", s.pin(vp, "1")); s.gnd(s.pin(vp, "2"));
  s.label("GND", s.pin(vn, "1")); s.label("VN", s.pin(vn, "2"));
  s.label("in", s.pin(vin, "1")); s.label("out", s.pin(rl, "1"));
  s.gnd(s.pin(vin, "2")); s.gnd(s.pin(rl, "2"));
  s.probeV("in", "Vin"); s.probeV("out", "Vout");
  return { file: "opamp-inverting", project: s.project, expected: "V(out) = −10 × V(in): 5 V peak, inverted. AC: 20 dB gain flat to ≈ 90 kHz (GBW 1 MHz / 11)." };
}

function timer555Core(s: Sheet) {
  const u = s.part("timer555", "U1", 20, 10);
  const vs = s.part("vdc", "V1", -6, 10, { value: "9" });
  s.label("VCC", s.pin(vs, "1")); s.gnd(s.pin(vs, "2"));
  s.label("VCC", s.pin(u, "VCC")); s.label("VCC", s.pin(u, "RST"));
  s.gnd(s.pin(u, "GND"));
  // Output: 470 Ω + LED to ground.
  const r = s.part("resistor", "R3", 32, 10, { value: "470" }, 270);
  const d = s.part("led", "D1", 38, 13, { color: "red" }, 270);
  s.wire(s.pin(u, "OUT"), s.pin(r, "1"));
  s.wire(s.pin(r, "2"), s.pin(d, "A"));
  s.gnd(s.pin(d, "K"));
  s.label("out", s.pin(u, "OUT"));
  return { u, d };
}

function astable(): Example {
  const s = new Sheet("555 astable LED blinker", "R1 = 10 kΩ, R2 = 68 kΩ, C = 10 µF: f = 1.44 / ((R1 + 2·R2)·C) ≈ 0.99 Hz, high ≈ 0.54 s, low ≈ 0.47 s (duty 54 %). The LED blinks once per second.", "tran",
    { tran: { stop: "5", step: "1m" } });
  const { u, d } = timer555Core(s);
  const r1 = s.part("resistor", "R1", 6, 1, { value: "10k" });
  const r2 = s.part("resistor", "R2", 6, 11, { value: "68k" });
  const c = s.part("capacitor", "C1", 6, 18, { value: "10u" });
  s.label("VCC", s.pin(r1, "1"));
  s.wire(s.pin(r1, "2"), P(6, 8), s.pin(u, "DIS"));        // (6,4) -> (6,8) -> (12,8); R2 pin 1 at (6,8)
  s.wire(s.pin(r2, "2"), s.pin(u, "TRIG"));                // (6,14) -> (12,14)
  s.wire(s.pin(r2, "2"), s.pin(c, "1"));                   // (6,14) -> (6,15)
  s.wire(s.pin(u, "THR"), P(10, 12), P(10, 14));           // THR joins the TRIG wire
  s.gnd(s.pin(c, "2"));
  s.label("cap", s.pin(c, "1"));
  s.probeV("out", "Vout"); s.probeV("cap", "Vcap"); s.probeI(d, "I(LED)");
  return { file: "555-astable-blinker", project: s.project, expected: "V(out) is a ≈ 0.99 Hz square wave (≈ 7.3 V high), duty ≈ 54 %; V(cap) ramps between 3 V and 6 V." };
}

function monostable(): Example {
  const s = new Sheet("555 monostable (one-shot)", "A 1 ms low pulse on TRIG at t = 10 ms starts one output pulse of T = 1.1·R·C = 1.1 × 100 kΩ × 10 µF ≈ 1.1 s.", "tran",
    { tran: { stop: "2", step: "1m" } });
  const { u } = timer555Core(s);
  const r1 = s.part("resistor", "R1", 6, 4, { value: "100k" });
  const c = s.part("capacitor", "C1", 6, 16, { value: "10u" });
  const vt = s.part("vpulse", "V2", 9, 26, { low: "9", high: "0", frequency: "0.25", duty: "0.025", edge: "10u", delay: "10m" });
  s.label("VCC", s.pin(r1, "1"));
  s.wire(s.pin(r1, "2"), P(6, 12), s.pin(u, "THR"));        // (6,7) -> (6,12) -> (12,12)
  s.wire(s.pin(u, "DIS"), P(9, 8), P(9, 12));               // DIS joins the THR wire
  s.wire(P(6, 12), s.pin(c, "1"));                          // (6,12) -> (6,13)
  s.wire(s.pin(u, "TRIG"), P(9, 14), s.pin(vt, "1"));       // (12,14) -> (9,14) -> (9,22)
  s.gnd(s.pin(c, "2")); s.gnd(s.pin(vt, "2"));
  s.label("trig", s.pin(u, "TRIG")); s.label("cap", s.pin(c, "1"));
  s.probeV("trig", "Trigger"); s.probeV("out", "Vout"); s.probeV("cap", "Vcap");
  return { file: "555-monostable", project: s.project, expected: "V(out) is low until t = 10 ms, then high for ≈ 1.1 s, then low again; V(cap) ramps to 6 V and resets." };
}

function logicGates(): Example {
  const s = new Sheet("Logic gate demo", "Two square waves (A = 1 kHz, B = 500 Hz) step through all four input combinations every 2 ms. AND, OR and XOR outputs show their truth tables over time (5 V logic).", "tran",
    { tran: { stop: "4m", step: "1u" } });
  const va = s.part("vpulse", "VA", 0, 10, { low: "0", high: "5", frequency: "1k", duty: "50", edge: "100n" });
  const vb = s.part("vpulse", "VB", 0, 30, { low: "0", high: "5", frequency: "500", duty: "50", edge: "100n" });
  const vs = s.part("vdc", "V1", 0, 50, { value: "5" });
  s.label("A", s.pin(va, "1")); s.gnd(s.pin(va, "2"));
  s.label("B", s.pin(vb, "1")); s.gnd(s.pin(vb, "2"));
  s.label("VCC", s.pin(vs, "1")); s.gnd(s.pin(vs, "2"));
  (["and", "or", "xor"] as const).forEach((kind, i) => {
    const y = i * 20;
    const g = s.part(`gate_${kind}`, `U${i + 1}`, 24, y);
    const r = s.part("resistor", `R${i + 1}`, 38, y + 3, { value: "10k" });
    s.label("A", s.pin(g, "A")); s.label("B", s.pin(g, "B"));
    s.label("VCC", s.pin(g, "VCC")); s.gnd(s.pin(g, "GND"));
    s.wire(s.pin(g, "Y"), s.pin(r, "1"));
    s.label(kind, s.pin(r, "1")); s.gnd(s.pin(r, "2"));
  });
  for (const n of ["A", "B", "and", "or", "xor"]) s.probeV(n, n.toUpperCase());
  return { file: "logic-gates", project: s.project, expected: "AND high only when A and B are high (1.5-2 ms, 3.5-4 ms), OR low only when both are low, XOR high when they differ." };
}

function counterDemo(): Example {
  const s = new Sheet("4-bit counter demo", "A 1 kHz clock drives a 74x93-style ripple counter (Q0 wired to CP1). Q0-Q3 count 0-15 in binary on each falling clock edge; each output lights an LED.", "tran",
    { tran: { stop: "20m", step: "5u" } });
  const u = s.part("counter4", "U1", 20, 10);
  const clk = s.part("vpulse", "V1", 2, 10, { low: "0", high: "5", frequency: "1k", duty: "50", edge: "1u" });
  const vs = s.part("vdc", "V2", -6, 10, { value: "5" });
  s.label("VCC", s.pin(vs, "1")); s.gnd(s.pin(vs, "2"));
  s.label("VCC", s.pin(u, "VCC")); s.gnd(s.pin(u, "GND"));
  s.wire(s.pin(clk, "1"), s.pin(u, "CP0"));                // (2,6) -> (10,6)
  s.gnd(s.pin(clk, "2"));
  s.label("clk", s.pin(u, "CP0"));
  s.wire(s.pin(u, "R1"), P(8, 12)); s.wire(s.pin(u, "R2"), P(8, 14)); s.wire(P(8, 12), P(8, 16));
  s.gnd(P(8, 16));
  s.label("q0", s.pin(u, "CP1"));
  for (let i = 0; i < 4; i++) {
    const q = s.pin(u, `Q${i}`);
    const x = 36 + 6 * (3 - i);
    const r = s.part("resistor", `R${i + 1}`, x, 17, { value: "1k" });
    const d = s.part("led", `D${i + 1}`, x, 24, { color: "green" }, 270);
    s.wire(q, P(x, q.y), s.pin(r, "1"));
    s.wire(s.pin(r, "2"), s.pin(d, "A"));
    s.gnd(s.pin(d, "K"));
    s.label(`q${i}`, q);
  }
  for (const n of ["clk", "q0", "q1", "q2", "q3"]) s.probeV(n, n.toUpperCase());
  return { file: "counter-4bit", project: s.project, expected: "At 1 ms steps after each falling clock edge the outputs read 1, 2, 3 … 15, 0, 1 … in binary (Q0 = LSB)." };
}

export function buildExamples(): Example[] {
  return [divider(), rcCharging(), rcLowpass(), ledResistor(), halfWave(), bjtAmp(), opampInverting(), astable(), monostable(), logicGates(), counterDemo()];
}

/** Serialized form written to examples/*.sbproj (stable: no timestamps from the clock). */
export const exampleText = (e: Example) => JSON.stringify(e.project, null, 2) + "\n";
