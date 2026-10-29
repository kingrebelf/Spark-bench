// Op-amps and comparators as behavioral macromodels (B-sources): finite gain with a dominant
// pole (GBW), slew-rate limit, output clamped inside the supply rails, output resistance.
import type { ComponentDef, KicadMapping, PinDef, Shape, SpiceEmitContext } from "../core/types";
import { el, hlead, modelProp, poly, sn, step, text, vlead } from "./util";

// Simulation_SPICE:OPAMP / LM358 unit A + power unit share these local pin positions.
const opPins: PinDef[] = [
  { id: "inp", name: "+", x: -6, y: -2 }, { id: "inn", name: "−", x: -6, y: 2 },
  { id: "vp", name: "V+", x: -2, y: -6 }, { id: "vn", name: "V−", x: -2, y: 6 },
  { id: "out", name: "OUT", x: 6, y: 0 },
];
const opSymbol: Shape[] = [
  poly([[-4, -4], [-4, 4], [4, 0]], true),
  hlead(-6, -4, -2), hlead(-6, -4, 2), hlead(4, 6, 0),
  vlead(-6, -3, -2), vlead(3, 6, -2),
  text(-3.2, -2, "+", 1.2), text(-3.2, 2, "−", 1.2),
];
// Output is referenced to V−; V+ and V− are joined by the quiescent-current resistor.
const opDcPaths: [string, string][] = [["out", "vn"], ["out", "vp"], ["vp", "vn"], ["inp", "inn"]];
const dualOpampMap = (sym: string): KicadMapping =>
  ({ symbol: sym, footprint: "Package_DIP:DIP-8_W7.62mm", pinMap: { inp: "3", inn: "2", out: "1", vp: "8", vn: "4" }, unit: 1, extraUnits: [3] });

const OPAMP_SUBCKT = `.subckt SB_OPAMP inp inn vcc vee out params: a0=200k gbw=1meg sr=1meg vos=0 rout=50 hrh=0 hrl=0 rin=10meg iq=1m
* Behavioral op-amp (SparkBench): transconductance stage with tanh slew limit into an RC dominant pole.
Rin inp inn {rin}
Rq vcc vee {1/iq}
Bmid mid vee V = V(vcc,vee)/2
Bg mid p I = {sr*1e-9}*tanh({6.283185307*gbw/sr}*(V(inp,inn)+{vos}))
Cp p mid 1e-9
Rp p mid {a0/(6.283185307*gbw*1e-9)}
Bcl p mid I = max(V(p,vee)-(V(vcc,vee)-{hrh}),0) - max({hrl}-V(p,vee),0)
Bo o vee V = V(p,vee)
Ro o out {rout}
.ends SB_OPAMP`;

function opampSpice(ctx: SpiceEmitContext, p: Record<string, string>): string[] {
  ctx.define("subckt:SB_OPAMP", OPAMP_SUBCKT);
  const args = Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ");
  return [`${el("X", ctx)} ${ctx.node("inp")} ${ctx.node("inn")} ${ctx.node("vp")} ${ctx.node("vn")} ${ctx.node("out")} SB_OPAMP ${args}`];
}

export const opamp: ComponentDef = {
  id: "opamp", name: "Op-Amp (ideal-ish)", category: "Analog ICs", refPrefix: "U",
  description: "General-purpose operational amplifier with editable open-loop gain, gain-bandwidth, slew rate and output headroom. Connect V+ and V− to your supplies.",
  keywords: ["op amp", "operational amplifier", "amplifier", "opamp"],
  pins: opPins,
  symbol: opSymbol,
  props: [
    modelProp("a0", "Open-loop gain", "200k", "V/V"),
    modelProp("gbw", "Gain-bandwidth", "1MEG", "Hz"),
    modelProp("sr", "Slew rate", "1MEG", "V/s", "1MEG V/s = 1 V/µs."),
    modelProp("hrh", "Headroom to V+", "0", "V", "How far the output stays below V+ (0 = rail-to-rail)."),
    modelProp("hrl", "Headroom to V−", "0", "V", "How far the output stays above V−."),
    modelProp("vos", "Input offset", "0", "V"),
    modelProp("rout", "Output resistance", "50", "Ω"),
  ],
  provenance: "behavioral",
  accuracyNote: "Single-pole behavioral macromodel: finite gain, GBW, slew limit, output clamped inside the rails, output resistance. Not modeled: input bias current, input common-mode limits, noise, output current limit, supply current drawn by the load (it flows to V−).",
  dcPaths: opDcPaths,
  spice: (c) => opampSpice(c, {
    a0: sn(c.num("a0")), gbw: sn(c.num("gbw")), sr: sn(c.num("sr")), vos: sn(c.num("vos")),
    rout: sn(c.num("rout")), hrh: sn(c.num("hrh")), hrl: sn(c.num("hrl")),
  }),
  kicad: { symbol: "Simulation_SPICE:OPAMP", footprint: "Package_DIP:DIP-8_W7.62mm", pinMap: { inp: "1", inn: "2", vp: "3", vn: "4", out: "5" } },
};

