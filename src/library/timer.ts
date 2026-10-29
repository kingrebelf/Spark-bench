// 555 timer as a behavioral analog subcircuit.
import type { ComponentDef } from "../core/types";
import { el, hlead, modelProp, rect, sn, step, text, vlead } from "./util";

const VCC = "V(vcc,gnd)";
const s = (x: string) => step(x, 0.01); // 10 mV comparator transition
const Q = s(`V(q,gnd)-${VCC}/2`);

// Priorities as in the datasheet's function table: RESET low wins, then TRIGGER < VCC/3 sets,
// then THRESHOLD > 2/3 VCC resets, otherwise the latch holds. At the DC operating point (time = 0)
// the latch is held reset, like a 555 powering up: discharge on, timing capacitor empty.
const SUBCKT = [
  ".subckt SB_555 gnd trig out rst thres disch vcc params: vdrop=1.7 ron=10 rdis=10 iq=3m",
  "* SparkBench behavioral 555: comparators at VCC/3 and 2VCC/3, SR latch, discharge switch, output stage.",
  "Rq vcc gnd {5/iq}",
  "Rt trig gnd 100meg",
  "Rh thres gnd 100meg",
  "Rr rst gnd 100meg",
  `Bl gnd q I = 1m*((time > 0 ? 1 : 0)*${s("V(rst,gnd)-0.7")}*(${s(`${VCC}/3-V(trig,gnd)`)}*${VCC}+(1-${s(`${VCC}/3-V(trig,gnd)`)})*(1-${s(`V(thres,gnd)-2*${VCC}/3`)})*${VCC}*${Q})-V(q,gnd))`,
  "Cl q gnd 1p",
  "Rl q gnd 1g",
  `Bd disch gnd I = (1-${Q})*V(disch,gnd)/{rdis}`,
  "Rdo disch gnd 100meg",
  `Bo oi gnd V = ${Q}*max(${VCC}-{vdrop},0)`,
  "Ro oi out {ron}",
  ".ends SB_555",
].join("\n");

export const timer555: ComponentDef = {
  id: "timer555", name: "555 Timer", category: "Timers", refPrefix: "U",
  description: "555 timer for astable (oscillator) and monostable (one-shot) circuits. Astable: f ≈ 1.44 / ((R1 + 2·R2)·C). Monostable: T ≈ 1.1·R·C. Tie ~RESET to VCC when unused. The control-voltage pin (5) is internal (VCC/3 and 2·VCC/3 thresholds) and not brought out.",
  keywords: ["555", "ne555", "timer", "oscillator", "astable", "monostable", "blinker", "one shot"],
  pins: [
    { id: "GND", name: "GND", x: 0, y: 8 }, { id: "TRIG", name: "TRIG", x: -8, y: 4 },
    { id: "OUT", name: "OUT", x: 8, y: 0 }, { id: "RST", name: "~RESET", x: -8, y: -4 },
    { id: "THR", name: "THRES", x: -8, y: 2 }, { id: "DIS", name: "DISCH", x: -8, y: -2 },
    { id: "VCC", name: "VCC", x: 2, y: -8 },
  ],
  symbol: [
    rect(-5, -5, 10, 10),
    hlead(-8, -5, 4), hlead(-8, -5, 2), hlead(-8, -5, -2), hlead(-8, -5, -4), hlead(5, 8, 0),
    vlead(5, 8, 0), vlead(-8, -5, 2),
    text(-4.6, 4, "TR", 0.9, "start"), text(-4.6, 2, "THR", 0.9, "start"), text(-4.6, -2, "DIS", 0.9, "start"), text(-4.6, -4, "~R", 0.9, "start"),
    text(4.6, 0, "Q", 0.9, "end"), text(2, -4.2, "VCC", 0.7, "middle"), text(0, 4.2, "GND", 0.7, "middle"), text(0, 0, "555", 1.2, "middle"),
  ],
  props: [
    modelProp("vdrop", "Output high drop", "1.7", "V", "Output high = VCC − drop. NE555 (bipolar) ≈ 1.7 V; CMOS versions (TLC555, LMC555) ≈ 0.1 V."),
    modelProp("ron", "Output resistance", "10", "Ω"),
    modelProp("iq", "Supply current", "3m", "A", "Quiescent current at 5 V (scales with VCC)."),
  ],
  provenance: "behavioral",
  accuracyNote: "Behavioral model: ideal comparators at exactly VCC/3 and 2·VCC/3, an SR latch with datasheet priorities (reset > trigger > threshold), a 10 Ω discharge switch and an output stage with a fixed high-level drop. Timing follows the ideal formulas (ln 2 / ln 3); real parts add ~1-5 % error and a few hundred ns of delay. Output current is not drawn from VCC; the control pin is not available.",
  analyses: { ac: false },
  dcPaths: [["VCC", "GND"], ["OUT", "GND"], ["DIS", "GND"], ["TRIG", "GND"], ["THR", "GND"], ["RST", "GND"]],
  spice: (c) => {
    c.define("subckt:SB_555", SUBCKT);
    const nodes = ["GND", "TRIG", "OUT", "RST", "THR", "DIS", "VCC"].map((p) => c.node(p)).join(" ");
    return [`${el("X", c)} ${nodes} SB_555 vdrop=${sn(c.num("vdrop"))} ron=${sn(c.num("ron"))} iq=${sn(c.num("iq"))}`];
  },
  kicad: { symbol: "Timer:NE555P", footprint: "Package_DIP:DIP-8_W7.62mm", pinMap: { GND: "1", TRIG: "2", OUT: "3", RST: "4", THR: "6", DIS: "7", VCC: "8" } },
};

export const timerParts: ComponentDef[] = [timer555];
