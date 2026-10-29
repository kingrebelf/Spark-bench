// Writing a KiCad project folder and validating it with KiCad's own tools (Node only).
// The schematic text is produced by the pure exporter (src/kicad/exportSch.ts) in the renderer.
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { ExportedPart } from "../exportSch";
import { exportProjectFile } from "../exportSch";
import { diffNetlists, parseKicadNetlist, type NetlistChanges } from "../netlist";
import { arg, child, parse } from "../sexpr";
import { splitLibId } from "../symbols";
import { verifyConnectivity, type ConnectivityCheck } from "../verify";
import { exportNetlist, runDrc, runErc, writeText, type DrcReport, type ErcReport } from "./cli";
import type { KicadInstall } from "./install";
import { projectLibTables, type KicadLibraries } from "./libs";
import { generatePcb, type PcbResult } from "./pcb";

export interface ExistingProject {
  dir: string;
  name: string;
  exists: boolean;
  /** Root sheet UUID of the existing schematic, reused so symbol paths stay stable. */
  rootUuid?: string;
  hasPcb: boolean;
  /** Generator of the existing schematic ("sparkbench", "eeschema", ...). */
  generator?: string;
}

export async function inspectProject(dir: string, name: string): Promise<ExistingProject> {
  const sch = path.join(dir, `${name}.kicad_sch`);
  const hasPcb = existsSync(path.join(dir, `${name}.kicad_pcb`));
  if (!existsSync(sch)) return { dir, name, exists: false, hasPcb };
  try {
    const t = parse(await fs.readFile(sch, "utf8"));
    return { dir, name, exists: true, rootUuid: arg(child(t, "uuid")), hasPcb, generator: arg(child(t, "generator")) };
  } catch { return { dir, name, exists: true, hasPcb }; }
}

/** Find the project stem in a folder (the .kicad_pro file), if any. */
export async function projectNameIn(dir: string): Promise<string | undefined> {
  try { return (await fs.readdir(dir)).find((f) => f.endsWith(".kicad_pro"))?.slice(0, -".kicad_pro".length); } catch { return undefined; }
}

export interface WriteProjectArgs {
  dir: string;
  name: string;
  schText: string;
  parts: ExportedPart[];
  expectedNets: string[][];
  /** Regenerate an existing project (backs up, reports changes). */
  update: boolean;
  /** Also create/update the PCB. */
  pcb: boolean;
  /** Schematic position (mm) by reference, to keep schematic neighbours together on the board. */
  schPos?: Record<string, { x: number; y: number }>;
}

export interface WriteProjectResult {
  dir: string;
  files: string[];
  backups: string[];
  erc: ErcReport;
  connectivity: ConnectivityCheck | { error: string };
  changes?: NetlistChanges;
  pcb?: PcbResult | { error: string };
  drc?: DrcReport;
  notes: string[];
}

export async function writeProject(k: KicadInstall, libs: KicadLibraries, a: WriteProjectArgs): Promise<WriteProjectResult> {
  const files: string[] = [];
  const backups: string[] = [];
  const notes: string[] = [];
  await fs.mkdir(a.dir, { recursive: true });
  const sch = path.join(a.dir, `${a.name}.kicad_sch`);
  const pro = path.join(a.dir, `${a.name}.kicad_pro`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Netlist of the schematic being replaced, for the change report.
  let before: string | undefined;
  if (a.update && existsSync(sch)) {
    try { before = await exportNetlist(k, sch); } catch (e) { notes.push(`Could not read the previous schematic's netlist: ${(e as Error).message}`); }
    const bak = `${sch}.${stamp}.bak`;
    await fs.copyFile(sch, bak);
    backups.push(bak);
  }

  let existingPro: string | undefined;
  try { existingPro = await fs.readFile(pro, "utf8"); } catch { /* new */ }
  let template: string | undefined;
  try { template = await fs.readFile(path.join(k.templateDir, "kicad.kicad_pro"), "utf8"); } catch { /* no template */ }
  await writeText(pro, exportProjectFile(a.name, template, existingPro));
  files.push(pro);
  await writeText(sch, a.schText);
  files.push(sch);

  const tables = projectLibTables(libs,
    a.parts.map((p) => splitLibId(p.libId).lib).concat(["power"]),
    a.parts.filter((p) => p.footprint).map((p) => splitLibId(p.footprint).lib));
  if (tables) {
    for (const [f, text] of [["sym-lib-table", tables.sym], ["fp-lib-table", tables.fp]] as const) {
      const p = path.join(a.dir, f);
      if (existsSync(p)) { notes.push(`Kept the existing ${f}.`); continue; }
      await writeText(p, text);
      files.push(p);
    }
    notes.push("KiCad has no global library tables configured yet, so project library tables listing the used KiCad libraries were written.");
  }

  const erc = await runErc(k, sch);
  let connectivity: WriteProjectResult["connectivity"];
  let after: string | undefined;
  try {
    after = await exportNetlist(k, sch);
    let spice: string | null = null;
    try { spice = await exportNetlist(k, sch, "spice"); } catch (e) { notes.push(`KiCad could not write a SPICE netlist: ${(e as Error).message}`); }
    connectivity = verifyConnectivity({ parts: a.parts, expectedNets: a.expectedNets }, after, spice);
  } catch (e) {
    connectivity = { error: (e as Error).message };
  }
  const changes = before && after ? diffNetlists(parseKicadNetlist(before), parseKicadNetlist(after)) : undefined;

  let pcb: WriteProjectResult["pcb"];
  let drc: DrcReport | undefined;
  if (a.pcb) {
    if (!after) pcb = { error: "The PCB was not generated because KiCad could not read the exported schematic." };
    else if (!k.python) pcb = { error: "This KiCad installation has no bundled Python (pcbnew), which SparkBench needs to build the PCB." };
    else {
      const pcbPath = path.join(a.dir, `${a.name}.kicad_pcb`);
      try {
        pcb = await generatePcb(k, libs, { pcbPath, netlistText: after, update: a.update, schPos: a.schPos });
        if (pcb.backup) backups.push(pcb.backup);
        files.push(pcbPath);
        drc = await runDrc(k, pcbPath);
      } catch (e) { pcb = { error: (e as Error).message }; }
    }
  }
  return { dir: a.dir, files, backups, erc, connectivity, changes, pcb, drc, notes };
}
