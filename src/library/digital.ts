// Digital logic as behavioral analog subcircuits (ngspice-WASM has no XSPICE digital models).
// Every part has real VCC/GND pins; logic levels and thresholds scale with V(VCC) − V(GND).
//
// Building blocks (all smooth, so Newton converges):
//  - input level:  0.5·(1 + tanh((V(in) − VCC/2) / 50 mV))
//  - delay:        ideal logic value → 1 kΩ/C low-pass (C set so the 50 % crossing is at td) → regenerating buffer
//  - storage:      a 1 pF node driven toward its data while transparent and left floating (pure capacitor)
//                  while holding (see store()). Edge-triggered flip-flops are master-slave pairs.
import type { ComponentDef, Shape, SpiceEmitContext } from "../core/types";
import { circle, el, hlead, line, lvl, modelProp, poly, rect, sn, step, text, vlead } from "./util";

const delayProps = [
  modelProp("td", "Propagation delay", "10n", "s", "Input change to output 50 % crossing."),
  modelProp("rout", "Output resistance", "50", "Ω"),
];
const digitalNote = (what: string) =>
  `Behavioral analog model of ${what}: ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC).`;

const VCC = "V(vcc,gnd)";
/**
 * Clock level for master/slave latches with non-overlapping thresholds: "hi" is 1 above 60 % of
 * VCC, "lo" is 1 below 40 %. Between them both latches hold, so a slow edge can't race.
 */
const clkHi = (node: string) => step(`V(${node},gnd)-0.6*${VCC}`);
const clkLo = (node: string) => step(`0.4*${VCC}-V(${node},gnd)`);

function header(name: string, pins: string[], inputs: string[]): string[] {
  return [
    `.subckt ${name} ${pins.join(" ")} params: td=10n rout=50`,
    `* SparkBench behavioral logic (see src/library/digital.ts)`,
    `Rq vcc gnd 1meg`,
    ...inputs.map((i) => `Rin_${i} ${i} gnd 100meg`),
  ];
}

/** Delay + regenerate an internal 0..VCC node `src` onto output pin `pin` (inverted if `inv`). */
function outStage(src: string, pin: string, inv = false): string[] {
  const lv = lvl(`dl_${pin}`);
  return [
    `Bx_${pin} x_${pin} gnd V = V(${src},gnd)`,
    `Rd_${pin} x_${pin} dl_${pin} 1k`,
    `Cd_${pin} dl_${pin} gnd {max(td,1e-12)/0.693/1000}`,
    `Bo_${pin} oi_${pin} gnd V = ${VCC}*${inv ? `(1-${lv})` : lv}`,
    `Ro_${pin} oi_${pin} ${pin} {rout}`,
  ];
}

interface StoreDrive {
  /** 0..1: how transparent the node is to `data` (1 = follows data, 0 = holds). */
  sel: string;
  /** Value to follow when transparent (volts). */
  data: string;
  /** 0..1 asynchronous set / clear (set wins). */
  set?: string;
  clr?: string;
  /** Value at the DC operating point (time = 0), so every run starts from a defined state. */
  init?: string;
}

/**
 * Storage node: a 1 pF capacitor driven by 1 mS toward its data while transparent, and by
 * (almost) nothing while holding, so it keeps its value however large the simulator's time
 * step is. A 1 nS regenerative term pulls a held value back to the nearest rail over ~1 ms.
 */
function store(node: string, d: StoreDrive): string[] {
  const v = `V(${node},gnd)`;
  const set = d.set ?? "0", clr = d.clr ?? "0";
  const drive = `${set}*(${VCC}-${v})+(1-${set})*(${clr}*(0-${v})+(1-${clr})*${d.sel}*((${d.data})-${v}))`;
  return [
    `Bs_${node} gnd ${node} I = time > 0 ? 1m*(${drive})+1n*(${VCC}*${lvl(node)}-${v}) : 1m*((${d.init ?? "0"})-${v})`,
    `Cs_${node} ${node} gnd 1p`,
  ];
}

