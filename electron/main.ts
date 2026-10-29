import { app, BrowserWindow, net, protocol, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerFileIpc } from "./ipc/files";
import { registerAiIpc } from "./ipc/ai";
import { registerKicadIpc } from "./ipc/kicad";

// Each feature module registers its own IPC handlers here (files, kicad, ai, ...).
registerFileIpc();
registerAiIpc();
registerKicadIpc();

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, "..", "dist");

// Built UI is served from app://bundle/ rather than file:// so module workers (ngspice-WASM) and
// same-origin rules behave as on a web server.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function serveBundle() {
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "") || "index.html";
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0f1419",
    title: "SparkBench",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL("app://bundle/index.html");
}

app.whenReady().then(() => {
  if (!DEV_URL) serveBundle();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
