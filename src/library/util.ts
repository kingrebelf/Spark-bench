// Shared helpers for part definitions: SPICE naming, number formatting, symbol pieces,
// model selection (built-in vs. project-imported) and smooth behavioral expressions.
import { toSpiceNumber } from "../core/units";
import type { PropDef, Shape, SpiceEmitContext } from "../core/types";
import { parseSpiceModels } from "./spiceImport";

/** SPICE literal for a numeric prop. */
export const n = (ctx: SpiceEmitContext, key: string) => toSpiceNumber(ctx.num(key));
export const sn = toSpiceNumber;

/** SPICE element name: the ref, prefixed with the element letter when it doesn't already start with it. */
export function el(letter: string, ctx: SpiceEmitContext): string {
  const r = ctx.inst.ref.replace(/[^A-Za-z0-9_]/g, "_");
  return r.toUpperCase().startsWith(letter.toUpperCase()) ? r : `${letter}${r}`;
}

/** Instance-unique suffix for internal nodes and helper elements. */
export const uid = (ctx: SpiceEmitContext) => ctx.inst.ref.replace(/[^A-Za-z0-9_]/g, "_");

// ---------------------------------------------------------------- symbol pieces

export const line = (x1: number, y1: number, x2: number, y2: number): Shape => ({ kind: "line", x1, y1, x2, y2 });
export const vlead = (y1: number, y2: number, x = 0): Shape => line(x, y1, x, y2);
export const hlead = (x1: number, x2: number, y = 0): Shape => line(x1, y, x2, y);
export const text = (x: number, y: number, t: string, size = 1.2, anchor: "start" | "middle" | "end" = "middle"): Shape =>
  ({ kind: "text", x, y, text: t, size, anchor });
export const rect = (x: number, y: number, w: number, h: number): Shape => ({ kind: "rect", x, y, w, h });
export const circle = (cx: number, cy: number, r: number, fill = false): Shape => ({ kind: "circle", cx, cy, r, fill });
export const poly = (pts: [number, number][], closed = false, fill = false): Shape =>
  ({ kind: "polyline", points: pts.map(([x, y]) => ({ x, y })), closed, fill });

/** Diode body pointing left (cathode bar at x = -1), as in KiCad's Device:D (K left, A right). */
export const diodeBody = (): Shape[] => [
  hlead(-3, 3),
  poly([[1, -1.2], [1, 1.2], [-1, 0]], true, true),
  line(-1, -1.2, -1, 1.2),
];

// ---------------------------------------------------------------- props

export const modelProp = (key: string, label: string, def: string | number, unit?: string, help?: string): PropDef =>
  ({ key, label, kind: "number", default: def, unit, help, model: true });

/** Emit a parameter list "Is=1e-14 N=1.5" from numeric props. */
export const params = (ctx: SpiceEmitContext, map: Record<string, string>) =>
  Object.entries(map).map(([spice, key]) => `${spice}=${n(ctx, key)}`).join(" ");

// ---------------------------------------------------------------- model selection

/**
 * Resolve the .model to use for a discrete device. When the instance references a project
 * model (imported with spiceImport) of an allowed type, that model is defined and its name
 * returned; a mismatched or missing model returns null so the netlister reports the part
 * as unsimulatable instead of silently using the built-in model.
 */
export function chooseModel(ctx: SpiceEmitContext, allowed: string[], builtinName: string, builtinText: () => string): { name: string; type: string } | null {
  const id = ctx.inst.modelId;
  if (!id) {
    ctx.define(`model:${builtinName}`, builtinText());
    return { name: builtinName, type: allowed[0] };
  }
  const m = ctx.model(id);
  if (!m || m.kind !== "model") return null;
  const parsed = parseSpiceModels(m.text).models[0];
  if (!parsed || parsed.kind !== "model") return null;
  const effective = parsed.type === "VDMOS" ? (parsed.polarity === "P" ? "PMOS" : "NMOS") : parsed.type ?? "";
  if (!allowed.includes(effective)) return null;
  ctx.define(`project-model:${m.id}`, m.text);
  return { name: parsed.name, type: parsed.type ?? effective };
}

// ---------------------------------------------------------------- behavioral expressions

/** Smooth step 0..1 of a voltage expression around zero, transition width w volts. */
export const step = (x: string, w = 0.05) => `(0.5*(1+tanh((${x})/${w})))`;
/** Logic level (0..1) of node `p` relative to supply: threshold at VCC/2. */
export const lvl = (p: string) => step(`V(${p},gnd)-V(vcc,gnd)/2`);

/** Inductor coil of `count` half-circle humps (1 unit each) going down from (x, y0), bulging to `side`. */
export const arcCoil = (x: number, y0: number, count: number, side: "left" | "right"): Shape[] =>
  Array.from({ length: count }, (_, i): Shape => ({ kind: "arc", x1: x, y1: y0 + i, x2: x, y2: y0 + i + 1, r: 0.5, sweep: side === "right" }));
