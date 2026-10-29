// Passive parts. Pin positions mirror the matching KiCad library symbols
// (1 grid unit = 1.27 mm), so pin maps stay 1:1 on export.
import type { ComponentDef } from "../core/types";
import { arcCoil, circle, el, hlead, line, modelProp, n, poly, rect, sn, text, uid, vlead } from "./util";

export const resistor: ComponentDef = {
  id: "resistor", name: "Resistor", category: "Passive", refPrefix: "R",
  description: "Ideal linear resistor. Ohm's law: V = I·R. Power rating, tolerance and temperature drift are not modeled.",
  keywords: ["res", "ohm"],
  pins: [{ id: "1", name: "1", x: 0, y: -3 }, { id: "2", name: "2", x: 0, y: 3 }],
  symbol: [vlead(-3, -1.6), rect(-0.8, -1.6, 1.6, 3.2), vlead(1.6, 3)],
  props: [{ key: "value", label: "Resistance", kind: "number", unit: "Ω", default: "1k", min: 0 }],
  provenance: "ideal",
  spice: (c) => [`${el("R", c)} ${c.node("1")} ${c.node("2")} ${n(c, "value")}`],
  kicad: { symbol: "Device:R", footprint: "Resistor_SMD:R_0805_2012Metric", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const potentiometer: ComponentDef = {
  id: "potentiometer", name: "Potentiometer", category: "Passive", refPrefix: "RV",
  description: "Three-terminal variable resistor. The wiper (pin 2) divides the total resistance: at 0 % it sits at pin 3, at 100 % at pin 1. The position is fixed for each simulation run.",
  keywords: ["pot", "trimmer", "variable resistor", "wiper", "volume"],
  pins: [{ id: "1", name: "1", x: 0, y: -3 }, { id: "2", name: "W", x: 3, y: 0 }, { id: "3", name: "3", x: 0, y: 3 }],
  symbol: [vlead(-3, -1.6), rect(-0.8, -1.6, 1.6, 3.2), vlead(1.6, 3), hlead(3, 1.2), poly([[1.9, -0.5], [1.0, 0], [1.9, 0.5]], true, true)],
  props: [
    { key: "value", label: "Total resistance", kind: "number", unit: "Ω", default: "10k", min: 0 },
    { key: "position", label: "Wiper position", kind: "number", unit: "%", default: "50", min: 0, help: "0 % = wiper at pin 3, 100 % = wiper at pin 1." },
  ],
  provenance: "ideal",
  accuracyNote: "Two ideal resistors split at the wiper. Contact resistance and taper (log/linear) are not modeled; the position is constant during a run.",
  spice: (c) => {
    const r = c.num("value"), p = Math.min(1, Math.max(0, c.num("position") / 100));
    const rmin = 1e-3; // a 0 Ω element would short the two nodes; keep 1 mΩ
    const b = el("R", c);
    return [
      `${b}_A ${c.node("1")} ${c.node("2")} ${sn(Math.max(r * (1 - p), rmin))}`,
      `${b}_B ${c.node("2")} ${c.node("3")} ${sn(Math.max(r * p, rmin))}`,
    ];
  },
  kicad: { symbol: "Device:R_Potentiometer", footprint: "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical", pinMap: { 1: "1", 2: "2", 3: "3" } },
  displayProps: ["value", "position"],
};

const capPlates = [vlead(-3, -0.5), line(-1.6, -0.5, 1.6, -0.5), line(-1.6, 0.5, 1.6, 0.5), vlead(0.5, 3)];

export const capacitor: ComponentDef = {
  id: "capacitor", name: "Capacitor", category: "Passive", refPrefix: "C",
  description: "Ideal capacitor (no ESR or leakage). Blocks DC, passes AC. Optional initial voltage for transient runs with UIC.",
  keywords: ["cap", "farad", "ceramic"],
  pins: [{ id: "1", name: "1", x: 0, y: -3 }, { id: "2", name: "2", x: 0, y: 3 }],
  symbol: capPlates,
  props: [
    { key: "value", label: "Capacitance", kind: "number", unit: "F", default: "1u", min: 0 },
    { key: "ic", label: "Initial voltage", kind: "text", unit: "V", default: "", help: "Used only when the transient analysis has 'Use initial conditions' enabled.", model: true },
  ],
  provenance: "ideal",
  dcPaths: [],
  spice: (c) => {
    const ic = c.str("ic").trim();
    return [`${el("C", c)} ${c.node("1")} ${c.node("2")} ${n(c, "value")}${ic ? ` ic=${sn(c.num("ic"))}` : ""}`];
  },
  kicad: { symbol: "Device:C", footprint: "Capacitor_SMD:C_0805_2012Metric", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const capacitorPolarized: ComponentDef = {
  id: "capacitor_polarized", name: "Electrolytic Capacitor", category: "Passive", refPrefix: "C",
  description: "Polarized (electrolytic) capacitor; + is pin 1 at the top. Simulated as an ideal capacitor with optional ESR.",
  keywords: ["electrolytic", "polarized", "cap", "elko", "bulk"],
  pins: [{ id: "1", name: "+", x: 0, y: -3 }, { id: "2", name: "−", x: 0, y: 3 }],
  symbol: [vlead(-3, -0.5), rect(-1.6, -0.8, 3.2, 0.3), { kind: "arc", x1: -1.6, y1: 0.8, x2: 1.6, y2: 0.8, r: 3, sweep: true }, vlead(0.4, 3), text(-1.4, -1.6, "+", 1.2)],
  props: [
    { key: "value", label: "Capacitance", kind: "number", unit: "F", default: "100u", min: 0 },
    modelProp("esr", "ESR", "0", "Ω", "Equivalent series resistance. 0 = ideal."),
    { key: "ic", label: "Initial voltage", kind: "text", unit: "V", default: "", help: "Used only when the transient analysis has 'Use initial conditions' enabled.", model: true },
  ],
  provenance: "ideal",
  accuracyNote: "Ideal capacitor plus optional series ESR. Reverse-voltage damage, leakage current and voltage rating are NOT modeled: check the polarity yourself.",
  dcPaths: [],
  spice: (c) => {
    const ic = c.str("ic").trim();
    const esr = c.num("esr");
    const b = el("C", c);
    const top = esr > 0 ? `${b}_esr` : c.node("1");
    return [
      ...(esr > 0 ? [`R${uid(c)}_esr ${c.node("1")} ${top} ${sn(esr)}`] : []),
      `${b} ${top} ${c.node("2")} ${n(c, "value")}${ic ? ` ic=${sn(c.num("ic"))}` : ""}`,
    ];
  },
  kicad: { symbol: "Device:C_Polarized", footprint: "Capacitor_THT:CP_Radial_D6.3mm_P2.50mm", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const inductor: ComponentDef = {
  id: "inductor", name: "Inductor", category: "Passive", refPrefix: "L",
  description: "Ideal inductor (optional winding resistance; no saturation or core loss). Short circuit at DC.",
  keywords: ["coil", "henry", "choke"],
  pins: [{ id: "1", name: "1", x: 0, y: -3 }, { id: "2", name: "2", x: 0, y: 3 }],
  symbol: [vlead(-3, -2), ...arcCoil(0, -2, 4, "right"), vlead(2, 3)],
  props: [
    { key: "value", label: "Inductance", kind: "number", unit: "H", default: "1m", min: 0 },
    modelProp("rser", "Winding resistance", "0", "Ω", "Series DC resistance. 0 = ideal."),
    { key: "ic", label: "Initial current", kind: "text", unit: "A", default: "", help: "Used only when the transient analysis has 'Use initial conditions' enabled.", model: true },
  ],
  provenance: "ideal",
  spice: (c) => {
    const ic = c.str("ic").trim();
    const r = c.num("rser"), u = uid(c);
    const mid = r > 0 ? `${u}_w` : c.node("2");
    return [
      `${el("L", c)} ${c.node("1")} ${mid} ${n(c, "value")}${ic ? ` ic=${sn(c.num("ic"))}` : ""}`,
      ...(r > 0 ? [`R${u}_w ${mid} ${c.node("2")} ${sn(r)}`] : []),
    ];
  },
  kicad: { symbol: "Device:L", footprint: "Inductor_SMD:L_1206_3216Metric", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["value"],
};

export const transformer: ComponentDef = {
  id: "transformer", name: "Transformer", category: "Passive", refPrefix: "T",
  description: "Two coupled inductors. Turns ratio N = Ns/Np sets the secondary inductance (Ls = N²·Lp); the dots (P1, S1) mark in-phase ends. The secondary is isolated: give it its own ground reference.",
  keywords: ["coupled inductor", "isolation", "mains", "step down", "step up"],
  pins: [
    { id: "P1", name: "P1", x: -8, y: -4 }, { id: "P2", name: "P2", x: -8, y: 4 },
    { id: "S1", name: "S1", x: 8, y: -4 }, { id: "S2", name: "S2", x: 8, y: 4 },
  ],
  symbol: [
    hlead(-8, -2, -4), vlead(-4, -2, -2), hlead(-8, -2, 4), vlead(2, 4, -2), ...arcCoil(-2, -2, 4, "left"),
    hlead(2, 8, -4), vlead(-4, -2, 2), hlead(2, 8, 4), vlead(2, 4, 2), ...arcCoil(2, -2, 4, "right"),
    line(-0.4, -2.5, -0.4, 2.5), line(0.4, -2.5, 0.4, 2.5),
    circle(-3.4, -2.6, 0.3, true), circle(3.4, -2.6, 0.3, true),
  ],
  props: [
    { key: "ratio", label: "Turns ratio Ns/Np", kind: "number", default: "0.1", min: 0, help: "0.1 = 10:1 step-down, 2 = 1:2 step-up." },
    { key: "lp", label: "Primary inductance", kind: "number", unit: "H", default: "1", min: 0, model: true },
    modelProp("k", "Coupling factor", "0.999", undefined, "1 = perfect coupling; real transformers are 0.95-0.999."),
    modelProp("rp", "Primary resistance", "0.1", "Ω"),
    modelProp("rs", "Secondary resistance", "0.1", "Ω"),
  ],
  provenance: "ideal",
  accuracyNote: "Linear coupled inductors with winding resistance. Core saturation, hysteresis and losses are not modeled.",
  dcPaths: [["P1", "P2"], ["S1", "S2"]],
  spice: (c) => {
    const lp = c.num("lp"), ratio = c.num("ratio"), k = Math.min(1, Math.max(0, c.num("k")));
    const b = el("L", c), u = uid(c);
    const rp = c.num("rp"), rs = c.num("rs");
    // Winding resistances as separate resistors (ngspice inductors have no Rser parameter).
    const p2 = rp > 0 ? `${u}_p` : c.node("P2"), s2 = rs > 0 ? `${u}_s` : c.node("S2");
    return [
      `${b}_P ${c.node("P1")} ${p2} ${sn(lp)}`,
      ...(rp > 0 ? [`R${u}_p ${p2} ${c.node("P2")} ${sn(rp)}`] : []),
      `${b}_S ${c.node("S1")} ${s2} ${sn(lp * ratio * ratio)}`,
      ...(rs > 0 ? [`R${u}_s ${s2} ${c.node("S2")} ${sn(rs)}`] : []),
      `K${u} ${b}_P ${b}_S ${sn(k)}`,
    ];
  },
  // Transformer_1P_1S: 1 = AA (top left), 2 = AB, 3 = SA (bottom right), 4 = SB (top right).
  kicad: { symbol: "Device:Transformer_1P_1S", footprint: "", pinMap: { P1: "1", P2: "2", S1: "4", S2: "3" } },
  displayProps: ["ratio"],
};

const switchModel = [
  modelProp("ron", "On resistance", "10m", "Ω"),
  modelProp("roff", "Off resistance", "1G", "Ω"),
];
const switchNote = "Static ideal switch: a resistor of Ron (closed) or Roff (open). The state is fixed for a whole simulation run; to switch during a run, drive a node with a pulse source instead. Contact bounce is not modeled.";

export const switchSpst: ComponentDef = {
  id: "switch_spst", name: "Switch (SPST)", category: "Passive", refPrefix: "SW",
  description: "On/off toggle switch. Set Closed to choose its state for the run.",
  keywords: ["switch", "toggle", "spst", "on off"],
  pins: [{ id: "1", name: "A", x: -4, y: 0 }, { id: "2", name: "B", x: 4, y: 0 }],
  symbol: [hlead(-4, -2), circle(-1.6, 0, 0.4), line(-1.3, -0.2, 2, -1.6), circle(1.6, 0, 0.4), hlead(2, 4)],
  props: [{ key: "closed", label: "Closed", kind: "bool", default: false }, ...switchModel],
  provenance: "ideal",
  accuracyNote: switchNote,
  // Roff keeps a (very weak) DC path even when open.
  spice: (c) => [`${el("R", c)} ${c.node("1")} ${c.node("2")} ${c.str("closed") === "true" ? n(c, "ron") : n(c, "roff")}`],
  kicad: { symbol: "Switch:SW_SPST", footprint: "Button_Switch_THT:SW_DIP_SPSTx01_Slide_9.78x4.72mm_W7.62mm_P2.54mm", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["closed"],
};

export const pushButton: ComponentDef = {
  id: "push_button", name: "Push Button", category: "Passive", refPrefix: "SW",
  description: "Momentary normally-open push button. Set Pressed to choose its state for the run.",
  keywords: ["button", "momentary", "tactile", "key", "push"],
  pins: [{ id: "1", name: "1", x: -4, y: 0 }, { id: "2", name: "2", x: 4, y: 0 }],
  symbol: [hlead(-4, -2), circle(-1.6, 0, 0.4), circle(1.6, 0, 0.4), hlead(2, 4), line(-2, -1, 2, -1), vlead(-1, -2.4), line(-0.8, -2.4, 0.8, -2.4)],
  props: [{ key: "pressed", label: "Pressed", kind: "bool", default: false }, ...switchModel],
  provenance: "ideal",
  accuracyNote: switchNote,
  spice: (c) => [`${el("R", c)} ${c.node("1")} ${c.node("2")} ${c.str("pressed") === "true" ? n(c, "ron") : n(c, "roff")}`],
  kicad: { symbol: "Switch:SW_Push", footprint: "Button_Switch_THT:SW_PUSH_6mm", pinMap: { 1: "1", 2: "2" } },
  displayProps: ["pressed"],
};

export const passiveParts: ComponentDef[] = [resistor, potentiometer, capacitor, capacitorPolarized, inductor, transformer, switchSpst, pushButton];