function instance(ctx: SpiceEmitContext, subckt: string, text: string, pinOrder: string[]): string[] {
  ctx.define(`subckt:${subckt}`, text);
  const td = Math.max(1e-12, ctx.num("td"));
  return [`${el("X", ctx)} ${pinOrder.map((p) => ctx.node(p)).join(" ")} ${subckt} td=${sn(td)} rout=${sn(ctx.num("rout"))}`];
}

const dc = (inputs: string[], outputs: string[]): [string, string][] =>
  [["VCC", "GND"], ...inputs.map((p): [string, string] => [p, "GND"]), ...outputs.map((p): [string, string] => [p, "GND"])];

// ---------------------------------------------------------------- gates

type GateKind = "AND" | "NAND" | "OR" | "NOR" | "XOR";
const GATE_FN: Record<GateKind, (a: string, b: string) => string> = {
  AND: (a, b) => `${a}*${b}`,
  NAND: (a, b) => `(1-${a}*${b})`,
  OR: (a, b) => `(1-(1-${a})*(1-${b}))`,
  NOR: (a, b) => `((1-${a})*(1-${b}))`,
  XOR: (a, b) => `(${a}+${b}-2*${a}*${b})`,
};
const GATE_INFO: Record<GateKind, { kicad: string; truth: string; kw: string[] }> = {
  AND: { kicad: "74AHC1G08", truth: "Y = A·B (high only when both inputs are high)", kw: ["and", "7408"] },
  NAND: { kicad: "74AHC1G00", truth: "Y = NOT(A·B) (low only when both inputs are high)", kw: ["nand", "7400"] },
  OR: { kicad: "74AHC1G32", truth: "Y = A + B (high when either input is high)", kw: ["or", "7432"] },
  NOR: { kicad: "74AHC1G02", truth: "Y = NOT(A + B) (high only when both inputs are low)", kw: ["nor", "7402"] },
  XOR: { kicad: "74AHC1G86", truth: "Y = A ⊕ B (high when the inputs differ)", kw: ["xor", "exclusive or", "7486"] },
};

const powerLeads = (x: number, top: number, bottom: number, yTop: number, yBottom: number): Shape[] => [
  vlead(-yTop, -top, x), vlead(yBottom, bottom, x),
  text(x + 0.4, -yTop + 0.8, "VCC", 0.7, "start"), text(x + 0.4, yBottom - 0.8, "GND", 0.7, "start"),
];

function gateSymbol(kind: GateKind): Shape[] {
  const bubble = kind === "NAND" || kind === "NOR";
  const isOr = kind === "OR" || kind === "NOR" || kind === "XOR";
  const body: Shape[] = isOr
    ? [
        { kind: "arc", x1: -5, y1: -4, x2: -5, y2: 4, r: 6, sweep: true },
        { kind: "arc", x1: -5, y1: -4, x2: 4, y2: 0, r: 8, sweep: true },
        { kind: "arc", x1: 4, y1: 0, x2: -5, y2: 4, r: 8, sweep: true },
        ...(kind === "XOR" ? [{ kind: "arc" as const, x1: -6, y1: -4, x2: -6, y2: 4, r: 6, sweep: true }] : []),
      ]
    : [poly([[0, -4], [-5, -4], [-5, 4], [0, 4]]), { kind: "arc", x1: 0, y1: -4, x2: 0, y2: 4, r: 4, sweep: true }];
  const inEnd = isOr ? -4.4 : -5;
  return [
    ...body,
    hlead(-12, inEnd, -2), hlead(-12, inEnd, 2),
    ...(bubble ? [circle(4.5, 0, 0.5), hlead(5, 10)] : [hlead(4, 10)]),
    ...powerLeads(0, 8, 8, isOr ? 3.4 : 4, isOr ? 3.4 : 4),
  ];
}

