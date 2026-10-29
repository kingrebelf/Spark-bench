// Shared KiCad helpers: grid↔mm, symbol orientation transforms, deterministic UUIDs,
// SI value formatting, and per-instance mapping resolution.
import { parseSI } from "../core/units";
import type { ComponentDef, ComponentInstance, Point, Rotation } from "../core/types";

/** 1 SparkBench grid unit = 1.27 mm. Integer math avoids 3*1.27 = 3.8100000000000005. */
export const gridToMm = (g: number) => Math.round(g * 127) / 100;
export const mmToGrid = (mm: number) => mm / 1.27;
/** Round mm to KiCad's schematic resolution (0.1 µm) to kill float noise. */
export const roundMm = (mm: number) => Math.round(mm * 10000) / 10000;

export type KicadMirror = "" | "x" | "y";
export interface KicadOrient { angle: 0 | 90 | 180 | 270; mirror: KicadMirror }
export const ORIENTS: KicadOrient[] = ([0, 90, 180, 270] as const).flatMap((angle) => (["", "y", "x"] as const).map((mirror) => ({ angle, mirror })));

/**
 * Library pin/field offset (mm, Y up) → schematic offset (mm, Y down) for a placed symbol.
 * KiCad's angle is counter-clockwise on screen; the mirror is applied after rotation
 * (`(mirror y)` flips X, `(mirror x)` flips Y). Verified against kicad-cli netlists in tests.
 */
export function kicadTransform(lx: number, ly: number, o: KicadOrient): { x: number; y: number } {
  let x = lx, y = -ly; // Y flip into screen coordinates
  switch (o.angle) {
    case 90: [x, y] = [y, -x]; break;
    case 180: [x, y] = [-x, -y]; break;
    case 270: [x, y] = [-y, x]; break;
  }
  if (o.mirror === "y") x = -x;
  if (o.mirror === "x") y = -y;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

/**
 * The form KiCad itself writes for an orientation (SCH_SYMBOL::GetOrientation order): mirror-y is kept only
 * at angle 0, other mirrored orientations are written as mirror-x, and (180, mirror x) as (0, mirror y).
 */
export function canonicalOrient(o: KicadOrient): KicadOrient {
  if (o.mirror === "y" && o.angle !== 0) return { angle: ((o.angle + 180) % 360) as KicadOrient["angle"], mirror: "x" };
  if (o.mirror === "x" && o.angle === 180) return { angle: 0, mirror: "y" };
  return o;
}

/** SparkBench rotation (clockwise) + mirror → the equivalent KiCad orientation, for symbols drawn identically. */
export function sbToKicadOrient(rotation: Rotation, mirror?: boolean): KicadOrient {
  return { angle: ((360 - rotation) % 360) as KicadOrient["angle"], mirror: mirror ? "y" : "" };
}

// ------------------------------------------------------------------ UUIDs

function cyrb128(s: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** Deterministic RFC-4122-shaped UUID from a seed, so re-exports keep the same identities. */
export function stableUuid(seed: string): string {
  const [a, b, c, d] = cyrb128(seed);
  const hex = [a, b, c, d].map((n) => n.toString(16).padStart(8, "0")).join("");
  const v = hex.slice(0, 12) + "4" + hex.slice(13, 16) + ((parseInt(hex[16], 16) & 3) | 8).toString(16) + hex.slice(17);
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

// ------------------------------------------------------------------ values

const PREFIXES: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];

/** Number → KiCad/SPICE-friendly value ("4.7k", "100n", "1M" = mega in KiCad's simulator). */
export function kicadValue(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "0";
  const a = Math.abs(n);
  const [mult, p] = PREFIXES.find(([m]) => a >= m * 0.9999999) ?? PREFIXES[PREFIXES.length - 1];
  const v = Number((n / mult).toPrecision(6));
  return `${v}${p}`;
}

/** SparkBench SI string ("4.7k", "1MEG", "2.2nF") → KiCad value; falls back to the raw text. */
export function siToKicad(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const n = parseSI(s);
  return Number.isNaN(n) ? s : kicadValue(n);
}

// ------------------------------------------------------------------ mapping resolution

export interface ResolvedMapping {
  symbol: string;
  footprint: string;
  pinMap: Record<string, string>;
  unit: number;
  extraUnits: number[];
  fields: Record<string, string>;
  /** Where the symbol came from. */
  symbolSource: "instance" | "library-part" | "none";
}

/** Effective KiCad mapping of an instance: per-instance overrides win over the part's defaults. */
export function resolveMapping(inst: ComponentInstance, def: ComponentDef | undefined): ResolvedMapping {
  const k = def?.kicad;
  const symbol = inst.kicad?.symbol || k?.symbol || "";
  const pinMap = k?.pinMap && Object.keys(k.pinMap).length
    ? { ...k.pinMap }
    : Object.fromEntries((def?.pins ?? []).map((p) => [p.id, p.id]));
  return {
    symbol,
    footprint: inst.kicad?.footprint ?? k?.footprint ?? "",
    pinMap,
    unit: k?.unit ?? 1,
    extraUnits: k?.extraUnits ?? [],
    fields: { ...(k?.fields ?? {}), ...(inst.kicad?.fields ?? {}) },
    symbolSource: inst.kicad?.symbol ? "instance" : k?.symbol ? "library-part" : "none",
  };
}

export const ptKey = (p: Point) => `${p.x},${p.y}`;
