// Renderer-side KiCad actions: talk to the main process over "sb:kicad:*" IPC and run the pure
// exporter/importer here, where the part library lives.
import { host } from "../core/host";
import { getPart } from "../core/library";
import type { Project } from "../core/types";
import { gridToMm } from "./common";
import { exportSchematic, type SchExport } from "./exportSch";
import { importSchematic, type ImportResult } from "./importSch";
import { mappingIds, reviewMapping, type LibraryFacts, type MappingRow } from "./mapping";
import { parse, type SList } from "./sexpr";

export interface KicadStatus {
  found: boolean; version?: string; root?: string; source?: string; hasPython?: boolean; canOpen?: boolean; libraryTables?: string; message: string;
}
export interface SymbolHit { libId: string; description: string; keywords: string }
export interface FootprintHit { fpId: string }

// Mirrors of the main-process result shapes (src/kicad/node/*), kept structural to avoid importing Node code.
export interface Violation { severity: string; type: string; description: string; items: { description: string; pos?: { x: number; y: number } }[] }
export interface WriteResult {
  dir: string; files: string[]; backups: string[];
  erc: { ok: boolean; violations: Violation[]; errors: number; warnings: number; cliError?: string };
  connectivity: { equal: boolean; summary: string; onlyInSparkbench: string[][]; onlyInKicad: string[][]; checkedPins: number } | { error: string };
  changes?: { added: string[]; removed: string[]; changed: string[]; rewired: string[] };
  pcb?: {
    pcbPath: string; placed: { ref: string; fpId: string; kept: boolean }[]; removed: string[]; replaced: string[];
    skipped: { ref: string; reason: string }[]; nets: number; outline: { w: number; h: number } | null; keptTracks: number; mode: "new" | "update"; backup?: string;
  } | { error: string };
  drc?: { ok: boolean; violations: Violation[]; unconnected: Violation[]; footprintIssues: Violation[]; cliError?: string };
  notes: string[];
}
export interface ExistingProject { dir: string; name: string; exists: boolean; rootUuid?: string; hasPcb: boolean; generator?: string }

export const kicadApi = {
  available: () => host.available,
  detect: (refresh = false) => host.invoke<KicadStatus>("sb:kicad:detect", refresh),
  facts: (a: { symbols: string[]; footprints: string[] }) => host.invoke<LibraryFacts>("sb:kicad:facts", a),
  searchSymbols: (q: string) => host.invoke<SymbolHit[]>("sb:kicad:searchSymbols", q),
  searchFootprints: (q: string) => host.invoke<FootprintHit[]>("sb:kicad:searchFootprints", q),
  chooseFolder: (defaultPath?: string) => host.invoke<{ dir: string; existingName?: string } | null>("sb:kicad:chooseFolder", defaultPath),
  inspect: (dir: string, name: string) => host.invoke<ExistingProject>("sb:kicad:inspect", { dir, name }),
  openSchematicFile: () => host.invoke<{ path: string; text: string } | null>("sb:kicad:openSchematicFile"),
  openInKicad: (file: string) => host.invoke<boolean>("sb:kicad:openInKicad", file),
  showFolder: (dir: string) => host.invoke<boolean>("sb:kicad:showFolder", dir),
};

export async function runMappingReview(project: Project): Promise<MappingRow[]> {
  const ids = mappingIds(project);
  return reviewMapping(project, await kicadApi.facts(ids));
}

/** File stem KiCad is happy with. */
export const safeName = (s: string) => s.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "sparkbench";

export interface ExportRun { ex: SchExport; result: WriteResult; existing: ExistingProject }

export async function exportToKicad(project: Project, dir: string, name: string, opts: { pcb: boolean; update: boolean }): Promise<ExportRun> {
  const ids = mappingIds(project).symbols.concat(["power:GND"]);
  const texts = await host.invoke<Record<string, string | null>>("sb:kicad:symbols", ids);
  const cache = new Map<string, SList>();
  const symbols = { symbol: (id: string) => {
    if (!cache.has(id) && texts[id]) cache.set(id, parse(texts[id]!));
    return cache.get(id);
  } };
  const existing = await kicadApi.inspect(dir, name);
  const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const ex = exportSchematic({ project, name, symbols, rootUuid: opts.update ? existing.rootUuid : undefined, eol: windows ? "\r\n" : "\n" });
  const schPos: Record<string, { x: number; y: number }> = {};
  for (const p of ex.parts) {
    const c = project.schematic.components.find((x) => x.id === p.componentId);
    if (c) schPos[p.ref] = { x: gridToMm(c.position.x), y: gridToMm(c.position.y) };
  }
  const result = await host.invoke<WriteResult>("sb:kicad:write", {
    dir, name, schText: ex.text, parts: ex.parts, expectedNets: ex.expectedNets, update: opts.update && existing.exists, pcb: opts.pcb, schPos,
  });
  return { ex, result, existing };
}

export async function importFromKicad(): Promise<(ImportResult & { path: string }) | null> {
  const f = await kicadApi.openSchematicFile();
  if (!f) return null;
  const name = f.path.split(/[\\/]/).pop()!.replace(/\.kicad_sch$/, "");
  return { ...importSchematic(f.text, { name, lookup: getPart }), path: f.path };
}
