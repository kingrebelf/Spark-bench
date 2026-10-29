// Minimal reader for installed KiCad symbol/footprint libraries, used by the library tests
// to verify every part's KiCad mapping (symbol exists, pin numbers exist, pin positions match).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KICAD_SHARE = process.env.KICAD_SHARE ?? "C:\\Users\\benwe\\AppData\\Local\\Programs\\KiCad\\10.0\\share\\kicad";
export const kicadInstalled = () => existsSync(join(KICAD_SHARE, "symbols", "Device.kicad_sym"));

type SExpr = string | SExpr[];

export function parseSExpr(text: string): SExpr {
  let i = 0;
  const stack: SExpr[][] = [[]];
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") { const l: SExpr[] = []; stack[stack.length - 1].push(l); stack.push(l); i++; }
    else if (ch === ")") { stack.pop(); i++; }
    else if (ch === '"') {
      let j = i + 1, s = "";
      while (text[j] !== '"') { if (text[j] === "\\") { s += text[j + 1]; j += 2; } else s += text[j++]; }
      stack[stack.length - 1].push(s); i = j + 1;
    } else if (/\s/.test(ch)) i++;
    else { let j = i; while (j < text.length && !/[\s()]/.test(text[j])) j++; stack[stack.length - 1].push(text.slice(i, j)); i = j; }
  }
  return stack[0][0];
}

export interface KicadPin { number: string; name: string; x: number; y: number; unit: number; hidden: boolean }
export interface KicadSymbol { name: string; pins: KicadPin[]; extendsName?: string }

const libCache = new Map<string, Map<string, SExpr[]>>();

function loadLib(lib: string): Map<string, SExpr[]> | undefined {
  if (libCache.has(lib)) return libCache.get(lib);
  const file = join(KICAD_SHARE, "symbols", `${lib}.kicad_sym`);
  if (!existsSync(file)) return undefined;
  const root = parseSExpr(readFileSync(file, "utf8")) as SExpr[];
  const map = new Map<string, SExpr[]>();
  for (const node of root) if (Array.isArray(node) && node[0] === "symbol") map.set(node[1] as string, node);
  libCache.set(lib, map);
  return map;
}

function collectPins(sym: SExpr[]): KicadPin[] {
  const pins: KicadPin[] = [];
  for (const unit of sym) {
    if (!Array.isArray(unit) || unit[0] !== "symbol") continue;
    // Unit names look like "NAME_U_S" (U = unit number, 0 = common to all units).
    const m = /_(\d+)_(\d+)$/.exec(unit[1] as string);
    const unitNo = m ? Number(m[1]) : 0;
    if (m && m[2] === "2") continue; // De Morgan alternate body style
    for (const p of unit) {
      if (!Array.isArray(p) || p[0] !== "pin") continue;
      const at = p.find((e) => Array.isArray(e) && e[0] === "at") as string[];
      const num = p.find((e) => Array.isArray(e) && e[0] === "number") as SExpr[];
      const nm = p.find((e) => Array.isArray(e) && e[0] === "name") as SExpr[];
      const hidden = p.includes("hide") || p.some((e) => Array.isArray(e) && e[0] === "hide" && e[1] === "yes");
      pins.push({ number: num[1] as string, name: nm[1] as string, x: Number(at[1]), y: Number(at[2]), unit: unitNo, hidden });
    }
  }
  return pins;
}

/** Look up "Lib:Name", following `extends`. */
export function findSymbol(libId: string): KicadSymbol | undefined {
  const [lib, name] = libId.split(":");
  const map = loadLib(lib);
  const sym = map?.get(name);
  if (!sym) return undefined;
  const ext = sym.find((e) => Array.isArray(e) && e[0] === "extends") as SExpr[] | undefined;
  if (ext) {
    const base = findSymbol(`${lib}:${ext[1] as string}`);
    return base && { name, pins: base.pins, extendsName: ext[1] as string };
  }
  return { name, pins: collectPins(sym) };
}

/** Pin position in SparkBench grid units (1.27 mm, Y down). */
export const toGrid = (p: KicadPin) => ({ x: p.x / 1.27, y: -p.y / 1.27 });

export function footprintExists(fp: string): boolean {
  const [lib, name] = fp.split(":");
  return existsSync(join(KICAD_SHARE, "footprints", `${lib}.pretty`, `${name}.kicad_mod`));
}

/** Pad numbers present in a footprint. */
export function footprintPads(fp: string): Set<string> {
  const [lib, name] = fp.split(":");
  const text = readFileSync(join(KICAD_SHARE, "footprints", `${lib}.pretty`, `${name}.kicad_mod`), "utf8");
  return new Set([...text.matchAll(/\(pad "([^"]*)"/g)].map((m) => m[1]));
}