function gate(kind: GateKind): ComponentDef {
  const info = GATE_INFO[kind];
  const sub = `SB_${kind}2`;
  const body = [
    ...header(sub, ["a", "b", "y", "vcc", "gnd"], ["a", "b"]),
    `Bf f gnd V = ${VCC}*${GATE_FN[kind](lvl("a"), lvl("b"))}`,
    ...outStage("f", "y"),
    `.ends ${sub}`,
  ].join("\n");
  return {
    id: `gate_${kind.toLowerCase()}`, name: `${kind} Gate`, category: "Digital", refPrefix: "U",
    description: `Two-input ${kind} gate: ${info.truth}. Power it through VCC and GND (e.g. 5 V).`,
    keywords: ["logic", "gate", ...info.kw],
    pins: [
      { id: "A", name: "A", x: -12, y: -2 }, { id: "B", name: "B", x: -12, y: 2 }, { id: "Y", name: "Y", x: 10, y: 0 },
      { id: "VCC", name: "VCC", x: 0, y: -8 }, { id: "GND", name: "GND", x: 0, y: 8 },
    ],
    symbol: gateSymbol(kind),
    props: delayProps,
    provenance: "behavioral",
    accuracyNote: digitalNote(`a ${kind} gate`),
    analyses: { ac: false },
    dcPaths: dc(["A", "B"], ["Y"]),
    spice: (c) => instance(c, sub, body, ["A", "B", "Y", "VCC", "GND"]),
    kicad: { symbol: `74xGxx:${info.kicad}`, footprint: "Package_TO_SOT_SMD:SOT-23-5", pinMap: { A: "1", B: "2", GND: "3", Y: "4", VCC: "5" } },
  };
}

const NOT_SUBCKT = [
  ...header("SB_NOT", ["a", "y", "vcc", "gnd"], ["a"]),
  `Bf f gnd V = ${VCC}*(1-${lvl("a")})`,
  ...outStage("f", "y"),
  `.ends SB_NOT`,
].join("\n");

export const gateNot: ComponentDef = {
  id: "gate_not", name: "NOT Gate (Inverter)", category: "Digital", refPrefix: "U",
  description: "Inverter: Y = NOT A. Power it through VCC and GND (e.g. 5 V).",
  keywords: ["logic", "gate", "not", "inverter", "7404"],
  pins: [{ id: "A", name: "A", x: -12, y: 0 }, { id: "Y", name: "Y", x: 10, y: 0 }, { id: "VCC", name: "VCC", x: -4, y: -8 }, { id: "GND", name: "GND", x: -4, y: 8 }],
  symbol: [poly([[-5, -3.5], [-5, 3.5], [3, 0]], true), circle(3.5, 0, 0.5), hlead(-12, -5), hlead(4, 10), ...powerLeads(-4, 8, 8, 3.1, 3.1)],
  props: delayProps,
  provenance: "behavioral",
  accuracyNote: digitalNote("an inverter"),
  analyses: { ac: false },
  dcPaths: dc(["A"], ["Y"]),
  spice: (c) => instance(c, "SB_NOT", NOT_SUBCKT, ["A", "Y", "VCC", "GND"]),
  // 74xGxx inverters have pin 1 = NC.
  kicad: { symbol: "74xGxx:74AHC1G04", footprint: "Package_TO_SOT_SMD:SOT-23-5", pinMap: { A: "2", GND: "3", Y: "4", VCC: "5" } },
};

export const gates: ComponentDef[] = [gate("AND"), gate("NAND"), gate("OR"), gate("NOR"), gate("XOR")];

// ---------------------------------------------------------------- flip-flops

