// Renders a generated board with KiCad's own 3D renderer (kicad-cli pcb render).
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function kicadCli() {
  const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "KiCad"), process.env.ProgramFiles && join(process.env.ProgramFiles, "KiCad")].filter(Boolean);
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const v of readdirSync(r).sort().reverse()) {
      const exe = join(r, v, "bin", process.platform === "win32" ? "kicad-cli.exe" : "kicad-cli");
      if (existsSync(exe)) return exe;
    }
  }
  return "kicad-cli";
}

export function renderBoard(board, png) {
  const r = spawnSync(kicadCli(), ["pcb", "render", "--output", png, "--width", "2400", "--height", "1500", "--side", "top",
    "--quality", "high", "--background", "opaque", "--rotate", "-35,0,20", "--perspective", "--zoom", "0.9", board], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`kicad-cli pcb render failed: ${r.stderr || r.stdout}`);
}
