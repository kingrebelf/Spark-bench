// Repeatable README screenshot pipeline.
//
//   node scripts/capture/capture.mjs            # dark theme PNGs + demo animation
//   node scripts/capture/capture.mjs --light    # also light-theme variants (*-light.png)
//   node scripts/capture/capture.mjs --only=transient,bode --no-anim
//
// Starts the Vite dev server on a free port, drives the app through `window.__sb` (dev only),
// and writes 2x PNGs to docs/images/. The demo animation is stitched into a GIF
// with ffmpeg (from screenshot frames) when ffmpeg is on PATH.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { scenes, rcLowpass } from "./scenes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "docs/images");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const VIEWPORT = { width: 1440, height: 900 };

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startVite(port) {
  const vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stderr.on("data", (d) => process.stderr.write(d));
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return { vite, url }; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  vite.kill();
  throw new Error("Vite dev server did not start");
}

function loadProjectSource([file, fallback]) {
  if (file && existsSync(join(root, file))) return JSON.parse(readFileSync(join(root, file), "utf8"));
  return fallback();
}

async function openApp(browser, url, colorScheme, extra = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme, ...extra });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.warn(`  page error: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__sb, null, { timeout: 30000 });
  return { context, page };
}

async function loadProject(page, project) {
  await page.evaluate((p) => {
    window.__sb.useSim.getState().reset?.();
    window.__sb.useProject.getState().load(p);
  }, project);
  await page.waitForTimeout(300);
}

async function runSim(page, analysis) {
  return page.evaluate(async (a) => {
    await window.__sb.useSim.getState().run(a);
    const s = window.__sb.useSim.getState();
    return { status: s.status, diagnostics: (s.result?.diagnostics ?? []).map((d) => `${d.severity}: ${d.message}`) };
  }, analysis);
}

/** Click a right-panel tab or button by its visible label. Returns false if it doesn't exist. */
async function clickByText(page, label) {
  const tab = page.locator(".tabs button", { hasText: label }).first();
  if (await tab.count()) { await tab.click(); return true; }
  const any = page.getByRole("button", { name: label, exact: true }).first();
  if (await any.count()) { await any.click(); return true; }
  return false;
}

async function capture(scene, page, suffix) {
  console.log(`- ${scene.name}${suffix}`);
  await loadProject(page, loadProjectSource(scene.project));
  if (scene.select) {
    await page.evaluate((ref) => {
      const s = window.__sb.useProject.getState();
      const c = s.project.schematic.components.find((x) => x.ref === ref);
      if (c) s.setSelection([c.id]);
    }, scene.select);
  }
  if (scene.search) await page.getByPlaceholder(/search parts/i).fill(scene.search);
  if (scene.panel && !(await clickByText(page, scene.panel))) {
    if (scene.panel !== "Properties") { console.warn(`  skipped: no "${scene.panel}" panel in this build`); return false; }
  }
  if (scene.run) {
    const r = await runSim(page, scene.run);
    const failed = r.status !== "done";
    if (failed !== !!scene.expectFail) {
      console.warn(`  skipped: simulation status ${r.status}\n    ${r.diagnostics.join("\n    ")}`);
      return false;
    }
    await page.waitForTimeout(600);
  }
  if (scene.cursors) {
    // Place two cursors if the scope supports clicking to place them (sim session owns the details).
    const plot = page.locator(".scope svg, .scope canvas").first();
    if (await plot.count()) {
      const box = await plot.boundingBox();
      if (box) {
        await plot.click({ position: { x: box.width * 0.3, y: box.height / 2 } });
        await plot.click({ position: { x: box.width * 0.6, y: box.height / 2 }, modifiers: ["Shift"] });
      }
    }
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const target = scene.focus ? page.locator(scene.focus).first() : null;
  const file = join(outDir, `${scene.name}${suffix}.png`);
  if (target && (await target.count())) await target.screenshot({ path: file });
  else await page.screenshot({ path: file });
  if (scene.search) await page.getByPlaceholder(/search parts/i).fill("");
  return true;
}

/** Short demo: build the RC filter part by part, then run the transient and show the trace. */
async function recordAnimation(browser, url) {
  // Frames are screenshots (crisper than screen recording, no video codec needed) stitched by ffmpeg.
  const frameDir = join(root, "test-output/capture-frames");
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const frames = [];
  const snap = async (seconds) => {
    const f = join(frameDir, `f${String(frames.length).padStart(3, "0")}.png`);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: f });
    frames.push([f, seconds]);
  };
  const { context, page } = await openApp(browser, url, "dark", { deviceScaleFactor: 1 });
  const full = rcLowpass("tran");
  const empty = { ...full, schematic: { components: [], wires: [], labels: [] } };
  await loadProject(page, empty);
  await snap(0.8);
  // Each step is [history label, schematic collection, item]; plain data so it can cross into the page.
  const steps = [
    ...full.schematic.components.map((c) => ["Place part", "components", c]),
    ...full.schematic.wires.map((w) => ["Add wire", "wires", w]),
    ...full.schematic.labels.map((l) => ["Add label", "labels", l]),
  ];
  for (const step of steps) {
    await page.evaluate(([label, key, item]) => {
      window.__sb.useProject.getState().update(label, (d) => { d.schematic[key].push(item); });
    }, step);
    await page.waitForTimeout(150);
    await snap(0.45);
  }
  const r = await runSim(page, "tran");
  if (r.status !== "done") console.warn(`  demo simulation ${r.status}`);
  await page.waitForTimeout(500);
  await snap(3.5);
  await context.close();
  return frames;
}

function toGif(frames) {
  const gif = join(outDir, "demo.gif");
  const list = join(dirname(frames[0][0]), "frames.txt");
  // concat demuxer: the last file is repeated so its duration is honored.
  const lines = frames.flatMap(([f, s]) => [`file '${f.replace(/\\/g, "/")}'`, `duration ${s}`]);
  writeFileSync(list, [...lines, `file '${frames.at(-1)[0].replace(/\\/g, "/")}'`].join("\n"));
  const ff = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-vf",
    "fps=10,scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    "-loop", "0", gif], { stdio: "ignore" });
  if (ff.status !== 0) { console.warn("  ffmpeg not found or failed; demo.gif not written (frames kept in test-output/)"); return; }
  console.log(`- demo.gif (${(statSync(gif).size / 1e6).toFixed(2)} MB)`);
}

/** Playwright's own Chromium if downloaded, else an installed Chrome or Edge (no download needed). */
async function launchBrowser() {
  for (const channel of [undefined, "chrome", "msedge"]) {
    try { return await chromium.launch(channel ? { channel } : {}); } catch {}
  }
  throw new Error("No Chromium found: run `npx playwright install chromium` or install Chrome.");
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  const { vite, url } = await startVite(port);
  const browser = await launchBrowser();
  try {
    const schemes = flag("light") ? [["dark", ""], ["light", "-light"]] : [["dark", ""]];
    for (const [scheme, suffix] of schemes) {
      const { context, page } = await openApp(browser, url, scheme);
      for (const scene of scenes) if (!only || only.includes(scene.name)) await capture(scene, page, suffix);
      await context.close();
    }
    if (!flag("no-anim") && (!only || only.includes("demo"))) {
      console.log("- demo");
      toGif(await recordAnimation(browser, url));
    }
  } finally {
    await browser.close();
    vite.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