const DFF_SUBCKT = (() => {
  const pr = `(1-${lvl("pre")})`, cl = `(1-${lvl("clr")})`;
  return [
    ...header("SB_DFF", ["d", "c", "q", "qn", "pre", "clr", "vcc", "gnd"], ["d", "c", "pre", "clr"]),
    // Master is transparent while the clock is low, slave while it is high: Q takes D at the rising edge.
    ...store("m", { sel: clkLo("c"), data: `${VCC}*${lvl("d")}`, set: pr, clr: cl, init: `${VCC}*${pr}` }),
    ...store("sl", { sel: clkHi("c"), data: `${VCC}*${lvl("m")}`, set: pr, clr: cl, init: `${VCC}*${pr}` }),
    ...outStage("sl", "q"), ...outStage("sl", "qn", true),
    `.ends SB_DFF`,
  ].join("\n");
})();

const boxLabel = (x: number, y: number, t: string, anchor: "start" | "end" | "middle") => text(x, y, t, 0.9, anchor);
const clockMark = (x: number, y: number): Shape => poly([[x, y - 0.6], [x + 0.9, y], [x, y + 0.6]]);

export const dFlipFlop: ComponentDef = {
  id: "dff", name: "D Flip-Flop", category: "Digital", refPrefix: "U",
  description: "Rising-edge D flip-flop with active-low preset and clear (74x74 style). On each rising CLK edge Q takes the value of D. Tie ~PRE and ~CLR to VCC when unused. Starts with Q = 0.",
  keywords: ["flip flop", "flipflop", "register", "latch", "7474", "d type"],
  pins: [
    { id: "D", name: "D", x: -10, y: -4 }, { id: "C", name: "CLK", x: -10, y: 4 },
    { id: "Q", name: "Q", x: 10, y: -4 }, { id: "QN", name: "~Q", x: 10, y: 4 },
    { id: "PRE", name: "~PRE", x: -2, y: -10 }, { id: "CLR", name: "~CLR", x: -2, y: 10 },
    { id: "VCC", name: "VCC", x: 2, y: -10 }, { id: "GND", name: "GND", x: 2, y: 10 },
  ],
  symbol: [
    rect(-6, -7, 12, 14),
    hlead(-10, -6, -4), hlead(-10, -6, 4), hlead(6, 10, -4), hlead(6, 10, 4),
    vlead(-10, -7, -2), vlead(7, 10, -2), vlead(-10, -7, 2), vlead(7, 10, 2),
    boxLabel(-5.4, -4, "D", "start"), clockMark(-6, 4), boxLabel(-4.6, 4, "C", "start"),
    boxLabel(5.4, -4, "Q", "end"), boxLabel(5.4, 4, "~Q", "end"),
    boxLabel(-2, -6, "~PRE", "middle"), boxLabel(-2, 6, "~CLR", "middle"),
    text(2.4, -9, "VCC", 0.7, "start"), text(2.4, 9, "GND", 0.7, "start"),
  ],
  props: [modelProp("td", "Propagation delay", "15n", "s", "Clock edge to output 50 % crossing."), delayProps[1]],
  provenance: "behavioral",
  accuracyNote: digitalNote("a D flip-flop (master-slave)") + " Setup/hold violations are not flagged; with ~PRE and ~CLR both low the model gives Q = 1 (a real 74x74 drives both Q and ~Q high).",
  analyses: { ac: false },
  dcPaths: dc(["D", "C", "PRE", "CLR"], ["Q", "QN"]),
  spice: (c) => instance(c, "SB_DFF", DFF_SUBCKT, ["D", "C", "Q", "QN", "PRE", "CLR", "VCC", "GND"]),
  kicad: { symbol: "74xGxx:74AUP1G74", footprint: "Package_SO:VSSOP-8_2.3x2mm_P0.5mm", pinMap: { C: "1", D: "2", QN: "3", GND: "4", Q: "5", CLR: "6", PRE: "7", VCC: "8" } },
};

