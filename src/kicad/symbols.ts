// KiCad symbol helpers: extract a symbol from a .kicad_sym library (flattening `extends`),
// rename it for a schematic's embedded lib_symbols, and read its pins/properties/units.
import { arg, child, children, clone, head, isList, numArg, str, sym, type SExpr, type SList } from "./sexpr";

export interface SymbolPin {
  number: string;
  name: string;
  /** Electrical type: passive, input, power_in, ... */
  type: string;
  /** Connection point in library coordinates (mm, Y up). */
  x: number;
  y: number;
  /** 0 = common to all units. */
  unit: number;
  /** 0 = common to all body styles. */
  bodyStyle: number;
  hidden: boolean;
}

export interface SymbolInfo {
  libId: string;
  pins: SymbolPin[];
  unitCount: number;
  power: boolean;
  /** Library property values (Reference, Value, Footprint, Description, ki_keywords, Sim.*, ...). */
  props: Record<string, string>;
  inBom: boolean;
  onBoard: boolean;
  excludeFromSim: boolean;
}

/** Split "Lib:Name" into parts. */
export function splitLibId(libId: string): { lib: string; name: string } {
  const i = libId.indexOf(":");
  return i < 0 ? { lib: "", name: libId } : { lib: libId.slice(0, i), name: libId.slice(i + 1) };
}

/** Top-level symbols of a parsed .kicad_sym library. */
export function librarySymbols(lib: SList): Map<string, SList> {
  const m = new Map<string, SList>();
  for (const s of children(lib, "symbol")) m.set(arg(s)!, s);
  return m;
}

/** Fast name scan of a .kicad_sym file without parsing it (for search indexes). */
export function scanSymbolNames(text: string): { name: string; description: string; keywords: string }[] {
  const out: { name: string; description: string; keywords: string }[] = [];
  const re = /^\t\(symbol "((?:[^"\\]|\\.)*)"/gm;
  const starts: { name: string; at: number }[] = [];
  for (const m of text.matchAll(re)) starts.push({ name: m[1].replace(/\\(.)/g, "$1"), at: m.index! });
  for (let i = 0; i < starts.length; i++) {
    const chunk = text.slice(starts[i].at, starts[i + 1]?.at ?? text.length).slice(0, 6000);
    const d = /\(property "Description" "((?:[^"\\]|\\.)*)"/.exec(chunk)?.[1] ?? "";
    const k = /\(property "ki_keywords" "((?:[^"\\]|\\.)*)"/.exec(chunk)?.[1] ?? "";
    out.push({ name: starts[i].name, description: d, keywords: k });
  }
  return out;
}

/**
 * Produce the symbol as it is embedded in a schematic's lib_symbols: renamed to "Lib:Name",
 * with `extends` resolved against its parent (KiCad flattens derived symbols when embedding).
 */
export function embedSymbol(libSyms: Map<string, SList>, libName: string, name: string): SList | undefined {
  const src = libSyms.get(name);
  if (!src) return undefined;
  const ext = child(src, "extends");
  let flat: SList;
  if (ext) {
    const parentName = arg(ext)!;
    const parent = embedSymbol(libSyms, libName, parentName);
    if (!parent) return undefined;
    flat = flattenDerived(parent, src, parentName, name);
  } else {
    flat = clone(src);
  }
  flat.items[1] = str(`${libName}:${name}`);
  return flat;
}

function flattenDerived(parentEmbedded: SList, derived: SList, parentName: string, name: string): SList {
  // Start from the parent; replace/insert the derived symbol's own properties and flags,
  // rename unit sub-symbols Parent_U_B -> Name_U_B.
  const out = clone(parentEmbedded);
  const derivedProps = children(derived, "property");
  const keys = new Set(derivedProps.map((p) => arg(p)));
  const items: SExpr[] = [];
  let insertedProps = false;
  for (const it of out.items) {
    if (isList(it) && head(it) === "property") {
      if (!insertedProps) { items.push(...derivedProps.map(clone)); insertedProps = true; }
      if (keys.has(arg(it))) continue;
      items.push(it);
      continue;
    }
    if (isList(it) && head(it) === "symbol") {
      const n = arg(it)!;
      if (n.startsWith(`${parentName}_`)) it.items[1] = str(`${name}_${n.slice(parentName.length + 1)}`);
    }
    // Flags the derived symbol overrides (in_bom, on_board, exclude_from_sim, pin_names, ...).
    if (isList(it) && head(it) !== "symbol") {
      const o = child(derived, head(it)!);
      if (o && head(it) !== "property") { items.push(clone(o)); continue; }
    }
    items.push(it);
  }
  out.items = items;
  return out;
}

const yes = (e: SList | undefined, dflt: boolean) => (e ? arg(e) !== "no" : dflt);

export function symbolInfo(embedded: SList): SymbolInfo {
  const libId = arg(embedded)!;
  const baseName = splitLibId(libId).name;
  const pins: SymbolPin[] = [];
  let unitCount = 1;
  for (const u of children(embedded, "symbol")) {
    const n = arg(u)!;
    const m = /_(\d+)_(\d+)$/.exec(n);
    const unit = m ? Number(m[1]) : 0;
    const bodyStyle = m ? Number(m[2]) : 0;
    unitCount = Math.max(unitCount, unit);
    void baseName;
    for (const p of children(u, "pin")) {
      const at = child(p, "at");
      pins.push({
        number: arg(child(p, "number")) ?? "",
        name: arg(child(p, "name")) ?? "",
        type: arg(p, 1) ?? "",
        x: numArg(at, 1), y: numArg(at, 2),
        unit, bodyStyle,
        hidden: !!child(p, "hide") && arg(child(p, "hide")) !== "no" || p.items.some((x) => x.t === "atom" && x.raw === "hide"),
      });
    }
  }
  const props: Record<string, string> = {};
  for (const p of children(embedded, "property")) props[arg(p)!] = arg(p, 2) ?? "";
  return {
    libId, pins, unitCount,
    power: !!child(embedded, "power"),
    props,
    inBom: yes(child(embedded, "in_bom"), true),
    onBoard: yes(child(embedded, "on_board"), true),
    excludeFromSim: child(embedded, "exclude_from_sim") ? arg(child(embedded, "exclude_from_sim")) === "yes" : false,
  };
}

/** Pins that belong to a unit (unit-specific plus common pins), body style 1. */
export function unitPins(info: SymbolInfo, unit: number): SymbolPin[] {
  return info.pins.filter((p) => (p.unit === unit || p.unit === 0) && (p.bodyStyle === 1 || p.bodyStyle === 0));
}

/** Distinct pin numbers across all units. */
export function pinNumbers(info: SymbolInfo): string[] {
  return [...new Set(info.pins.map((p) => p.number))];
}

export { sym };
