// Diodes, BJTs and MOSFETs. Built-in models are generic or "-like" fits (see accuracyNote);
// any of these parts can instead use a project-imported .model of the right type (modelId).
import type { ComponentDef, PinDef, PropDef, Shape, SpiceEmitContext } from "../core/types";
import { modelSlot } from "./spiceImport";
import { chooseModel, circle, diodeBody, el, line, modelProp, params, poly, sn, vlead } from "./util";

/** Short stable hash so per-instance parameter sets get distinct model names. */
function hashName(prefix: string, s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${prefix}_${(h >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------- diodes

// KiCad Device:D family: pin 1 = K (left), pin 2 = A (right).
/** A rating prop (component damage in live simulation); it never changes the netlist. */
const ratingProp = (key: string, label: string, def: string, unit: string, help: string): PropDef =>
  ({ key, label, kind: "number", unit, default: def, min: 0, help: `${help} Used by live simulation to show over-stress and burnout (averaged, see the simulation docs). Not used by ngspice.` });
const currentRating = (def: string, what: string) => ({
  props: [ratingProp("imax", "Max current", def, "A", `Highest current the part takes (${what}).`)],
  ratings: [{ kind: "current" as const, prop: "imax", default: Number(def.replace("m", "e-3")) }],
});

const diodePins: PinDef[] = [{ id: "K", name: "K", x: -3, y: 0 }, { id: "A", name: "A", x: 3, y: 0 }];
const diodeMap = { K: "1", A: "2" };
const importNote = " You can replace the model with an imported diode .model (Model → choose).";

function diodeSpice(ctx: SpiceEmitContext, builtinName: string, builtinText: () => string): string[] | null {
  const m = chooseModel(ctx, ["D"], builtinName, builtinText);
  return m && [`${el("D", ctx)} ${ctx.node("A")} ${ctx.node("K")} ${m.name}`];
}

export const diode: ComponentDef = {
  id: "diode", name: "Diode (small signal)", category: "Semiconductors", refPrefix: "D",
  description: "Generic small-signal silicon diode (1N4148-like). Cathode (bar, K) on the left, anode (A) on the right; current flows A → K.",
  keywords: ["rectifier", "1n4148", "signal diode", "silicon"],
  pins: diodePins,
  symbol: diodeBody(),
  ...currentRating("300m", "1N4148 class: 300 mA average"),
  provenance: "generic",
  accuracyNote: "Typical small-signal silicon parameters in the 1N4148 class (Is=2.52n, N=1.752, Rs=0.568, BV=100). Not a manufacturer's model." + importNote,
  spice: (c) => diodeSpice(c, "D_SB_SIGNAL", () => ".model D_SB_SIGNAL D(Is=2.52n N=1.752 Rs=0.568 Cjo=4p M=0.4 tt=20n BV=100 IBV=100u)"),
  kicad: { symbol: "Device:D", footprint: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal", pinMap: diodeMap },
};

export const diodeRectifier: ComponentDef = {
  id: "diode_rectifier", name: "Rectifier Diode (1N4007-like)", category: "Semiconductors", refPrefix: "D",
  description: "General-purpose 1 A silicon rectifier diode for power supplies (1N400x class). K left, A right.",
  keywords: ["1n4007", "1n4001", "power diode", "bridge", "rectifier"],
  pins: diodePins,
  symbol: diodeBody(),
  ...currentRating("1", "1N400x class: 1 A average"),
  provenance: "generic",
  accuracyNote: "Typical 1N400x-class values in the style of common public models (Is≈7n, N≈1.8, Rs≈34m, BV=1000); not checked against a manufacturer file. Reverse recovery is approximate." + importNote,
  spice: (c) => diodeSpice(c, "D_SB_RECT", () => ".model D_SB_RECT D(Is=7.03n Rs=0.0341 N=1.81 Cjo=10p M=0.33 Vj=0.7 tt=4u BV=1000 IBV=5u)"),
  kicad: { symbol: "Device:D", footprint: "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal", pinMap: diodeMap },
};

/** Typical forward voltage of common 5 mm LEDs at their rated current. */
export const LED_COLORS: Record<string, number> = {
  red: 1.9, orange: 2.0, yellow: 2.05, green: 3.0, "green (old GaP)": 2.1, blue: 3.1, white: 3.1, infrared: 1.2,
};

export const led: ComponentDef = {
  id: "led", name: "LED", category: "Semiconductors", refPrefix: "D",
  description: "Light-emitting diode. Choose a color preset for a typical forward voltage, or enter Vf yourself. Always use a series resistor. K left, A right.",
  keywords: ["light", "indicator", "lamp", "led"],
  pins: diodePins,
  symbol: [...diodeBody(), line(-0.2, -1.6, 0.8, -2.6), poly([[0.4, -2.6], [0.8, -2.6], [0.8, -2.2]]), line(0.8, -1.4, 1.8, -2.4), poly([[1.4, -2.4], [1.8, -2.4], [1.8, -2]])],
  props: [
    { key: "color", label: "Color", kind: "select", default: "red", options: Object.keys(LED_COLORS) },
    { key: "vf", label: "Forward voltage", kind: "text", unit: "V", default: "", help: "Leave blank to use the color's typical value.", model: true },
    modelProp("if", "At current", "20m", "A", "Current at which the forward voltage is specified."),
    modelProp("rs", "Series resistance", "8", "Ω", "Dynamic resistance of the die and leads."),
    ratingProp("imax", "Max current", "30m", "A", "Absolute maximum forward current (typical 5 mm LEDs: 20 mA continuous, 30-50 mA absolute)."),
  ],
  provenance: "generic",
  ratings: [{ kind: "current", prop: "imax", default: 0.03 }],
  accuracyNote: "Shockley diode (N=2) fitted so that V = Vf at the given current; typical values for 5 mm LEDs, real parts vary ±0.2 V. Light output, color shift and reverse breakdown (≈5 V) are approximate.",
  spice: (c) => {
    const vfRaw = c.str("vf").trim();
    const vf = vfRaw ? c.num("vf") : LED_COLORS[c.str("color")] ?? LED_COLORS.red;
    const i = c.num("if"), rs = c.num("rs");
    const nN = 2, vt = 0.025852;
    const is = i / Math.exp(Math.max(0.1, vf - i * rs) / (nN * vt));
    const card = `Is=${sn(is)} N=${nN} Rs=${sn(rs)} Cjo=30p BV=5 IBV=10u`;
    const name = hashName("D_SB_LED", card);
    return diodeSpice(c, name, () => `.model ${name} D(${card})`);
  },
  kicad: { symbol: "Device:LED", footprint: "LED_THT:LED_D5.0mm", pinMap: diodeMap },
  // Glow on the schematic from the simulated forward current (anode to cathode) vs. the "At current" prop.
  indicator: { kind: "led", currentPin: "A", colorProp: "color", ratedCurrent: 0.02 },
  displayProps: ["color"],
};

export const zener: ComponentDef = {
  id: "zener", name: "Zener Diode", category: "Semiconductors", refPrefix: "D",
  description: "Zener diode for voltage references and regulators. In reverse (K more positive than A) it holds about Vz once the current exceeds a few mA. K left, A right.",
  keywords: ["zener", "regulator", "reference", "breakdown", "1n47", "bzx"],
  pins: diodePins,
  symbol: [{ kind: "line", x1: -3, y1: 0, x2: 3, y2: 0 }, poly([[1, -1.2], [1, 1.2], [-1, 0]], true, true), poly([[-1.5, -1.6], [-1, -1.2], [-1, 1.2], [-0.5, 1.6]])],
  props: [
    { key: "vz", label: "Zener voltage", kind: "number", unit: "V", default: "5.1", min: 0 },
    modelProp("izt", "Test current", "5m", "A", "Current at which Vz is specified."),
    modelProp("rz", "Dynamic resistance", "5", "Ω", "Slope of the breakdown region (datasheet Zzt)."),
    ratingProp("pmax", "Power rating", "0.5", "W", "Power the zener can dissipate (½ W for common DO-35 parts)."),
  ],
  ratings: [{ kind: "power", prop: "pmax", default: 0.5 }],
  provenance: "generic",
  accuracyNote: "Generic SPICE diode with breakdown set so V = Vz at the test current, plus series resistance Rz. Temperature coefficient and the soft knee of low-voltage Zeners are not modeled." + importNote,
  spice: (c) => {
    const vz = c.num("vz"), izt = c.num("izt"), rz = c.num("rz");
    const card = `Is=1n N=1 Rs=${sn(rz)} BV=${sn(Math.max(0.1, vz - izt * rz))} IBV=${sn(izt)} Cjo=100p`;
    const name = hashName("D_SB_ZENER", card);
    return diodeSpice(c, name, () => `.model ${name} D(${card})`);
  },
  kicad: { symbol: "Device:D_Zener", footprint: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal", pinMap: diodeMap },
  displayProps: ["vz"],
};

export const schottky: ComponentDef = {
  id: "schottky", name: "Schottky Diode", category: "Semiconductors", refPrefix: "D",
  description: "Schottky diode: low forward voltage (~0.2-0.4 V) and fast switching, higher leakage. 1N5819 class. K left, A right.",
  keywords: ["schottky", "1n5819", "1n5817", "low drop", "fast"],
  pins: diodePins,
  symbol: [{ kind: "line", x1: -3, y1: 0, x2: 3, y2: 0 }, poly([[1, -1.2], [1, 1.2], [-1, 0]], true, true), poly([[-1.6, -0.8], [-1.6, -1.2], [-1, -1.2], [-1, 1.2], [-0.4, 1.2], [-0.4, 0.8]])],
  ...currentRating("1", "1N5819 class: 1 A average"),
  provenance: "generic",
  accuracyNote: "Generic 1 A, 40 V Schottky parameters (Is=3µ, N=1.06, Rs=70m); not a manufacturer's model." + importNote,
  spice: (c) => diodeSpice(c, "D_SB_SCHOTTKY", () => ".model D_SB_SCHOTTKY D(Is=3u N=1.06 Rs=0.07 Cjo=110p M=0.35 Vj=0.35 BV=40 IBV=1m EG=0.69)"),
  kicad: { symbol: "Device:D_Schottky", footprint: "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal", pinMap: diodeMap },
};

for (const d of [diode, diodeRectifier, led, zener, schottky]) modelSlot(d.id, ["D"]);

// ---------------------------------------------------------------- BJTs

const bjtPins: PinDef[] = [{ id: "B", name: "B", x: -4, y: 0 }, { id: "C", name: "C", x: 2, y: -4 }, { id: "E", name: "E", x: 2, y: 4 }];
const bjtBody: Shape[] = [
  circle(0.8, 0, 2.4), line(-4, 0, -0.6, 0), line(-0.6, -1.6, -0.6, 1.6),
  line(-0.6, -0.6, 2, -2), vlead(-2, -4, 2), line(-0.6, 0.6, 2, 2), vlead(2, 4, 2),
];
const npnSymbol: Shape[] = [...bjtBody, poly([[1.1, 1.0], [2, 2], [0.7, 1.9]], true, true)];
const pnpSymbol: Shape[] = [...bjtBody, poly([[0.6, 0.6], [-0.4, 0.7], [0.2, 1.5]], true, true)];

function bjtSpice(ctx: SpiceEmitContext, type: "NPN" | "PNP", builtinName: string, card: () => string): string[] | null {
  const m = chooseModel(ctx, [type], builtinName, () => `.model ${builtinName} ${type}(${card()})`);
  return m && [`${el("Q", ctx)} ${ctx.node("C")} ${ctx.node("B")} ${ctx.node("E")} ${m.name}`];
}

const bjtProps = [
  modelProp("bf", "Current gain (β, hFE)", "100"),
  modelProp("is", "Saturation current Is", "1e-14", "A"),
  modelProp("vaf", "Early voltage", "100", "V"),
];

function genericBjt(type: "NPN" | "PNP"): ComponentDef {
  const id = type.toLowerCase();
  return {
    id, name: `${type} Transistor (generic)`, category: "Semiconductors", refPrefix: "Q",
    description: `Generic ${type} bipolar transistor with editable β, Is and Early voltage. B on the left, C top, E bottom.`,
    keywords: ["bjt", "transistor", id, "bipolar"],
    pins: bjtPins,
    symbol: type === "NPN" ? npnSymbol : pnpSymbol,
    props: bjtProps,
    provenance: "generic",
    accuracyNote: "Gummel-Poon model with textbook parameters (β, Is, VAF from the properties; small junction capacitances). Not a specific part number. You can assign an imported .model instead.",
    spice: (c) => {
      const card = `${params(c, { Is: "is", Bf: "bf", Vaf: "vaf" })} Br=1 Rb=10 Rc=1 Re=0.5 Cje=10p Cjc=5p Tf=0.5n Tr=50n`;
      return bjtSpice(c, type, hashName(`Q_SB_${type}`, card), () => card);
    },
    // Q_*_EBC pin numbering matches the TO-92 inline footprint (1=E, 2=B, 3=C).
    kicad: { symbol: `Transistor_BJT:Q_${type}_EBC`, footprint: "Package_TO_SOT_THT:TO-92_Inline", pinMap: { E: "1", B: "2", C: "3" } },
    displayProps: ["bf"],
  };
}

function namedBjt(part: string, type: "NPN" | "PNP", card: string, desc: string, pinMap: Record<string, string>, note: string): ComponentDef {
  return {
    id: part.toLowerCase(), name: `${part}-like ${type}`, category: "Semiconductors", refPrefix: "Q",
    description: desc,
    keywords: ["bjt", "transistor", type.toLowerCase(), part.toLowerCase()],
    pins: bjtPins,
    symbol: type === "NPN" ? npnSymbol : pnpSymbol,
    props: [],
    provenance: "generic",
    accuracyNote: `${note} Not checked against a manufacturer's file, hence "-like"; import the vendor .model when you need that part's exact behavior.`,
    spice: (c) => bjtSpice(c, type, `Q_SB_${part}`, () => card),
    kicad: { symbol: `Transistor_BJT:${part}`, footprint: "Package_TO_SOT_THT:TO-92_Inline", pinMap },
  };
}

export const npn = genericBjt("NPN");
export const pnp = genericBjt("PNP");
export const q2n3904 = namedBjt("2N3904", "NPN",
  "Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10",
  "General-purpose small-signal NPN (40 V, 200 mA). B left, C top, E bottom.", { E: "1", B: "2", C: "3" },
  "Typical Gummel-Poon values for the 2N3904 in the style of common public SPICE models.");
export const q2n3906 = namedBjt("2N3906", "PNP",
  "Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.42n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10",
  "General-purpose small-signal PNP (40 V, 200 mA), complement of the 2N3904. B left, C top, E bottom.", { E: "1", B: "2", C: "3" },
  "Typical Gummel-Poon values for the 2N3906 in the style of common public SPICE models.");
export const bc547 = namedBjt("BC547", "NPN",
  "Is=2.39e-14 Nf=1.008 Ise=3.545e-15 Ne=1.541 Bf=294.3 Ikf=0.1357 Vaf=63.2 Nr=1.004 Isc=6.272e-14 Nc=1.243 Br=7.946 Ikr=0.1144 Var=25.9 Rb=1 Irb=1e-6 Rbm=1 Re=0.4683 Rc=0.85 Xtb=0 Eg=1.11 Xti=3 Cje=1.358e-11 Vje=0.65 Mje=0.3279 Tf=4.391e-10 Xtf=120 Vtf=2.643 Itf=0.7495 Ptf=0 Cjc=3.728e-12 Vjc=0.3997 Mjc=0.2955 Xcjc=0.6193 Tr=1e-32 Cjs=0 Vjs=0.75 Mjs=0.333 Fc=0.9579",
  "European general-purpose NPN (45 V, 100 mA), B gain group. Note the C-B-E pinout. B left, C top, E bottom.", { C: "1", B: "2", E: "3" },
  "Typical Gummel-Poon values for the BC547B in the style of common public SPICE models.");
export const bc557 = namedBjt("BC557", "PNP",
  "Is=3.83e-14 Nf=1.008 Ise=1.22e-14 Ne=1.528 Bf=344.4 Ikf=0.08039 Vaf=21.11 Nr=1.005 Isc=2.85e-13 Nc=1.28 Br=14.84 Ikr=0.047 Var=32.02 Rb=1 Irb=1e-6 Rbm=1 Re=0.6202 Rc=0.5713 Xtb=0 Eg=1.11 Xti=3 Cje=1.23e-11 Vje=0.6106 Mje=0.378 Tf=5.6e-10 Xtf=3.414 Vtf=5.23 Itf=0.1483 Ptf=0 Cjc=1.08e-11 Vjc=0.1022 Mjc=0.3563 Xcjc=0.6288 Tr=1e-32 Cjs=0 Vjs=0.75 Mjs=0.333 Fc=0.8027",
  "European general-purpose PNP (45 V, 100 mA), complement of the BC547. B left, C top, E bottom.", { C: "1", B: "2", E: "3" },
  "Typical Gummel-Poon values for the BC557B in the style of common public SPICE models.");

for (const d of [npn, q2n3904, bc547]) modelSlot(d.id, ["NPN"]);
for (const d of [pnp, q2n3906, bc557]) modelSlot(d.id, ["PNP"]);

// ---------------------------------------------------------------- MOSFETs

const mosPins: PinDef[] = [{ id: "G", name: "G", x: -4, y: 0 }, { id: "D", name: "D", x: 2, y: -4 }, { id: "S", name: "S", x: 2, y: 4 }];
const mosBody: Shape[] = [
  circle(0.8, 0, 2.4), line(-4, 0, -1, 0), line(-1, -1.4, -1, 1.4),
  line(-0.4, -1.6, -0.4, -0.9), line(-0.4, -0.35, -0.4, 0.35), line(-0.4, 0.9, -0.4, 1.6),
  line(-0.4, -1.2, 2, -1.2), vlead(-1.2, -4, 2), line(-0.4, 1.2, 2, 1.2), vlead(1.2, 4, 2), line(-0.4, 0, 2, 0), vlead(0, 1.2, 2),
];
const nmosSymbol: Shape[] = [...mosBody, poly([[-0.3, 0], [0.5, -0.4], [0.5, 0.4]], true, true)];
const pmosSymbol: Shape[] = [...mosBody, poly([[1.2, 0], [0.4, -0.4], [0.4, 0.4]], true, true)];

function mosSpice(ctx: SpiceEmitContext, type: "NMOS" | "PMOS", builtinName: string, card: () => string): string[] | null {
  const m = chooseModel(ctx, [type], builtinName, () => `.model ${builtinName} ${type}(${card()})`);
  if (!m) return null;
  const d = ctx.node("D"), g = ctx.node("G"), s = ctx.node("S");
  // VDMOS power-MOSFET models are three-terminal; level 1-3 models get bulk tied to source.
  return [m.type === "VDMOS" ? `${el("M", ctx)} ${d} ${g} ${s} ${m.name}` : `${el("M", ctx)} ${d} ${g} ${s} ${s} ${m.name} L=1 W=1`];
}

function genericMos(type: "NMOS" | "PMOS"): ComponentDef {
  const id = type.toLowerCase();
  const p = type === "PMOS";
  return {
    id, name: `${p ? "P" : "N"}-channel MOSFET (generic)`, category: "Semiconductors", refPrefix: "Q",
    description: `Generic enhancement-mode ${p ? "P" : "N"}-channel MOSFET with editable threshold and transconductance. G left, D top, S bottom; body tied to source.`,
    keywords: ["mosfet", "fet", id, "transistor", "switch"],
    pins: mosPins,
    symbol: p ? pmosSymbol : nmosSymbol,
    props: [
      modelProp("vto", "Threshold voltage", p ? "-2" : "2", "V"),
      modelProp("kp", "Transconductance K", "0.1", "A/V²", "Id = K/2·(Vgs−Vth)² in saturation."),
      modelProp("lambda", "Channel-length modulation λ", "0.01", "1/V"),
    ],
    provenance: "generic",
    accuracyNote: "SPICE level-1 (square-law) model with the given Vth, K and λ, fixed 20 pF/5 pF gate capacitances and the intrinsic body diode. Fine for switching and biasing intuition, not for precise analog design.",
    dcPaths: [["D", "S"]],
    spice: (c) => {
      const card = `Level=1 ${params(c, { Vto: "vto", Kp: "kp", Lambda: "lambda" })} Rd=0.05 Rs=0.05 Cgso=20p Cgdo=5p`;
      return mosSpice(c, type, hashName(`M_SB_${type}`, card), () => card);
    },
    kicad: { symbol: `Transistor_FET:Q_${type}_GDS`, footprint: "Package_TO_SOT_THT:TO-92_Inline", pinMap: { G: "1", D: "2", S: "3" } },
    displayProps: ["vto"],
  };
}

function namedMos(part: string, type: "NMOS" | "PMOS", card: string, desc: string, pinMap: Record<string, string>, note: string): ComponentDef {
  return {
    id: part.toLowerCase(), name: `${part}-like ${type === "PMOS" ? "P" : "N"}-MOSFET`, category: "Semiconductors", refPrefix: "Q",
    description: desc,
    keywords: ["mosfet", "fet", type.toLowerCase(), part.toLowerCase()],
    pins: mosPins,
    symbol: type === "PMOS" ? pmosSymbol : nmosSymbol,
    props: [],
    provenance: "generic",
    accuracyNote: `${note} This is a SparkBench fit, not the manufacturer's model; import the vendor .model for fidelity.`,
    dcPaths: [["D", "S"]],
    spice: (c) => mosSpice(c, type, `M_SB_${part}`, () => card),
    kicad: { symbol: `Transistor_FET:${part}`, footprint: "Package_TO_SOT_THT:TO-92_Inline", pinMap },
  };
}

export const nmos = genericMos("NMOS");
export const pmos = genericMos("PMOS");
export const m2n7000 = namedMos("2N7000", "NMOS", "Level=1 Vto=2.1 Kp=0.12 Lambda=0.02 Rd=0.2 Rs=0.2 Cgso=25p Cgdo=8p",
  "Small-signal N-channel MOSFET (60 V, 200 mA), logic-level-ish switch. G left, D top, S bottom.", { S: "1", G: "2", D: "3" },
  "Level-1 fit to datasheet typicals: Vgs(th) ≈ 2.1 V, Rds(on) ≈ 1.2-1.8 Ω at Vgs = 10 V, Ciss ≈ 30 pF.");
export const bs250 = namedMos("BS250", "PMOS", "Level=1 Vto=-2.4 Kp=0.01 Lambda=0.02 Rd=1 Rs=1 Cgso=40p Cgdo=10p",
  "Small-signal P-channel MOSFET (−45 V, −250 mA). G left, D top, S bottom.", { D: "1", G: "2", S: "3" },
  "Level-1 fit to datasheet typicals: Vgs(th) ≈ −2.4 V, Rds(on) ≈ 14 Ω at Vgs = −10 V.");

for (const d of [nmos, m2n7000]) modelSlot(d.id, ["NMOS"]);
for (const d of [pmos, bs250]) modelSlot(d.id, ["PMOS"]);

export const semiconductorParts: ComponentDef[] = [diode, diodeRectifier, led, zener, schottky, npn, pnp, q2n3904, q2n3906, bc547, bc557, nmos, pmos, m2n7000, bs250];
