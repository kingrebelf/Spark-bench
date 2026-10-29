// Independent sources, ground, battery and meters.
import type { ComponentDef, PinDef, Shape } from "../core/types";
import { circle, el, line, modelProp, n, poly, sn, text, uid, vlead } from "./util";

const plusMinus: PinDef[] = [{ id: "1", name: "+", x: 0, y: -4 }, { id: "2", name: "−", x: 0, y: 4 }];
const sourceCircle: Shape[] = [vlead(-4, -2), circle(0, 0, 2), vlead(2, 4)];
const acmag = modelProp("acmag", "AC magnitude", "0", "V", "Small-signal amplitude used by AC analysis (0 = not an AC input).");

export const vdc: ComponentDef = {
  id: "vdc", name: "DC Voltage Source", category: "Sources", refPrefix: "V",
  description: "Ideal DC voltage source (zero internal resistance). The + pin is at the top.",
  keywords: ["supply", "power", "dc", "voltage"],
  pins: plusMinus,
  symbol: [...sourceCircle, text(0, -0.8, "+", 1.4), text(0, 0.9, "−", 1.4)],
  props: [{ key: "value", label: "Voltage", kind: "number", unit: "V", default: "5" }, acmag],
  provenance: "ideal",
  spice: (c) => {
    const ac = c.num("acmag");
    return [`${el("V", c)} ${c.node("1")} ${c.node("2")} DC ${n(c, "value")}${ac ? ` AC ${sn(ac)}` : ""}`];
  },
  kicad: { symbol: "Simulation_SPICE:VDC", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const idc: ComponentDef = {
  id: "idc", name: "DC Current Source", category: "Sources", refPrefix: "I",
  description: "Ideal DC current source. Current flows through the source from the top pin to the bottom pin (arrow), i.e. it is pushed out of the bottom pin into the circuit (SPICE convention).",
  keywords: ["current", "constant current", "dc"],
  pins: [{ id: "1", name: "1", x: 0, y: -4 }, { id: "2", name: "2", x: 0, y: 4 }],
  symbol: [...sourceCircle, vlead(-1.2, 1.2), poly([[-0.5, 0.4], [0, 1.2], [0.5, 0.4]])],
  props: [
    { key: "value", label: "Current", kind: "number", unit: "A", default: "1m" },
    modelProp("acmag", "AC magnitude", "0", "A", "Small-signal amplitude used by AC analysis."),
  ],
  provenance: "ideal",
  accuracyNote: "Ideal: it forces its current whatever voltage that takes, so it needs a DC path (e.g. a resistor) across it.",
  spice: (c) => {
    const ac = c.num("acmag");
    return [`${el("I", c)} ${c.node("1")} ${c.node("2")} DC ${n(c, "value")}${ac ? ` AC ${sn(ac)}` : ""}`];
  },
  kicad: { symbol: "Simulation_SPICE:IDC", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const vsine: ComponentDef = {
  id: "vsine", name: "Sine Voltage Source", category: "Sources", refPrefix: "V",
  description: "Ideal sine source: offset + amplitude·sin(2π·f·t + phase). Also drives AC analysis with its AC magnitude.",
  keywords: ["ac", "sine", "signal", "generator", "function generator"],
  pins: plusMinus,
  symbol: [...sourceCircle, { kind: "arc", x1: -1.2, y1: 0, x2: 0, y2: 0, r: 0.6, sweep: true }, { kind: "arc", x1: 0, y1: 0, x2: 1.2, y2: 0, r: 0.6, sweep: false }],
  props: [
    { key: "amplitude", label: "Amplitude", kind: "number", unit: "V", default: "1", help: "Peak amplitude (not peak-to-peak, not RMS)." },
    { key: "frequency", label: "Frequency", kind: "number", unit: "Hz", default: "1k", min: 0 },
    { key: "offset", label: "DC offset", kind: "number", unit: "V", default: "0" },
    { key: "phase", label: "Phase", kind: "number", unit: "°", default: "0" },
    modelProp("acmag", "AC magnitude", "1", "V", "Small-signal amplitude used by AC analysis."),
  ],
  provenance: "ideal",
  spice: (c) => [`${el("V", c)} ${c.node("1")} ${c.node("2")} DC ${n(c, "offset")} AC ${n(c, "acmag")} SIN(${n(c, "offset")} ${n(c, "amplitude")} ${n(c, "frequency")} 0 0 ${n(c, "phase")})`],
  kicad: { symbol: "Simulation_SPICE:VSIN", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["amplitude", "frequency"],
};

export const vpulse: ComponentDef = {
  id: "vpulse", name: "Square / Pulse Source", category: "Sources", refPrefix: "V",
  description: "Ideal pulse source switching between Low and High at the given frequency and duty cycle. Edge times are finite to help convergence.",
  keywords: ["square", "clock", "pulse", "pwm"],
  pins: plusMinus,
  symbol: [...sourceCircle, poly([[-1.2, 0.6], [-0.6, 0.6], [-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [1.2, 0.6]])],
  props: [
    { key: "low", label: "Low level", kind: "number", unit: "V", default: "0" },
    { key: "high", label: "High level", kind: "number", unit: "V", default: "5" },
    { key: "frequency", label: "Frequency", kind: "number", unit: "Hz", default: "1k", min: 0 },
    { key: "duty", label: "Duty cycle", kind: "number", unit: "%", default: "50", min: 0 },
    modelProp("edge", "Rise/fall time", "1n", "s"),
    modelProp("delay", "Delay", "0", "s"),
    acmag,
  ],
  provenance: "ideal",
  spice: (c) => {
    const f = c.num("frequency"), duty = Math.min(100, Math.max(0, c.num("duty"))) / 100, tr = c.num("edge");
    const per = 1 / f;
    const width = Math.max(per * duty - tr, tr);
    const ac = c.num("acmag");
    return [`${el("V", c)} ${c.node("1")} ${c.node("2")}${ac ? ` AC ${sn(ac)}` : ""} PULSE(${n(c, "low")} ${n(c, "high")} ${n(c, "delay")} ${sn(tr)} ${sn(tr)} ${sn(width)} ${sn(per)})`];
  },
  kicad: { symbol: "Simulation_SPICE:VPULSE", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["high", "frequency"],
};

export const vtriangle: ComponentDef = {
  id: "vtriangle", name: "Triangle / Sawtooth Source", category: "Sources", refPrefix: "V",
  description: "Ideal triangle wave between Low and High. Symmetry sets the rising share of each period: 50 % = triangle, ~100 % = rising sawtooth, ~0 % = falling sawtooth.",
  keywords: ["triangle", "ramp", "sawtooth", "saw"],
  pins: plusMinus,
  symbol: [...sourceCircle, poly([[-1.2, 0.6], [-0.6, -0.6], [0, 0.6], [0.6, -0.6], [1.2, 0.6]])],
  props: [
    { key: "low", label: "Low level", kind: "number", unit: "V", default: "0" },
    { key: "high", label: "High level", kind: "number", unit: "V", default: "5" },
    { key: "frequency", label: "Frequency", kind: "number", unit: "Hz", default: "1k", min: 0 },
    { key: "symmetry", label: "Symmetry (rise share)", kind: "number", unit: "%", default: "50", min: 0 },
    modelProp("delay", "Delay", "0", "s"),
  ],
  provenance: "ideal",
  accuracyNote: "A SPICE PULSE source whose rise and fall times fill the whole period.",
  spice: (c) => {
    const per = 1 / c.num("frequency");
    const sym = Math.min(0.999, Math.max(0.001, c.num("symmetry") / 100));
    const tr = per * sym, tf = per - tr;
    return [`${el("V", c)} ${c.node("1")} ${c.node("2")} PULSE(${n(c, "low")} ${n(c, "high")} ${n(c, "delay")} ${sn(tr)} ${sn(tf)} ${sn(per * 1e-9)} ${sn(per)})`];
  },
  kicad: { symbol: "Simulation_SPICE:VPULSE", footprint: "", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["high", "frequency"],
};

export const battery: ComponentDef = {
  id: "battery", name: "Battery", category: "Sources", refPrefix: "BT",
  description: "Battery as an ideal voltage source with internal resistance. + is pin 1 at the top.",
  keywords: ["cell", "aa", "9v", "lipo", "coin cell"],
  pins: [{ id: "1", name: "+", x: 0, y: -4 }, { id: "2", name: "−", x: 0, y: 4 }],
  symbol: [vlead(-4, -1.2), line(-1.6, -1.2, 1.6, -1.2), line(-0.8, -0.6, 0.8, -0.6), line(-1.6, 0.4, 1.6, 0.4), line(-0.8, 1, 0.8, 1), vlead(1, 4), text(-1.6, -2, "+", 1.2)],
  props: [
    { key: "value", label: "Voltage", kind: "number", unit: "V", default: "9" },
    modelProp("rint", "Internal resistance", "0.5", "Ω", "Typical: AA alkaline ~0.15 Ω, 9 V alkaline ~1-2 Ω, CR2032 ~10-20 Ω."),
  ],
  provenance: "ideal",
  accuracyNote: "Constant voltage behind a fixed internal resistance. Discharge, capacity and temperature are not modeled.",
  spice: (c) => {
    const r = c.num("rint"), u = uid(c);
    const mid = r > 0 ? `${u}_int` : c.node("1");
    return [`${el("V", c)} ${mid} ${c.node("2")} DC ${n(c, "value")}`, ...(r > 0 ? [`R${u}_int ${c.node("1")} ${mid} ${sn(r)}`] : [])];
  },
  kicad: { symbol: "Device:Battery", footprint: "Battery:BatteryHolder_Keystone_2460_1xAA", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const ground: ComponentDef = {
  id: "ground", name: "Ground", category: "Sources", refPrefix: "#PWR",
  description: "0 V reference (SPICE node 0). Every circuit needs at least one.",
  keywords: ["gnd", "earth", "0v", "reference"],
  pins: [{ id: "1", name: "GND", x: 0, y: 0 }],
  symbol: [vlead(0, 1), poly([[-1.5, 1], [1.5, 1], [0, 2.5]], true)],
  props: [],
  provenance: "none",
  role: "ground",
  kicad: { symbol: "power:GND", footprint: "", pinMap: { 1: "1" } },
};

export const ammeter: ComponentDef = {
  id: "ammeter", name: "Ammeter", category: "Instruments", refPrefix: "AM",
  description: "Ideal ammeter: a 0 V source in series, so its current is always saved. Positive when current enters + (top) and leaves − (bottom).",
  keywords: ["current meter", "amp meter", "measure current"],
  pins: plusMinus,
  symbol: [...sourceCircle, text(0, 0, "A", 1.6), text(-1.6, -2.6, "+", 1)],
  props: [],
  provenance: "ideal",
  accuracyNote: "Zero burden voltage (a real meter adds a small shunt resistance).",
  // A 0 V source: SPICE reports its branch current as positive flowing into the + node.
  spice: (c) => [`${el("V", c)} ${c.node("1")} ${c.node("2")} DC 0`],
  // Device:Ammeter_DC: pin 2 is + (top), pin 1 is − (bottom).
  kicad: { symbol: "Device:Ammeter_DC", footprint: "", pinMap: { 1: "2", 2: "1" } },
};

export const voltmeter: ComponentDef = {
  id: "voltmeter", name: "Voltmeter", category: "Instruments", refPrefix: "VM",
  description: "Voltmeter across two points with a DMM-like input resistance. Its reading V(+) − V(−) is saved as the vector vm_<ref>.",
  keywords: ["voltage meter", "measure voltage", "dmm", "multimeter"],
  pins: plusMinus,
  symbol: [...sourceCircle, text(0, 0, "V", 1.6), text(-1.6, -2.6, "+", 1)],
  props: [modelProp("rin", "Input resistance", "10MEG", "Ω", "Typical handheld DMM: 10 MΩ.")],
  provenance: "ideal",
  accuracyNote: "Loads the circuit with its input resistance like a real DMM; the reading itself is exact.",
  spice: (c) => {
    const u = uid(c);
    return [
      `${el("R", c)} ${c.node("1")} ${c.node("2")} ${n(c, "rin")}`,
      `E${u}_meter vm_${u.toLowerCase()} 0 ${c.node("1")} ${c.node("2")} 1`,
    ];
  },
  // Device:Voltmeter_DC: pin 2 is + (top), pin 1 is − (bottom).
  kicad: { symbol: "Device:Voltmeter_DC", footprint: "", pinMap: { 1: "2", 2: "1" } },
};

export const sourceParts: ComponentDef[] = [vdc, idc, vsine, vpulse, vtriangle, battery, ground, ammeter, voltmeter];
