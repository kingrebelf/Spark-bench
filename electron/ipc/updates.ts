// Launcher backend: app info, launcher settings, release notes from GitHub (cached for offline use), external
// links, and auto-updates through electron-updater (GitHub provider). See docs/updates.md.
import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import type { AppUpdater } from "electron-updater";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELEASES_API_URL, RELEASES_URL, REPO_NAME, REPO_OWNER, UPDATE_CHECK_INTERVAL_MS } from "../../src/launcher/config";
import { fromGithubReleases, type NotesResult } from "../../src/launcher/notes";
import { initialUpdateState, isPortable, updateReducer, type UpdateEvent, type UpdateState } from "../../src/launcher/updateState";

export interface LauncherSettings {
  /** Offer pre-releases (all releases are pre-releases for now). */
  beta: boolean;
  /** Go straight to the editor; the launcher stays reachable from the toolbar. */
  skipOnStartup: boolean;
  /** Version the user last launched, for "what's new". */
  lastSeenVersion?: string;
  recent: { path: string; name: string; openedAt: string }[];
}

const DEFAULTS: LauncherSettings = { beta: true, skipOnStartup: false, recent: [] };
const RECENT_MAX = 8;
const settingsFile = () => path.join(app.getPath("userData"), "launcher.json");
const notesCache = () => path.join(app.getPath("userData"), "release-notes.json");

let settings: LauncherSettings | null = null;
async function loadSettings(): Promise<LauncherSettings> {
  if (settings) return settings;
  try { settings = { ...DEFAULTS, ...JSON.parse(await fs.readFile(settingsFile(), "utf8")) }; }
  catch { settings = { ...DEFAULTS }; }
  if (!Array.isArray(settings!.recent)) settings!.recent = [];
  return settings!;
}
async function saveSettings(next: LauncherSettings) {
  settings = next;
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  const tmp = settingsFile() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, settingsFile());
}

/** Only https URLs leave the app (release pages, donate link, GitHub issues). */
export function openHttps(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  void shell.openExternal(u.toString());
  return true;
}

// ------------------------------------------------------------------------------------------------ updates
let state: UpdateState = initialUpdateState(app.getVersion());
let updater: AppUpdater | null = null;

function emit(e: UpdateEvent) {
  state = updateReducer(state, e);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("sb:updates:changed", state);
}

