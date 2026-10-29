// Access to the installed KiCad symbol and footprint libraries (Node only).
// Library nicknames resolve through the user's global sym-lib-table / fp-lib-table when KiCad has been
// configured, otherwise through the table template shipped with KiCad (nickname = file name).
import { existsSync, promises as fs, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { arg, children, parse, type SList } from "../sexpr";
import { embedSymbol, librarySymbols, scanSymbolNames, splitLibId, symbolInfo } from "../symbols";
import type { LibraryFacts, SymbolFacts } from "../mapping";
import type { KicadInstall } from "./install";

export interface LibEntry { nickname: string; uri: string }

function configDir(k: KicadInstall): string {
  const ver = `${k.major}.0`;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "kicad", ver);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Preferences", "kicad", ver);
  return path.join(os.homedir(), ".config", "kicad", ver);
}

function expandVars(uri: string, k: KicadInstall): string {
  return uri.replace(/\$\{([A-Z0-9_]+)\}/g, (m, v: string) => {
    if (/^KICAD\d*_SYMBOL_DIR$/.test(v)) return k.symbolDir;
    if (/^KICAD\d*_FOOTPRINT_DIR$/.test(v)) return k.footprintDir;
    if (/^KICAD\d*_TEMPLATE_DIR$/.test(v)) return k.templateDir;
    if (/^KICAD\d*_3DMODEL_DIR$/.test(v)) return path.join(k.shareDir, "3dmodels");
    return process.env[v] ?? m;
  });
}

function readTable(file: string, k: KicadInstall): LibEntry[] {
  try {
    const t = parse(readFileSync(file, "utf8"));
    return children(t, "lib").map((l) => ({
      nickname: arg(children(l, "name")[0]) ?? "",
      uri: expandVars(arg(children(l, "uri")[0]) ?? "", k),
    })).filter((e) => e.nickname && e.uri);
  } catch { return []; }
}

/** Library tables (nickname → file/dir) for symbols and footprints. */
export function libraryTables(k: KicadInstall): { symbols: LibEntry[]; footprints: LibEntry[]; source: "user" | "template" | "scan" } {
  const cfg = configDir(k);
  for (const [dir, source] of [[cfg, "user"], [k.templateDir, "template"]] as const) {
    const s = readTable(path.join(dir, "sym-lib-table"), k);
    const f = readTable(path.join(dir, "fp-lib-table"), k);
    if (s.length && f.length) return { symbols: s, footprints: f, source };
  }
  const scan = (dir: string, ext: string) => existsSync(dir)
    ? readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => ({ nickname: n.slice(0, -ext.length), uri: path.join(dir, n) }))
    : [];
  return { symbols: scan(k.symbolDir, ".kicad_sym"), footprints: scan(k.footprintDir, ".pretty"), source: "scan" };
}

export interface SymbolSearchHit { libId: string; description: string; keywords: string }
export interface FootprintSearchHit { fpId: string }

/** Loads and caches libraries; all lookups by KiCad lib_id / footprint id ("Lib:Name"). */
export class KicadLibraries {
  private symLibs = new Map<string, Map<string, SList> | null>();
  private symIndex: SymbolSearchHit[] | null = null;
  private fpIndex: FootprintSearchHit[] | null = null;
  readonly tables: ReturnType<typeof libraryTables>;
  constructor(readonly kicad: KicadInstall) { this.tables = libraryTables(kicad); }

  symbolLibPath(nick: string) { return this.tables.symbols.find((e) => e.nickname === nick)?.uri; }
  footprintLibPath(nick: string) { return this.tables.footprints.find((e) => e.nickname === nick)?.uri; }

  private lib(nick: string): Map<string, SList> | null {
    if (this.symLibs.has(nick)) return this.symLibs.get(nick)!;
    const p = this.symbolLibPath(nick);
    let m: Map<string, SList> | null = null;
    if (p && existsSync(p)) {
      try { m = librarySymbols(parse(readFileSync(p, "utf8"))); } catch { m = null; }
    }
    this.symLibs.set(nick, m);
    return m;
  }

  /** The symbol as it is embedded into a schematic (renamed "Lib:Name", `extends` flattened), or undefined. */
  symbol(libId: string): SList | undefined {
    const { lib, name } = splitLibId(libId);
    const l = lib ? this.lib(lib) : null;
    return l ? embedSymbol(l, lib, name) : undefined;
  }

  /** Parsed .kicad_mod for "Lib:Name", or undefined. */
  footprint(fpId: string): SList | undefined {
    const { lib, name } = splitLibId(fpId);
    const p = this.footprintLibPath(lib);
    if (!p) return undefined;
    const f = path.join(p, `${name}.kicad_mod`);
    if (!existsSync(f)) return undefined;
    try { return parse(readFileSync(f, "utf8")); } catch { return undefined; }
  }

