// Live-mode animation for the README: the 555 blinker (with an on/off switch added in front of the
// LED) runs live, the LED blinks and the scope scrolls; the switch is clicked off and on again.
// Frames are 1x screenshots stamped with their real time, stitched into a GIF by ffmpeg so the
// blink rate in the GIF is the real one.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fit, loadProject, readExample, roomForScope, root, worldToScreen } from "./helpers.mjs";

const outDir = join(root, "docs/images");

/** The 555 blinker with SW1 between R3 and the LED (LED and its ground moved right to make room). */
export function blinkerWithSwitch() {
  const p = readExample("555-astable-blinker");
  const sc = p.schematic;
  const d1 = sc.components.find((c) => c.ref === "D1");
  const gnd = sc.components.find((c) => c.type === "ground" && c.position.x === d1.position.x && c.position.y > d1.position.y);
  const lead = sc.wires.find((w) => w.points.some((q) => q.x === d1.position.x && q.y === d1.position.y - 3));
  const [from] = lead.points;                  // R3's right pin
  const dx = 9;
  d1.position.x += dx;
  gnd.position.x += dx;
  sc.components.push({ id: "c_sw1", type: "switch_spst", ref: "SW1", position: { x: from.x + 4, y: from.y }, rotation: 0, mirror: false, props: { closed: true } });
  lead.points = [{ x: from.x + 8, y: from.y }, { x: d1.position.x, y: from.y }];
  p.meta.name = "555 blinker with an on/off switch";
  return p;
}

export async function recordDemo({ page }) {
  const frameDir = join(root, "test-output/capture-frames");
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const frames = [];
  const t0 = Date.now();
  let ring = null;
  const snap = async () => {
    const f = join(frameDir, `f${String(frames.length).padStart(4, "0")}.png`);
    await page.screenshot({ path: f, clip: { x: 0, y: 0, width: 1600, height: 1000 } });
    frames.push([f, Date.now() - t0]);
  };
  const film = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) await snap(); };
  /** Click with a visible ring (screenshots don't include the mouse pointer). */
  const click = async (x, y) => {
    await page.evaluate(([x, y]) => {
      const d = document.createElement("div");
      d.id = "capture-click";
      d.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #ffd54f;box-shadow:0 0 12px #ffd54f;pointer-events:none;z-index:99999`;
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 700);
    }, [x, y]);
    await page.mouse.click(x, y);
  };

  const p = blinkerWithSwitch();
  await loadProject(page, p);
  await roomForScope(page);
  await fit(page);
  await page.mouse.move(2, 500);
  await film(700);
  const live = await page.getByRole("button", { name: "⚡ Live" }).boundingBox();
  await click(live.x + live.width / 2, live.y + live.height / 2);
  await film(6500);
  const sw = p.schematic.components.find((c) => c.ref === "SW1").position;
  const at = await worldToScreen(page, sw.x, sw.y - 0.6);
  await click(at.x, at.y);                     // open the switch: the LED goes dark
  await film(4000);
  await click(at.x, at.y);                     // close it again: blinking resumes
  await film(4500);
  toGif(frames);
}

function toGif(frames) {
  const gif = join(outDir, "demo.gif");
  const list = join(root, "test-output/capture-frames/frames.txt");
  const lines = [];
  frames.forEach(([f, t], i) => {
    const next = frames[i + 1]?.[1] ?? t + 100;
    lines.push(`file '${f.replace(/\\/g, "/")}'`, `duration ${((next - t) / 1000).toFixed(3)}`);
  });
  lines.push(`file '${frames.at(-1)[0].replace(/\\/g, "/")}'`);
  writeFileSync(list, lines.join("\n"));
  const ff = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-vf",
    "fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    "-loop", "0", gif], { stdio: "ignore" });
  if (ff.status !== 0) { console.warn("  ffmpeg not found or failed; demo.gif not written (frames kept in test-output/)"); return; }
  const fps = frames.length / ((frames.at(-1)[1] - frames[0][1]) / 1000);
  console.log(`  demo.gif ${(statSync(gif).size / 1e6).toFixed(2)} MB, ${frames.length} frames (${fps.toFixed(1)} fps captured)`);
}