export const lm358 = {
  ...opamp,
  id: "lm358", name: "LM358-like Op-Amp", keywords: ["lm358", "lm324", "single supply", "op amp"],
  description: "Single-supply op-amp in the LM358 class (one amplifier of the dual package). Output swings down to V− but only to about V+ − 1.5 V.",
  props: [],
  accuracyNote: "Behavioral macromodel with LM358 datasheet-typical values: gain 100 V/mV, GBW 0.7 MHz, slew 0.3 V/µs, output high ≈ V+ − 1.5 V, low ≈ V−. Not TI's model: crossover distortion, input common-mode range, offset and bias currents are not modeled.",
  spice: (c: SpiceEmitContext) => opampSpice(c, { a0: "100k", gbw: "700k", sr: "300k", rout: "50", hrh: "1.5", hrl: "0.005", iq: "0.5m" }),
  kicad: dualOpampMap("Amplifier_Operational:LM358"),
} satisfies ComponentDef;

export const tl072 = {
  ...opamp,
  id: "tl072", name: "TL072-like Op-Amp", keywords: ["tl072", "tl082", "jfet input", "audio", "op amp"],
  description: "JFET-input op-amp in the TL072 class (one amplifier of the dual package): fast and very high input impedance, needs about 1.5 V headroom to both rails.",
  props: [],
  accuracyNote: "Behavioral macromodel with TL072 datasheet-typical values: gain 200 V/mV, GBW 3 MHz, slew 13 V/µs, swing ≈ 1.5 V inside each rail, input resistance 1 TΩ. Not TI's model: phase reversal near V−, noise and offsets are not modeled.",
  spice: (c: SpiceEmitContext) => opampSpice(c, { a0: "200k", gbw: "3meg", sr: "13meg", rout: "50", hrh: "1.5", hrl: "1.5", rin: "1e12", iq: "1.4m" }),
  kicad: dualOpampMap("Amplifier_Operational:TL072"),
} satisfies ComponentDef;

const COMP_SUBCKTS = (oc: boolean) => `.subckt SB_COMP_${oc ? "OC" : "PP"} inp inn vcc vee out params: td=200n hys=0 ron=50 rin=10meg
* Behavioral comparator (SparkBench): sharp input threshold with optional hysteresis, RC delay, ${oc ? "open-collector" : "push-pull"} output.
Rin inp inn {rin}
Rq vcc vee 100k
Bx x vee V = V(vcc,vee)*${step(`V(inp,inn)+{hys}*(V(d,vee)/max(V(vcc,vee),1e-3)-0.5)`, 0.001)}
Rd x d 1k
Cd d vee {td/0.693/1000}
${oc
    ? `Bs out vee I = (1-${step("V(d,vee)-V(vcc,vee)/2")})*V(out,vee)/{ron}\nRleak out vee 100meg`
    : `Bo o vee V = V(vcc,vee)*${step("V(d,vee)-V(vcc,vee)/2")}\nRo o out {ron}`}
.ends SB_COMP_${oc ? "OC" : "PP"}`;

export const comparator: ComponentDef = {
  id: "comparator", name: "Comparator", category: "Analog ICs", refPrefix: "U",
  description: "Voltage comparator: output high when + > −. Choose push-pull, or open-collector (LM393 style: needs a pull-up resistor; the output only sinks).",
  keywords: ["comparator", "lm393", "lm339", "threshold", "schmitt"],
  pins: opPins,
  symbol: [...opSymbol, poly([[0.2, -0.6], [1.2, -0.6], [1.2, 0.6], [2.2, 0.6]])],
  props: [
    { key: "output", label: "Output type", kind: "select", default: "open-collector", options: ["open-collector", "push-pull"] },
    modelProp("td", "Response time", "300n", "s"),
    modelProp("hys", "Hysteresis", "0", "V", "Total input hysteresis (0 = none; add external positive feedback for a Schmitt trigger)."),
    modelProp("ron", "Output on resistance", "50", "Ω"),
  ],
  provenance: "behavioral",
  accuracyNote: "Behavioral: ideal threshold (1 mV transition), first-order response delay, ideal output levels (push-pull swings rail to rail; open-collector sinks through Ron with 100 MΩ leakage). Input offset, bias current and output current limits are not modeled.",
  analyses: { ac: false },
  dcPaths: opDcPaths,
  spice: (c) => {
    const oc = c.str("output") !== "push-pull";
    const name = `SB_COMP_${oc ? "OC" : "PP"}`;
    c.define(`subckt:${name}`, COMP_SUBCKTS(oc));
    const td = Math.max(1e-9, c.num("td"));
    return [`${el("X", c)} ${c.node("inp")} ${c.node("inn")} ${c.node("vp")} ${c.node("vn")} ${c.node("out")} ${name} td=${sn(td)} hys=${sn(c.num("hys"))} ron=${sn(c.num("ron"))}`];
  },
  kicad: { symbol: "Comparator:LM393", footprint: "Package_DIP:DIP-8_W7.62mm", pinMap: { inp: "3", inn: "2", out: "1", vp: "8", vn: "4" }, unit: 1, extraUnits: [3] },
  displayProps: ["output"],
};


export const analogParts: ComponentDef[] = [opamp, lm358, tl072, comparator];
