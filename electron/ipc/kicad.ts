// KiCad integration in the main process: install detection, library access, kicad-cli/pcbnew runs,
// project folder output, and opening results in KiCad. All channels are "sb:kicad:*".
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compact } from "../../src/kicad/sexpr";
import { findKicad, type KicadInstall } from "../../src/kicad/node/install";
import { KicadLibraries, searchHits } from "../../src/kicad/node/libs";
import { inspectProject, projectNameIn, writeProject, type WriteProjectArgs } from "../../src/kicad/node/project";

let libs: KicadLibraries | null = null;
function kicad(): KicadInstall {
  const k = findKicad();
  if (!k) throw new Error("KiCad was not found. Install KiCad 10 from kicad.org, then reopen this panel.");
  if (!libs || libs.kicad.root !== k.root) libs = new KicadLibraries(k);
  return k;
}
const lib = () => { kicad(); return libs!; };

export interface KicadStatus {
  found: boolean;
  version?: string;
  root?: string;
  source?: string;
  hasPython?: boolean;
  canOpen?: boolean;
  libraryTables?: string;
  message: string;
}

export function registerKicadIpc(): void {
  ipcMain.handle("sb:kicad:detect", async (_e, refresh?: boolean): Promise<KicadStatus> => {
    const k = findKicad(!!refresh);
    if (!k) return { found: false, message: "KiCad was not found (looked in the Windows uninstall registry and the usual install folders). Install KiCad 10 from kicad.org to export, import and build PCBs." };
    libs = new KicadLibraries(k);
    const warn = k.major !== 10 ? ` SparkBench targets KiCad 10.0.x; ${k.version} is untested.` : "";
    return {
      found: true, version: k.version, root: k.root, source: k.source, hasPython: !!k.python, canOpen: !!k.kicadExe,
      libraryTables: libs.tables.source,
      message: `KiCad ${k.version} found at ${k.root}.${k.python ? "" : " Its bundled Python (pcbnew) is missing, so PCB generation is unavailable."}${warn}`,
    };
  });

  /** Embedded symbol text for each lib_id (null = not installed). */
  ipcMain.handle("sb:kicad:symbols", async (_e, ids: string[]) => {
    const out: Record<string, string | null> = {};
    for (const id of ids) { const s = lib().symbol(id); out[id] = s ? compact(s) : null; }
    return out;
  });
  ipcMain.handle("sb:kicad:facts", async (_e, a: { symbols: string[]; footprints: string[] }) => lib().facts(a.symbols, a.footprints));
  ipcMain.handle("sb:kicad:searchSymbols", async (_e, q: string) =>
    searchHits(await lib().symbolIndex(), (h) => `${h.libId} ${h.description} ${h.keywords}`, (h) => h.libId, q, 60));
  ipcMain.handle("sb:kicad:searchFootprints", async (_e, q: string) =>
    searchHits(await lib().footprintIndex(), (h) => h.fpId, (h) => h.fpId, q, 60));

  ipcMain.handle("sb:kicad:chooseFolder", async (e, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(win, { title: "KiCad project folder", defaultPath, properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    return { dir, existingName: await projectNameIn(dir) };
  });
  ipcMain.handle("sb:kicad:inspect", async (_e, a: { dir: string; name: string }) => inspectProject(a.dir, a.name));
  ipcMain.handle("sb:kicad:write", async (_e, a: WriteProjectArgs) => writeProject(kicad(), lib(), a));

  ipcMain.handle("sb:kicad:openSchematicFile", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(win, { title: "Import KiCad schematic", filters: [{ name: "KiCad schematic", extensions: ["kicad_sch"] }], properties: ["openFile"] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], text: await fs.readFile(r.filePaths[0], "utf8") };
  });

  /** Open the project (or a file) in KiCad's project manager. */
  ipcMain.handle("sb:kicad:openInKicad", async (_e, file: string) => {
    const k = kicad();
    if (!k.kicadExe) throw new Error("KiCad's main program was not found next to kicad-cli.");
    await fs.access(file);
    spawn(k.kicadExe, [file], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return true;
  });
  ipcMain.handle("sb:kicad:showFolder", async (_e, dir: string) => { await shell.openPath(path.resolve(dir)); return true; });
}