const JK_SUBCKT = (() => {
  const cl = `(1-${lvl("r")})`, ls = lvl("sl");
  const next = `(${lvl("j")}*(1-${ls})+(1-${lvl("k")})*${ls})`;
  return [
    ...header("SB_JKFF", ["j", "k", "c", "q", "qn", "r", "vcc", "gnd"], ["j", "k", "c", "r"]),
    // Master transparent while the clock is high, slave while low: Q updates at the falling edge.
    ...store("m", { sel: clkHi("c"), data: `${VCC}*${next}`, clr: cl }),
    ...store("sl", { sel: clkLo("c"), data: `${VCC}*${lvl("m")}`, clr: cl }),
    ...outStage("sl", "q"), ...outStage("sl", "qn", true),
    `.ends SB_JKFF`,
  ].join("\n");
})();

export const jkFlipFlop: ComponentDef = {
  id: "jkff", name: "JK Flip-Flop", category: "Digital", refPrefix: "U",
  description: "Falling-edge JK flip-flop with active-low clear (74x107 style). At each falling CLK edge: J=K=0 hold, J=1 set, K=1 reset, J=K=1 toggle (use it as a T flip-flop). Tie ~R to VCC when unused. Starts with Q = 0.",
  keywords: ["flip flop", "jk", "toggle", "t flip flop", "74107", "divider"],
  pins: [
    { id: "J", name: "J", x: -6, y: -2 }, { id: "C", name: "CLK", x: -6, y: 0 }, { id: "K", name: "K", x: -6, y: 2 },
    { id: "Q", name: "Q", x: 6, y: -2 }, { id: "QN", name: "~Q", x: 6, y: 2 }, { id: "R", name: "~R", x: 0, y: 6 },
    { id: "VCC", name: "VCC", x: 0, y: -8 }, { id: "GND", name: "GND", x: 0, y: 8 },
  ],
  symbol: [
    rect(-4, -4, 8, 8),
    hlead(-6, -4, -2), hlead(-6, -4.6, 0), circle(-4.3, 0, 0.3), hlead(-6, -4, 2), hlead(4, 6, -2), hlead(4, 6, 2),
    vlead(4, 6, 0), vlead(-8, -4, 0), vlead(7.2, 8, 0), line(-0.5, 7.2, 0.5, 7.2),
    boxLabel(-3.6, -2, "J", "start"), clockMark(-4, 0), boxLabel(-3.6, 2, "K", "start"),
    boxLabel(3.6, -2, "Q", "end"), boxLabel(3.6, 2, "~Q", "end"), boxLabel(0, 3.2, "~R", "middle"),
    text(0.4, -7, "VCC", 0.7, "start"), text(0.8, 7.6, "GND", 0.7, "start"),
  ],
  props: [modelProp("td", "Propagation delay", "15n", "s", "Clock edge to output 50 % crossing."), delayProps[1]],
  provenance: "behavioral",
  accuracyNote: digitalNote("a JK flip-flop (master-slave, edge-triggered)") + " Unlike the original 7473 pulse-triggered part, J and K are sampled only around the falling edge.",
  analyses: { ac: false },
  dcPaths: dc(["J", "K", "C", "R"], ["Q", "QN"]),
  spice: (c) => instance(c, "SB_JKFF", JK_SUBCKT, ["J", "K", "C", "Q", "QN", "R", "VCC", "GND"]),
  kicad: { symbol: "74xx:74LS107", footprint: "Package_DIP:DIP-14_W7.62mm", pinMap: { J: "1", QN: "2", Q: "3", K: "4", C: "12", R: "13", GND: "7", VCC: "14" }, unit: 1, extraUnits: [3] },
};

// ---------------------------------------------------------------- counter