async function getUpdater(): Promise<AppUpdater> {
  if (updater) return updater;
  // Loaded lazily: dev runs never touch it. Bundled by esbuild into dist-electron/main.js.
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.setFeedURL({ provider: "github", owner: REPO_OWNER, repo: REPO_NAME });
  autoUpdater.autoDownload = false;          // download only when the user says so
  autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update installs when the app closes
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info: () => {}, warn: (m: unknown) => console.warn("[updates]", m), error: (m: unknown) => console.error("[updates]", m), debug: () => {} };
  autoUpdater.on("checking-for-update", () => emit({ type: "checking" }));
  autoUpdater.on("update-available", (i) => emit({ type: "available", version: i.version, files: i.files }));
  autoUpdater.on("update-not-available", (i) => emit({ type: "not-available", version: i?.version }));
  autoUpdater.on("download-progress", (p) => emit({ type: "progress", percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
  autoUpdater.on("update-downloaded", (i) => emit({ type: "downloaded", version: i.version }));
  autoUpdater.on("error", (err) => emit({ type: "error", message: err?.message ?? String(err) }));
  updater = autoUpdater;
  return updater;
}

async function check(): Promise<UpdateState> {
  if (state.phase === "disabled") return state;
  try {
    const u = await getUpdater();
    u.allowPrerelease = state.beta;
    await u.checkForUpdates();
  } catch (e) {
    // Errors are also emitted through the "error" event; make sure one lands even if they weren't.
    if (state.phase === "checking" || state.phase === "idle") emit({ type: "error", message: (e as Error)?.message ?? String(e) });
  }
  return state;
}

export function registerUpdatesIpc(): void {
  ipcMain.handle("sb:launcher:info", async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    packaged: app.isPackaged,
    portable: isPortable(process.env),
  }));
  ipcMain.handle("sb:launcher:settings", () => loadSettings());
  ipcMain.handle("sb:launcher:setSettings", async (_e, patch: Partial<LauncherSettings>) => {
    const cur = await loadSettings();
    const next: LauncherSettings = { ...cur };
    if (typeof patch?.skipOnStartup === "boolean") next.skipOnStartup = patch.skipOnStartup;
    if (typeof patch?.lastSeenVersion === "string") next.lastSeenVersion = patch.lastSeenVersion.slice(0, 40);
    if (typeof patch?.beta === "boolean" && patch.beta !== cur.beta) {
      next.beta = patch.beta;
      state = { ...state, beta: patch.beta };
      if (state.phase !== "disabled" && state.phase !== "downloading" && state.phase !== "ready") void check();
    }
    await saveSettings(next);
    return next;
  });
  ipcMain.handle("sb:launcher:addRecent", async (_e, p: unknown) => {
    if (typeof p !== "string" || !/\.sbproj$/i.test(p) || !path.isAbsolute(p)) return (await loadSettings()).recent;
    const cur = await loadSettings();
    const name = path.basename(p).replace(/\.sbproj$/i, "");
    const recent = [{ path: p, name, openedAt: new Date().toISOString() }, ...cur.recent.filter((r) => r.path.toLowerCase() !== p.toLowerCase())].slice(0, RECENT_MAX);
    await saveSettings({ ...cur, recent });
    return recent;
  });
  ipcMain.handle("sb:launcher:removeRecent", async (_e, p: unknown) => {
    const cur = await loadSettings();
    const recent = cur.recent.filter((r) => r.path !== p);
    await saveSettings({ ...cur, recent });
    return recent;
  });
  ipcMain.handle("sb:launcher:openExternal", (_e, url: unknown) => openHttps(url));

  ipcMain.handle("sb:updates:notes", async (): Promise<NotesResult> => {
    try {
      const res = await net.fetch(RELEASES_API_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": `SparkBench/${app.getVersion()}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub is limiting requests right now." : `GitHub answered ${res.status}.`);
      const releases = fromGithubReleases(await res.json());
      const fetchedAt = new Date().toISOString();
      await fs.writeFile(notesCache(), JSON.stringify({ fetchedAt, releases }), "utf8").catch(() => {});
      return { source: "github", releases, fetchedAt };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const error = /fetch failed|ERR_|ENOTFOUND|timed? ?out|abort/i.test(msg) ? "You're offline or GitHub can't be reached." : msg;
      try {
        const c = JSON.parse(await fs.readFile(notesCache(), "utf8"));
        if (Array.isArray(c.releases)) return { source: "cache", releases: c.releases, fetchedAt: c.fetchedAt, error };
      } catch { /* no cache yet */ }
      return { source: "bundled", releases: [], error };
    }
  });

  ipcMain.handle("sb:updates:state", () => state);
  ipcMain.handle("sb:updates:check", () => check());
  ipcMain.handle("sb:updates:download", async () => {
    if (state.portable) { openHttps(state.version ? `${RELEASES_URL}/tag/v${state.version}` : `${RELEASES_URL}/latest`); return state; }
    if (state.phase !== "available" && !(state.phase === "error" && state.version)) return state;
    emit({ type: "download-started" });
    try { await (await getUpdater()).downloadUpdate(); }
    catch (e) { if ((state.phase as UpdateState["phase"]) === "downloading") emit({ type: "error", message: (e as Error)?.message ?? String(e) }); }
    return state;
  });
  ipcMain.handle("sb:updates:install", async () => {
    if (state.phase !== "ready" || !updater) return false;
    // Silent NSIS upgrade into the same folder, then start the new version.
    setImmediate(() => updater!.quitAndInstall(true, true));
    return true;
  });
  ipcMain.handle("sb:updates:openReleases", () => openHttps(state.version ? `${RELEASES_URL}/tag/v${state.version}` : RELEASES_URL));

  app.whenReady().then(async () => {
    const s = await loadSettings();
    state = initialUpdateState(app.getVersion(), { portable: isPortable(process.env), beta: s.beta });
    if (!app.isPackaged) {
      emit({ type: "disabled", message: "Updates are off in development runs (npm run dev). Installed builds check GitHub releases." });
      return;
    }
    setTimeout(() => void check(), 4000);
    setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS).unref?.();
  });
}
