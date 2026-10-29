// Page helpers shared by the capture scenes and the demo recording.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const readExample = (name) => JSON.parse(readFileSync(join(root, "examples", `${name}.sbproj`), "utf8"));

/** Replace the open project (same path as File → Open, minus the dialog). */
export async function loadProject(page, project) {
  await page.evaluate((p) => {
    window.__sb.useSim.getState().reset?.();
    window.__sb.useProject.getState().load(p);
  }, project);
  await page.waitForTimeout(300);
  await fit(page);
}

export async function fit(page) {
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(250);
}

export async function tab(page, label) {
  await page.locator(".right .tabs button, .right [role=tab]", { hasText: label }).first().click();
  await page.waitForTimeout(300);
}

/** Choose an analysis in the sim bar and press Run; resolves when the run finishes. */
export async function runAnalysis(page, kind) {
  await page.evaluate(async (k) => { await window.__sb.useSim.getState().run(k); }, kind);
  await page.waitForTimeout(500);
  return page.evaluate(() => window.__sb.useSim.getState().status);
}

export async function selectRef(page, ref) {
  await page.evaluate((r) => {
    const s = window.__sb.useProject.getState();
    const c = s.project.schematic.components.find((x) => x.ref === r);
    if (c) s.setSelection([c.id]);
  }, ref);
  await page.waitForTimeout(250);
}

/** Screen position (CSS px) of a schematic point in grid units. */
export async function worldToScreen(page, x, y) {
  return page.evaluate(([x, y]) => {
    const g = document.querySelector(`svg.sb-canvas g[transform^="scale("]`);
    const m = g.getScreenCTM();
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }, [x, y]);
}

export async function clickPart(page, ref) {
  const pos = await page.evaluate((r) => window.__sb.useProject.getState().project.schematic.components.find((c) => c.ref === r)?.position, ref);
  const p = await worldToScreen(page, pos.x, pos.y);
  await page.mouse.click(p.x, p.y);
}

export const calm = async (page) => { await page.mouse.move(1150, 26); await page.waitForTimeout(200); };

/** Collapse the analysis setup column and make the simulation panel taller (dy CSS px). */
export async function roomForScope(page, dy = 160) {
  const setup = page.getByRole("button", { name: "◂ Setup" });
  if (await setup.count()) await setup.click();
  const bar = await page.locator(".sim-resize").boundingBox();
  if (bar && dy) {
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 - dy, { steps: 5 });
    await page.mouse.up();
  }
  await page.waitForTimeout(300);
}

/** Current playback time in seconds, read from the "t / end" readout next to Pause. */
export const playTime = (page) => page.evaluate(() => {
  const m = document.querySelector(".center")?.innerText.match(/([\d.]+)\s*(n|µ|m)?s\s*\/\s*[\d.]+\s*(n|µ|m)?s/);
  if (!m) return null;
  return Number(m[1]) * ({ n: 1e-9, "µ": 1e-6, m: 1e-3 }[m[2]] ?? 1);
});

/** Wait until a canvas probe label (e.g. "I(D1) = 6.8 mA") matches `re`, polling every frame-ish. */
export async function waitForLabel(page, re, timeout = 15000) {
  const src = re.source;
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector("svg.sb-canvas")?.textContent ?? ""), src, { timeout, polling: 30 });
}

/** Bounding box covering every matched element, padded. */
export async function unionBox(page, selectors, pad = 8) {
  const boxes = [];
  for (const sel of selectors) { const b = await page.locator(sel).first().boundingBox(); if (b) boxes.push(b); }
  const x = Math.min(...boxes.map((b) => b.x)) - pad, y = Math.min(...boxes.map((b) => b.y)) - pad;
  const r = Math.max(...boxes.map((b) => b.x + b.width)) + pad, btm = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  return { x: Math.max(0, x), y: Math.max(0, y), width: r - Math.max(0, x), height: btm - Math.max(0, y) };
}

/** Public screenshots must not show the local account name: rewrite the home folder in visible text. */
export async function redactHome(page) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return;
  const generic = join(dirname(home), "you");
  await page.evaluate(([home, generic]) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.includes(home)) n.nodeValue = n.nodeValue.split(home).join(generic);
    }
  }, [home, generic]);
}
