// Starter parts. Pin positions mirror the matching KiCad library symbols
// (1 grid unit = 1.27 mm), so pin maps stay 1:1 on export.
import { toSpiceNumber } from "../core/units";
import type { ComponentDef, SpiceEmitContext } from "../core/types";

const n = (ctx: SpiceEmitContext, key: string) => toSpiceNumber(ctx.num(key));
const name = (letter: string, ctx: SpiceEmitContext) => {
  const r = ctx.inst.ref.replace(/[^A-Za-z0-9_]/g, "_");
  return r.toUpperCase().startsWith(letter) ? r : `${letter}${r}`;
};

const lead = (y1: number, y2: number) => ({ kind: "line" as const, x1: 0, y1, x2: 0, y2 });

export const resistor: ComponentDef = {
  id: "resistor", name: "Resistor", category: "Passive", refPrefix: "R",
  description: "Ideal linear resistor. Ohm's law: V = I·R. Power and tolerance are not modeled.",
  keywords: ["res", "ohm"],
  pins: [{ id: "1", name: "1", x: 0, y: -3 }, { id: "2", name: "2", x: 0, y: 3 }],
  symbol: [lead(-3, -1.6), { kind: "rect", x: -0.8, y: -1.6, w: 1.6, h: 3.2 }, lead(1.6, 3)],
  props: [{ key: "value", label: "Resistance", kind: "number", unit: "Ω", default: "1k", min: 0 }],
  provenance: "ideal",
  spice: (c) => [`${name("R", c)} ${c.node("1")} ${c.node("2")} ${n(c, "value")}`],
  kicad: { symbol: "Device:R", footprint: "Resistor_SMD:R_0805_2012Metric", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const capacitor: ComponentDef = {
  id: "capacitor", name: "Capacitor", category: "Passive", refPrefix: "C",
  description: "Ideal capacitor (no ESR or leakage). Blocks DC, passes AC. Optional initial voltage for transient runs with UIC.",
  keywords: ["cap", "farad"],
  pins: [{ id: "1", name: "1", x: 0, y: -3 }, { id: "2", name: "2", x: 0, y: 3 }],
  symbol: [lead(-3, -0.5), { kind: "line", x1: -1.6, y1: -0.5, x2: 1.6, y2: -0.5 }, { kind: "line", x1: -1.6, y1: 0.5, x2: 1.6, y2: 0.5 }, lead(0.5, 3)],
  props: [
    { key: "value", label: "Capacitance", kind: "number", unit: "F", default: "1u", min: 0 },
    { key: "ic", label: "Initial voltage", kind: "text", unit: "V", default: "", help: "Used only when the transient analysis has 'Use initial conditions' enabled.", model: true },
  ],
  provenance: "ideal",
  dcPaths: [],
  spice: (c) => {
    const ic = c.str("ic").trim();
    return [`${name("C", c)} ${c.node("1")} ${c.node("2")} ${n(c, "value")}${ic ? ` ic=${toSpiceNumber(c.num("ic"))}` : ""}`];
  },
  kicad: { symbol: "Device:C", footprint: "Capacitor_SMD:C_0805_2012Metric", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const inductor: ComponentDef = {
  id: "inductor", name: "Inductor", category: "Passive", refPrefix: "L",
  description: "Ideal inductor (no winding resistance or saturation). Short circuit at DC.",
  keywords: ["coil", "henry", "choke"],
  pins: [{ id: "1", name: "1", x: 0, y: -3 }, { id: "2", name: "2", x: 0, y: 3 }],
  symbol: [lead(-3, -2),
    { kind: "arc", x1: 0, y1: -2, x2: 0, y2: -1, r: 0.5, sweep: true }, { kind: "arc", x1: 0, y1: -1, x2: 0, y2: 0, r: 0.5, sweep: true },
    { kind: "arc", x1: 0, y1: 0, x2: 0, y2: 1, r: 0.5, sweep: true }, { kind: "arc", x1: 0, y1: 1, x2: 0, y2: 2, r: 0.5, sweep: true },
    lead(2, 3)],
  props: [{ key: "value", label: "Inductance", kind: "number", unit: "H", default: "1m", min: 0 }],
  provenance: "ideal",
  spice: (c) => [`${name("L", c)} ${c.node("1")} ${c.node("2")} ${n(c, "value")}`],
  kicad: { symbol: "Device:L", footprint: "Inductor_SMD:L_1206_3216Metric", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

const sourceCircle = [lead(-4, -2), { kind: "circle" as const, cx: 0, cy: 0, r: 2 }, lead(2, 4)];

export const vdc: ComponentDef = {
  id: "vdc", name: "DC Voltage Source", category: "Sources", refPrefix: "V",
  description: "Ideal DC voltage source (zero internal resistance). The + pin is at the top.",
  keywords: ["battery", "supply", "power", "dc"],
  pins: [{ id: "1", name: "+", x: 0, y: -4 }, { id: "2", name: "−", x: 0, y: 4 }],
  symbol: [...sourceCircle, { kind: "text", x: 0, y: -0.6, text: "+", size: 1.4, anchor: "middle" }, { kind: "text", x: 0, y: 1.4, text: "−", size: 1.4, anchor: "middle" }],
  props: [
    { key: "value", label: "Voltage", kind: "number", unit: "V", default: "5" },
    { key: "acmag", label: "AC magnitude", kind: "number", unit: "V", default: "0", help: "Small-signal amplitude for AC analysis.", model: true },
  ],
  provenance: "ideal",
  spice: (c) => {
    const ac = c.num("acmag");
    return [`${name("V", c)} ${c.node("1")} ${c.node("2")} DC ${n(c, "value")}${ac ? ` AC ${toSpiceNumber(ac)}` : ""}`];
  },
  kicad: { symbol: "Simulation_SPICE:VDC", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const vsine: ComponentDef = {
  id: "vsine", name: "Sine Voltage Source", category: "Sources", refPrefix: "V",
  description: "Ideal sine source: offset + amplitude·sin(2π·f·t + phase). Also drives AC analysis with its AC magnitude.",
  keywords: ["ac", "sine", "signal", "generator"],
  pins: [{ id: "1", name: "+", x: 0, y: -4 }, { id: "2", name: "−", x: 0, y: 4 }],
  symbol: [...sourceCircle, { kind: "arc", x1: -1.2, y1: 0, x2: 0, y2: 0, r: 0.6, sweep: true }, { kind: "arc", x1: 0, y1: 0, x2: 1.2, y2: 0, r: 0.6, sweep: false }],
  props: [
    { key: "amplitude", label: "Amplitude", kind: "number", unit: "V", default: "1" },
    { key: "frequency", label: "Frequency", kind: "number", unit: "Hz", default: "1k", min: 0 },
    { key: "offset", label: "DC offset", kind: "number", unit: "V", default: "0" },
    { key: "phase", label: "Phase", kind: "number", unit: "°", default: "0" },
    { key: "acmag", label: "AC magnitude", kind: "number", unit: "V", default: "1", model: true },
  ],
  provenance: "ideal",
  spice: (c) => [`${name("V", c)} ${c.node("1")} ${c.node("2")} DC ${n(c, "offset")} AC ${n(c, "acmag")} SIN(${n(c, "offset")} ${n(c, "amplitude")} ${n(c, "frequency")} 0 0 ${n(c, "phase")})`],
  kicad: { symbol: "Simulation_SPICE:VSIN", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["amplitude", "frequency"],
};

export const vpulse: ComponentDef = {
  id: "vpulse", name: "Square / Pulse Source", category: "Sources", refPrefix: "V",
  description: "Ideal pulse source switching between Low and High at the given frequency and duty cycle. Edge times are finite to help convergence.",
  keywords: ["square", "clock", "pulse", "pwm"],
  pins: [{ id: "1", name: "+", x: 0, y: -4 }, { id: "2", name: "−", x: 0, y: 4 }],
  symbol: [...sourceCircle, { kind: "polyline", points: [{ x: -1.2, y: 0.6 }, { x: -0.6, y: 0.6 }, { x: -0.6, y: -0.6 }, { x: 0.6, y: -0.6 }, { x: 0.6, y: 0.6 }, { x: 1.2, y: 0.6 }] }],
  props: [
    { key: "low", label: "Low level", kind: "number", unit: "V", default: "0" },
    { key: "high", label: "High level", kind: "number", unit: "V", default: "5" },
    { key: "frequency", label: "Frequency", kind: "number", unit: "Hz", default: "1k", min: 0 },
    { key: "duty", label: "Duty cycle", kind: "number", unit: "%", default: "50", min: 0 },
    { key: "edge", label: "Rise/fall time", kind: "number", unit: "s", default: "1n", model: true },
    { key: "delay", label: "Delay", kind: "number", unit: "s", default: "0", model: true },
  ],
  provenance: "ideal",
  spice: (c) => {
    const f = c.num("frequency"), duty = c.num("duty") / 100, tr = c.num("edge");
    const per = 1 / f;
    const width = Math.max(per * duty - tr, tr);
    return [`${name("V", c)} ${c.node("1")} ${c.node("2")} PULSE(${n(c, "low")} ${n(c, "high")} ${n(c, "delay")} ${toSpiceNumber(tr)} ${toSpiceNumber(tr)} ${toSpiceNumber(width)} ${toSpiceNumber(per)})`];
  },
  kicad: { symbol: "Simulation_SPICE:VPULSE", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["high", "frequency"],
};

export const ground: ComponentDef = {
  id: "ground", name: "Ground", category: "Sources", refPrefix: "#PWR",
  description: "0 V reference (SPICE node 0). Every circuit needs at least one.",
  keywords: ["gnd", "earth", "0v", "reference"],
  pins: [{ id: "1", name: "GND", x: 0, y: 0 }],
  symbol: [lead(0, 1), { kind: "polyline", points: [{ x: -1.5, y: 1 }, { x: 1.5, y: 1 }, { x: 0, y: 2.5 }], closed: true }],
  props: [],
  provenance: "none",
  role: "ground",
  kicad: { symbol: "power:GND", footprint: "", pinMap: { 1: "1" } },
};

export const diode: ComponentDef = {
  id: "diode", name: "Diode (generic silicon)", category: "Semiconductors", refPrefix: "D",
  description: "Generic small-signal silicon diode (1N4148-like parameters). Anode on the left, cathode (bar) on the right.",
  keywords: ["rectifier", "1n4148", "signal diode"],
  pins: [{ id: "A", name: "A", x: -3, y: 0 }, { id: "K", name: "K", x: 3, y: 0 }],
  symbol: [{ kind: "line", x1: -3, y1: 0, x2: 3, y2: 0 }, { kind: "polyline", points: [{ x: -1, y: -1.2 }, { x: -1, y: 1.2 }, { x: 1, y: 0 }], closed: true, fill: true }, { kind: "line", x1: 1, y1: -1.2, x2: 1, y2: 1.2 }],
  props: [],
  provenance: "generic",
  accuracyNote: "Typical small-signal silicon parameters (Is=2.5n, N=1.75, Rs=0.6, BV=100). Not a specific manufacturer's part.",
  spice: (c) => {
    c.define("D_GENERIC", ".model D_GENERIC D(Is=2.52n N=1.752 Rs=0.568 Cjo=4p M=0.4 tt=20n BV=100 IBV=100u)");
    return [`${name("D", c)} ${c.node("A")} ${c.node("K")} D_GENERIC`];
  },
  // KiCad Device:D: pin 1 = K, pin 2 = A.
  kicad: { symbol: "Device:D", footprint: "Diode_SMD:D_SOD-123", pinMap: { A: "2", K: "1" } },
};

export const basicParts: ComponentDef[] = [resistor, capacitor, inductor, vdc, vsine, vpulse, ground, diode];
