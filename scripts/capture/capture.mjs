// Repeatable README screenshot pipeline.
//
//   node scripts/capture/capture.mjs                 # every scene + the live-mode animation
//   node scripts/capture/capture.mjs --only=live,bode --no-anim
//   node scripts/capture/capture.mjs --light         # light theme instead of dark
//
// Runs the real desktop app (Electron + Vite dev server) through Playwright with a throwaway
// user-data folder, so your own settings, AI keys and recovery files are never touched.
// Writes 2x PNGs to docs/images/ and, with ffmpeg on PATH, docs/images/demo.gif.
// The AI scene replays a recorded Codex reply (tests/aiCodexReply.json) through the real
// review pipeline; the KiCad scene exports into a temp folder and renders the board with kicad-cli.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { root } from "./helpers.mjs";
import { scenes } from "./scenes.mjs";
import { recordDemo } from "./demo.mjs";

export const outDir = join(root, "docs/images");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
export const SIZE = { width: 1600, height: 1000 };

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startVite(port) {
  const vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
  });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return { vite, url }; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  vite.kill();
  throw new Error("Vite dev server did not start");
}

/** Launch the desktop app; returns { app, page, userData, close }. */
export async function launchApp(url, { theme = "dark", scale = 2 } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "sb-capture-"));
  const app = await _electron.launch({
    executablePath: join(root, "node_modules/electron/dist/electron.exe"),
    args: [
      root, `--user-data-dir=${userData}`, `--force-device-scale-factor=${scale}`,
      // Live playback runs on requestAnimationFrame: keep it running when the window is covered.
      "--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, nativeTheme }, [w, h, t]) => {
    nativeTheme.themeSource = t;
    BrowserWindow.getAllWindows()[0].setContentSize(w, h);
  }, [SIZE.width, SIZE.height, theme]);
  page.on("pageerror", (e) => console.warn(`  page error: ${e.message}`));
  page.on("crash", () => console.warn("  renderer crashed"));
  if (process.env.CAPTURE_DEBUG) page.on("console", (m) => console.log(`  console.${m.type()}: ${m.text().slice(0, 400)}`));
  await page.reload();
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForFunction(() => !!window.__sb, null, { timeout: 60000 });
  // The OS can veto or delay the resize; insist until the page really has SIZE.
  for (let i = 0; ; i++) {
    const ok = await page.evaluate(([w, h]) => window.innerWidth === w && Math.abs(window.innerHeight - h) <= 2, [SIZE.width, SIZE.height]);
    if (ok) break;
    if (i === 20) throw new Error(`window could not be resized to the capture size: ${await page.evaluate(() => [innerWidth, innerHeight, screen.availWidth, screen.availHeight, devicePixelRatio].join(" "))}`);
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(w, h);
    }, [SIZE.width, SIZE.height]);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(800);
  const close = async () => { await app.close(); rmSync(userData, { recursive: true, force: true }); };
  // The window frame can make the page a few pixels off; screenshots are clipped to SIZE.
  const shot = (path, clip = { x: 0, y: 0, ...SIZE }) => page.screenshot({ path, clip });
  return { app, page, userData, close, shot };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(root, "test-output"), { recursive: true });
  console.log("building electron main…");
  const b = spawnSync("npm run build:electron", { cwd: root, stdio: "ignore", shell: true });
  if (b.status !== 0) throw new Error("npm run build:electron failed");
  const { vite, url } = await startVite(await freePort());
  const theme = flag("light") ? "light" : "dark";
  const suffix = flag("light") ? "-light" : "";
  try {
    for (const scene of scenes) {
      if (only && !only.includes(scene.name)) continue;
      console.log(`- ${scene.name}${suffix}`);
      const s = await launchApp(url, { theme });
      try {
        await scene.run({ ...s, file: (n = scene.name) => join(outDir, `${n}${suffix}.png`) });
      } catch (e) {
        console.warn(`  FAILED: ${e.message}`);
        await s.page.screenshot({ path: join(root, "test-output", `capture-fail-${scene.name}.png`) }).catch(() => {});
      } finally {
        await s.close();
      }
    }
    if (!flag("no-anim") && (!only || only.includes("demo"))) {
      console.log("- demo");
      const s = await launchApp(url, { theme, scale: 1 });
      try { await recordDemo(s); } finally { await s.close(); }
    }
  } finally {
    vite.kill();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
