// SparkBench part values → KiCad Value + Sim.* fields understood by KiCad's own simulator.
// Parameter names follow the Simulation_SPICE library symbols (VDC/VSIN/VPULSE) and KiCad's built-in
// diode model; the output is checked with `kicad-cli sch export netlist --format spice` in tests.
import { parseSI } from "../core/units";
import type { ComponentDef, ComponentInstance } from "../core/types";
import { kicadValue, siToKicad } from "./common";

export interface SimMapping {
  /** Value field text. */
  value: string;
  /** Sim.* fields to write (others come from the library symbol). */
  fields: Record<string, string>;
  /** True when KiCad's simulator gets an equivalent model. */
  simulatable: boolean;
  /** Plain-language note when something does not carry over. */
  note?: string;
}

const prop = (def: ComponentDef, inst: ComponentInstance, key: string) =>
  inst.props[key] ?? def.props.find((p) => p.key === key)?.default ?? "";
const num = (def: ComponentDef, inst: ComponentInstance, key: string) => parseSI(String(prop(def, inst, key)));
const kv = (n: number) => kicadValue(n);

export function simMapping(def: ComponentDef, inst: ComponentInstance, symbolProps: Record<string, string>, symbolId: string): SimMapping {
  const valueProp = def.props.find((p) => p.key === "value");
  const baseValue = valueProp ? siToKicad(prop(def, inst, "value")) : (symbolProps.Value ?? def.name);
  const lib = symbolId.split(":")[0];
  switch (def.id) {
    case "resistor": case "capacitor": case "inductor": {
      const ic = def.id === "capacitor" ? String(prop(def, inst, "ic")).trim() : "";
      return {
        value: baseValue, fields: {}, simulatable: true,
        note: ic ? `Initial voltage ${ic} V is not transferred (KiCad sets initial conditions with a .ic directive).` : undefined,
      };
    }
    case "vdc": {
      const ac = num(def, inst, "acmag");
      const dc = kv(num(def, inst, "value"));
      return { value: dc, fields: { "Sim.Device": "V", "Sim.Type": "DC", "Sim.Pins": "1=+ 2=-", "Sim.Params": `dc=${dc}${ac ? ` ac=${kv(ac)}` : ""}` }, simulatable: true };
    }
    case "vsine": {
      const p = `dc=${kv(num(def, inst, "offset"))} ampl=${kv(num(def, inst, "amplitude"))} f=${kv(num(def, inst, "frequency"))} ac=${kv(num(def, inst, "acmag"))}`
        + (num(def, inst, "phase") ? ` ph=${kv(num(def, inst, "phase"))}` : "");
      return { value: "${SIM.PARAMS}", fields: { "Sim.Device": "V", "Sim.Type": "SIN", "Sim.Pins": "1=+ 2=-", "Sim.Params": p }, simulatable: true };
    }
    case "vpulse": {
      const f = num(def, inst, "frequency"), duty = num(def, inst, "duty") / 100, tr = num(def, inst, "edge");
      const per = 1 / f, tw = Math.max(per * duty - tr, tr);
      const p = `y1=${kv(num(def, inst, "low"))} y2=${kv(num(def, inst, "high"))} td=${kv(num(def, inst, "delay"))} tr=${kv(tr)} tf=${kv(tr)} tw=${kv(tw)} per=${kv(per)}`;
      return { value: "${SIM.PARAMS}", fields: { "Sim.Device": "V", "Sim.Type": "PULSE", "Sim.Pins": "1=+ 2=-", "Sim.Params": p }, simulatable: true };
    }
  }
  if (def.role === "ground") return { value: symbolProps.Value ?? "GND", fields: {}, simulatable: true };
  const generic = modelCardMapping(def, inst);
  if (generic) return { value: baseValue, fields: generic, simulatable: true };
  // Parts whose library mapping already carries Sim.* fields, or whose KiCad symbol has its own model.
  const hasSim = Object.keys(def.kicad?.fields ?? {}).some((k) => k.startsWith("Sim.")) || Object.keys(symbolProps).some((k) => k === "Sim.Device");
  if (hasSim) return { value: baseValue, fields: {}, simulatable: true };
  // KiCad infers R/C/L models from the reference prefix and a numeric value.
  if (/^(Device:(R|C|L)(_.*)?)$/.test(symbolId) && valueProp) return { value: baseValue, fields: {}, simulatable: true };
  return {
    value: baseValue, fields: {}, simulatable: false,
    note: def.provenance === "none"
      ? "Schematic-only part; excluded from KiCad simulation."
      : `No KiCad simulation model is written for this part (${lib ? `${symbolId}` : "no symbol"}); KiCad's simulator will ask for one.`,
  };
}

