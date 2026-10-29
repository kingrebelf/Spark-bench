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
    case "diode":
      return {
        value: "D_GENERIC",
        fields: { "Sim.Device": "D", "Sim.Pins": "1=K 2=A", "Sim.Params": "is=2.52n n=1.752 rs=0.568 cjo=4p mj=0.4 tt=20n bv=100 ibv=100u" },
        simulatable: true,
      };
  }
  if (def.role === "ground") return { value: symbolProps.Value ?? "GND", fields: {}, simulatable: true };
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
