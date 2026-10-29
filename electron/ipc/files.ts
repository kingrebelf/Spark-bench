// Project file dialogs, read/write and crash recovery.
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

const FILTERS = [{ name: "SparkBench project", extensions: ["sbproj"] }, { name: "All files", extensions: ["*"] }];
const recoveryFile = () => path.join(app.getPath("userData"), "recovery", "autosave.sbproj");

export function registerFileIpc(): void {
  ipcMain.handle("sb:file:open", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showOpenDialog(win, { filters: FILTERS, properties: ["openFile"] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], text: await fs.readFile(r.filePaths[0], "utf8") };
  });
  ipcMain.handle("sb:file:read", async (_e, p: string) => ({ path: p, text: await fs.readFile(p, "utf8") }));
  ipcMain.handle("sb:file:save", async (e, args: { path?: string | null; text: string; defaultName?: string }) => {
    let target = args.path ?? null;
    if (!target) {
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showSaveDialog(win, { filters: FILTERS, defaultPath: args.defaultName ?? "untitled.sbproj" });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    // Write atomically so a crash mid-save never destroys the previous file.
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, args.text, "utf8");
    await fs.rename(tmp, target);
    return { path: target };
  });
  /** Generic save dialog for exports (CSV, netlists, ...). Returns chosen path or null. */
  ipcMain.handle("sb:file:saveAs", async (e, args: { text: string; defaultName: string; filters?: { name: string; extensions: string[] }[] }) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const r = await dialog.showSaveDialog(win, { defaultPath: args.defaultName, filters: args.filters });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, args.text, "utf8");
    return { path: r.filePath };
  });
  ipcMain.handle("sb:recovery:write", async (_e, text: string) => {
    await fs.mkdir(path.dirname(recoveryFile()), { recursive: true });
    await fs.writeFile(recoveryFile(), text, "utf8");
  });
  ipcMain.handle("sb:recovery:read", async () => {
    try {
      const st = await fs.stat(recoveryFile());
      return { text: await fs.readFile(recoveryFile(), "utf8"), modified: st.mtime.toISOString() };
    } catch { return null; }
  });
  ipcMain.handle("sb:recovery:clear", async () => { await fs.rm(recoveryFile(), { force: true }); });
}