const COUNTER_SUBCKT = (() => {
  const rst = `(${lvl("r1")}*${lvl("r2")})`;
  const clocks = ["cp0", "cp1", "s1", "s2"];
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const ck = clocks[i];
    // Toggle flip-flop: master copies NOT Q while the clock is high; slave copies the master while low.
    lines.push(...store(`m${i}`, { sel: clkHi(ck), data: `${VCC}*(1-${lvl(`s${i}`)})`, clr: rst }));
    lines.push(...store(`s${i}`, { sel: clkLo(ck), data: `${VCC}*${lvl(`m${i}`)}`, clr: rst }));
    lines.push(...outStage(`s${i}`, `q${i}`));
  }
  return [
    ...header("SB_CNT93", ["cp0", "cp1", "r1", "r2", "q0", "q1", "q2", "q3", "vcc", "gnd"], ["cp0", "cp1", "r1", "r2"]),
    ...lines,
    `.ends SB_CNT93`,
  ].join("\n");
})();

export const counter4: ComponentDef = {
  id: "counter4", name: "4-bit Binary Counter", category: "Digital", refPrefix: "U",
  description: "4-bit ripple counter (74x93 style). CP0 clocks Q0; CP1 clocks Q1→Q2→Q3. Wire Q0 to CP1 for a 0-15 counter. Counts on falling clock edges; R0(1)·R0(2) high resets to 0 (tie both to GND to count).",
  keywords: ["counter", "binary", "divider", "7493", "ripple", "4 bit"],
  pins: [
    { id: "CP0", name: "CP0", x: -10, y: -4 }, { id: "CP1", name: "CP1", x: -10, y: -2 },
    { id: "R1", name: "R0(1)", x: -10, y: 2 }, { id: "R2", name: "R0(2)", x: -10, y: 4 },
    { id: "Q0", name: "Q0", x: 10, y: -4 }, { id: "Q1", name: "Q1", x: 10, y: -2 }, { id: "Q2", name: "Q2", x: 10, y: 0 }, { id: "Q3", name: "Q3", x: 10, y: 2 },
    { id: "VCC", name: "VCC", x: 0, y: -10 }, { id: "GND", name: "GND", x: 0, y: 10 },
  ],
  symbol: [
    rect(-6, -7, 12, 14),
    ...[-4, -2, 2, 4].map((y) => hlead(-10, -6, y)), ...[-4, -2, 0, 2].map((y) => hlead(6, 10, y)),
    vlead(-10, -7), vlead(7, 10),
    boxLabel(-4.6, -4, "CP0", "start"), boxLabel(-4.6, -2, "CP1", "start"), clockMark(-6, -4), clockMark(-6, -2),
    boxLabel(-5.4, 2, "R0(1)", "start"), boxLabel(-5.4, 4, "R0(2)", "start"),
    ...[0, 1, 2, 3].map((i) => boxLabel(5.4, -4 + i * 2, `Q${i}`, "end")),
    text(0.4, -9, "VCC", 0.7, "start"), text(0.4, 9, "GND", 0.7, "start"), text(0, -5.6, "CTR4", 0.9, "middle"),
  ],
  props: [modelProp("td", "Propagation delay", "15n", "s", "Clock edge to each output's 50 % crossing (plus ~1 ns per ripple stage)."), delayProps[1]],
  provenance: "behavioral",
  accuracyNote: digitalNote("a 4-bit ripple counter (four toggle flip-flops)") + " The internal ripple adds about 1 ns per stage; real 74LS93 stages add 10-20 ns each.",
  analyses: { ac: false },
  dcPaths: dc(["CP0", "CP1", "R1", "R2"], ["Q0", "Q1", "Q2", "Q3"]),
  spice: (c) => instance(c, "SB_CNT93", COUNTER_SUBCKT, ["CP0", "CP1", "R1", "R2", "Q0", "Q1", "Q2", "Q3", "VCC", "GND"]),
  kicad: { symbol: "74xx:74LS93", footprint: "Package_DIP:DIP-14_W7.62mm", pinMap: { CP1: "1", R1: "2", R2: "3", VCC: "5", Q2: "8", Q1: "9", GND: "10", Q3: "11", Q0: "12", CP0: "14" } },
};

export const digitalParts: ComponentDef[] = [gateNot, ...gates, dFlipFlop, jkFlipFlop, counter4];