// ------------------------------------------------------------------ generic .model cards (D, BJT, MOSFET)

const DEVICE: Record<string, { sim: string; type?: string; pins: string[]; letter: string }> = {
  D: { sim: "D", pins: ["A", "K"], letter: "D" },
  NPN: { sim: "NPN", type: "GUMMELPOON", pins: ["C", "B", "E"], letter: "Q" },
  PNP: { sim: "PNP", type: "GUMMELPOON", pins: ["C", "B", "E"], letter: "Q" },
  NMOS: { sim: "NMOS", type: "MOS1", pins: ["D", "G", "S", "B"], letter: "M" },
  PMOS: { sim: "PMOS", type: "MOS1", pins: ["D", "G", "S", "B"], letter: "M" },
};

/**
 * Parts whose SPICE emitter produces one D/Q/M element with a plain .model card (diodes, LEDs, zeners,
 * BJTs, level-1 MOSFETs) map onto KiCad's built-in models: Sim.Device/Type, the model parameters in
 * Sim.Params, and Sim.Pins from the element's node order. Anything else returns null (not mapped).
 */
export function modelCardMapping(def: ComponentDef, inst: ComponentInstance): Record<string, string> | null {
  if (!def.spice || !def.kicad) return null;
  const cards: string[] = [];
  let lines: string[] | null;
  try {
    lines = def.spice({
      node: (p) => `@${p}@`, num: (k) => parseSI(String(prop(def, inst, k))), str: (k) => String(prop(def, inst, k)),
      define: (_k, t) => cards.push(t), inst: { ...inst, ref: "X" }, analysis: "op", model: () => undefined,
    });
  } catch { return null; }
  if (!lines || lines.length !== 1 || cards.length !== 1) return null;
  const card = /^\.model\s+(\S+)\s+(D|NPN|PNP|NMOS|PMOS)\s*\(([^)]*)\)\s*$/i.exec(cards[0].trim());
  if (!card) return null;
  const dev = DEVICE[card[2].toUpperCase()];
  const tok = lines[0].trim().split(/\s+/);
  if (tok[0][0].toUpperCase() !== dev.letter) return null;
  const nodes = tok.slice(1, 1 + dev.pins.length);
  const modelAt = 1 + dev.pins.length;
  if (tok[modelAt] !== card[1]) return null;
  // node order → our pin ids → KiCad pin numbers
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const m = /^@(.+)@$/.exec(nodes[i]);
    if (!m) return null;
    const num = def.kicad.pinMap[m[1]];
    if (num === undefined) return null;
    if (seen.has(num)) {
      // MOSFET bulk tied to source on a 3-pin symbol: KiCad's MOS1 then needs the 4th pin, which the symbol lacks.
      return null;
    }
    seen.add(num);
    pairs.push(`${num}=${dev.pins[i]}`);
  }
  const params = card[3].trim().split(/[\s,]+/).filter(Boolean).map((p) => {
    const [k, v] = p.split("=");
    let key = k.toLowerCase();
    if (dev.sim === "D" && key === "m") key = "mj"; // KiCad reads "m" on a diode as the instance multiplier
    return { key, v };
  }).filter((p) => p.v !== undefined && p.key !== "level");
  const inst2 = tok.slice(modelAt + 1).filter((t) => t.includes("=")).map((t) => t.toLowerCase());
  const f: Record<string, string> = { "Sim.Device": dev.sim, "Sim.Pins": pairs.sort().join(" "), "Sim.Params": [...params.map((p) => `${p.key}=${p.v}`), ...inst2].join(" ") };
  if (dev.type) f["Sim.Type"] = dev.type;
  return f;
}