  footprintFile(fpId: string): string | undefined {
    const { lib, name } = splitLibId(fpId);
    const p = this.footprintLibPath(lib);
    const f = p && path.join(p, `${name}.kicad_mod`);
    return f && existsSync(f) ? f : undefined;
  }

  /** Pad numbers of a footprint (distinct, excluding unnumbered mechanical pads). */
  footprintPads(fpId: string): string[] | undefined {
    const fp = this.footprint(fpId);
    if (!fp) return undefined;
    return [...new Set(children(fp, "pad").map((p) => arg(p) ?? "").filter(Boolean))];
  }

  /** Plain-data facts for the mapping review. */
  facts(symbolIds: string[], footprintIds: string[]): LibraryFacts {
    const symbols: Record<string, SymbolFacts | null> = {};
    for (const id of symbolIds) {
      const s = this.symbol(id);
      if (!s) { symbols[id] = null; continue; }
      const i = symbolInfo(s);
      symbols[id] = { pins: i.pins.map((p) => ({ number: p.number, name: p.name, unit: p.unit })), unitCount: i.unitCount,
        power: i.power, onBoard: i.onBoard, description: i.props.Description ?? "" };
    }
    const footprints: Record<string, string[] | null> = {};
    for (const id of footprintIds) footprints[id] = this.footprintPads(id) ?? null;
    return { symbols, footprints };
  }

  async symbolIndex(): Promise<SymbolSearchHit[]> {
    if (this.symIndex) return this.symIndex;
    const hits: SymbolSearchHit[] = [];
    for (const e of this.tables.symbols) {
      if (!e.uri.endsWith(".kicad_sym")) continue;
      try {
        const text = await fs.readFile(e.uri, "utf8");
        for (const s of scanSymbolNames(text)) hits.push({ libId: `${e.nickname}:${s.name}`, description: s.description, keywords: s.keywords });
      } catch { /* unreadable library */ }
    }
    this.symIndex = hits;
    return hits;
  }

  async footprintIndex(): Promise<FootprintSearchHit[]> {
    if (this.fpIndex) return this.fpIndex;
    const hits: FootprintSearchHit[] = [];
    for (const e of this.tables.footprints) {
      try {
        for (const n of await fs.readdir(e.uri)) if (n.endsWith(".kicad_mod")) hits.push({ fpId: `${e.nickname}:${n.slice(0, -10)}` });
      } catch { /* missing dir */ }
    }
    this.fpIndex = hits;
    return hits;
  }
}

/** Case-insensitive multi-word search; every word must appear. Exact name matches rank first. */
export function searchHits<T>(items: T[], text: (t: T) => string, name: (t: T) => string, query: string, limit = 50): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { t: T; s: number }[] = [];
  for (const it of items) {
    const hay = text(it).toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const n = name(it).toLowerCase();
    const s = (n === query.toLowerCase() ? 0 : n.endsWith(`:${query.toLowerCase()}`) ? 1 : n.includes(words[0]) ? 2 : 3) * 1000 + n.length;
    scored.push({ t: it, s });
  }
  return scored.sort((a, b) => a.s - b.s).slice(0, limit).map((x) => x.t);
}

/**
 * Project-level sym-lib-table / fp-lib-table naming only the libraries a project uses, through KiCad's
 * own path variables. Written only when the user has no global tables (fresh KiCad install), so the
 * project still resolves its libraries in KiCad and kicad-cli. Returns null when not needed.
 */
export function projectLibTables(libs: KicadLibraries, symbolLibs: string[], footprintLibs: string[]): { sym: string; fp: string } | null {
  if (libs.tables.source === "user") return null;
  const v = libs.kicad.major;
  const row = (nick: string, uri: string) => `\t(lib (name "${nick}") (type "KiCad") (uri "${uri}") (options "") (descr ""))`;
  const sym = [`(sym_lib_table`, `\t(version 7)`,
    ...[...new Set(symbolLibs)].sort().filter((n) => libs.symbolLibPath(n)).map((n) => row(n, `\${KICAD${v}_SYMBOL_DIR}/${n}.kicad_sym`)), `)`, ``].join("\n");
  const fp = [`(fp_lib_table`, `\t(version 7)`,
    ...[...new Set(footprintLibs)].sort().filter((n) => libs.footprintLibPath(n)).map((n) => row(n, `\${KICAD${v}_FOOTPRINT_DIR}/${n}.pretty`)), `)`, ``].join("\n");
  return { sym, fp };
}
