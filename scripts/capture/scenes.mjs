// README screenshot scenes. Each scene gets a fresh app window ({ app, page, file }) and writes one
// or more PNGs. Projects come from examples/ so the screenshots show what users can open themselves.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBoard } from "./kicad.mjs";
import { root, calm, fit, loadProject, playTime, readExample, roomForScope, runAnalysis, selectRef, tab, redactHome, unionBox, waitForLabel } from "./helpers.mjs";

const startLive = async (page) => {
  await page.getByRole("button", { name: "⚡ Live" }).click();
};

const AI_PROMPT = "Add a second LED (green) that is lit while the red one is off, so the two alternate. Keep the 9 V supply and the existing timing. Use the same kind of series resistor.";

export const scenes = [
  {
    name: "ai",
    async run({ app, page, file, shot }) {
      // Normal runs replay a reply recorded from the real Codex CLI (scripts/capture/ai-reply.json)
      // through the app's real pipeline: parse, library checks, layout, design checks, ngspice.
      // `--record-ai` asks Codex for real and saves the reply.
      const record = process.argv.includes("--record-ai");
      await page.evaluate(() => window.sparkbench.invoke("sb:ai:saveSettings", { provider: "codex", codex: { path: "", model: "", timeoutSec: 300 } }));
      if (record) {
        await app.evaluate(({ ipcMain }) => {
          const orig = ipcMain._invokeHandlers.get("sb:ai:complete");
          ipcMain.removeHandler("sb:ai:complete");
          ipcMain.handle("sb:ai:complete", async (...a) => { const r = await orig(...a); globalThis.__aiReply = r; return r; });
        });
      } else {
        const reply = JSON.parse(readFileSync(join(root, "scripts/capture/ai-reply.json"), "utf8"));
        await app.evaluate(({ ipcMain }, r) => {
          ipcMain.removeHandler("sb:ai:complete");
          ipcMain.handle("sb:ai:complete", async () => { await new Promise((ok) => setTimeout(ok, 500)); return r; });
        }, reply);
      }
      await loadProject(page, readExample("555-astable-blinker"));
      await tab(page, "Assistant");
      await page.getByPlaceholder(/Describe your circuit idea/).fill(AI_PROMPT);
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForFunction(() => /Simulated|Checks passed|Design checks failed|not yet validated/.test(document.body.innerText), null, { timeout: 330000, polling: 500 });
      if (record) {
        const r = await app.evaluate(() => globalThis.__aiReply);
        writeFileSync(join(root, "scripts/capture/ai-reply.json"), JSON.stringify(r, null, 2) + "\n");
      }
      await page.waitForTimeout(1500);
      await calm(page);
      await shot(file());
      // Second view: the AI's expected values next to what ngspice measured.
      await page.getByText("Expectation (AI)").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(400);
      await shot(file("ai-checks"));
    },
  },

  {
    name: "kicad",
    async run({ app, page, file, shot, userData }) {
      // Export into a throwaway folder: the folder picker is answered by the script.
      const dir = join(userData, "kicad-out");
      mkdirSync(dir, { recursive: true });
      await app.evaluate(({ ipcMain }, d) => {
        ipcMain.removeHandler("sb:kicad:chooseFolder");
        ipcMain.handle("sb:kicad:chooseFolder", () => ({ dir: d, existingName: null }));
        ipcMain.removeHandler("sb:kicad:openInKicad");
        ipcMain.handle("sb:kicad:openInKicad", () => ({ ok: false }));
      }, dir);
      await loadProject(page, readExample("555-astable-blinker"));
      await tab(page, "KiCad");
      await page.getByRole("button", { name: "Choose…" }).click();
      const pcb = page.getByLabel(/Also create the PCB/);
      if (await pcb.count()) await pcb.check();
      await page.getByRole("button", { name: "Export KiCad project" }).click();
      // Wait for the full report (netlist comparison, ERC and DRC run by kicad-cli), then show it.
      await page.waitForFunction(() => /KiCad DRC:/.test(document.querySelector(".right")?.innerText ?? ""), null, { timeout: 120000 });
      await page.locator(".right").getByText("Result", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(500);
      await redactHome(page);
      await calm(page);
      await shot(file());
      const board = readdirSync(dir).find((f) => f.endsWith(".kicad_pcb"));
      if (!board) throw new Error(`no .kicad_pcb in ${readdirSync(dir).join(", ")}`);
      renderBoard(join(dir, board), file("pcb"));
    },
  },
  {
    name: "live",
    async run({ page, file, shot }) {
      await loadProject(page, readExample("555-astable-blinker"));
      await roomForScope(page);
      await fit(page);
      await startLive(page);
      await calm(page);
      // Let the scope start scrolling (playhead pinned at 90 % after 9 s), then catch the LED on.
      await page.waitForFunction(() => /(1[1-9]|[2-9]\d)\.\d+ s \/ /.test(document.querySelector(".center")?.innerText ?? ""), null, { timeout: 40000, polling: 200 });
      await waitForLabel(page, /I\(D1\) = [5-9][.\d]* mA|I\(D1\) = 1\d[.\d]* mA/);
      await shot(file());
      // Close-up of playback, the time-scale dial and the scrolling scope.
      await shot(file("scope"), await unionBox(page, [".playback-wrap", ".plot-canvas"], 6));
    },
  },
  {
    name: "editor",
    async run({ page, file, shot }) {
      await loadProject(page, readExample("opamp-inverting"));
      await roomForScope(page, 60);
      await fit(page);
      const st = await runAnalysis(page, "tran");
      if (st !== "done") throw new Error(`simulation ${st}`);
      // Show the whole finished run with measurement cursors instead of the playback.
      await page.getByRole("button", { name: "Exit playback" }).click();
      await page.getByLabel("Cursors").check();
      await page.waitForTimeout(400);
      await calm(page);
      await shot(file());
    },
  },
  {
    name: "properties",
    async run({ page, file, shot }) {
      await loadProject(page, readExample("555-astable-blinker"));
      await selectRef(page, "U1");
      await page.getByPlaceholder(/search parts/i).fill("555");
      await page.waitForTimeout(300);
      await calm(page);
      await shot(file());
    },
  },
  {
    name: "library",
    async run({ page, file, shot }) {
      await loadProject(page, readExample("bjt-common-emitter"));
      await page.getByPlaceholder(/search parts/i).fill("transistor");
      await page.waitForTimeout(300);
      await selectRef(page, "Q1");
      await calm(page);
      await shot(file());
    },
  },
  {
    name: "burnout",
    async run({ page, file, shot }) {
      // The LED example with its series resistor cut to 100 Ω (about 70 mA): far beyond the LED's 30 mA rating.
      const p = readExample("led-resistor");
      const r = p.schematic.components.find((c) => c.type === "resistor");
      r.props.value = "100";
      p.schematic.components.find((c) => c.type === "vdc").props.value = "9";
      p.simulation.analysis = "tran";
      p.simulation.tran = { stop: "100m", step: "100u" };
      p.meta.name = "LED with a 100 Ω resistor on 9 V";
      await loadProject(page, p);
      await roomForScope(page);
      await fit(page);
      const st = await runAnalysis(page, "tran");
      if (st !== "done") throw new Error(`simulation ${st}`);
      await page.locator(".damage").first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(2500);
      await calm(page);
      await shot(file());
    },
  },
  {
    name: "bode",
    async run({ page, file, shot }) {
      await loadProject(page, readExample("rc-lowpass-bode"));
      await roomForScope(page);
      await fit(page);
      const st = await runAnalysis(page, "ac");
      if (st !== "done") throw new Error(`simulation ${st}`);
      await calm(page);
      await shot(file());
    },
  },
  {
    name: "diagnostics",
    async run({ page, file, shot }) {
      // A divider whose ground symbol was forgotten: the checks name the problem and the fix.
      const p = readExample("resistor-divider");
      p.schematic.components = p.schematic.components.filter((c) => c.type !== "ground");
      p.meta.name = "Divider (ground missing)";
      await loadProject(page, p);
      await roomForScope(page);
      await fit(page);
      const st = await runAnalysis(page, p.simulation.analysis);
      if (st !== "failed") throw new Error(`expected a failed run, got ${st}`);
      await calm(page);
      await shot(file());
    },
  },
];
