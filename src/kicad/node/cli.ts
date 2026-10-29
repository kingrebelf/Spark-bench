// Thin wrappers around kicad-cli commands used for validation (Node only).
// Reports and netlists go to a private temp folder, never into the user's project folder.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliAsync, type KicadInstall } from "./install";

export interface ErcViolation { severity: string; type: string; description: string; items: { description: string; pos?: { x: number; y: number } }[] }
export interface ErcReport { ok: boolean; violations: ErcViolation[]; errors: number; warnings: number; raw?: string; cliError?: string }

/** Run kicad-cli writing its output file into a fresh temp folder; returns the file text or undefined. */
async function cliToTemp(k: KicadInstall, args: (out: string) => string[], fileName: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-kicad-cli-"));
  const out = path.join(dir, fileName);
  try {
    const r = await runCliAsync(k, args(out));
    let text: string | undefined;
    try { text = await fs.readFile(out, "utf8"); } catch { /* not written */ }
    return { r, text };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const cliErr = (r: { stdout: string; stderr: string; code: number }) => (r.stderr || r.stdout).trim() || `kicad-cli exited with ${r.code}`;

/** `kicad-cli sch erc --format json`. ok=false only when the CLI itself failed. */
export async function runErc(k: KicadInstall, sch: string): Promise<ErcReport> {
  const { r, text } = await cliToTemp(k, (o) => ["sch", "erc", "--format", "json", "--severity-all", "--units", "mm", "-o", o, sch], "erc.json");
  if (text === undefined) return { ok: false, violations: [], errors: 0, warnings: 0, cliError: cliErr(r) };
  const j = JSON.parse(text) as { sheets?: { violations?: ErcViolation[] }[] };
  const violations = (j.sheets ?? []).flatMap((s) => s.violations ?? []);
  return {
    ok: true, violations, raw: text,
    errors: violations.filter((v) => v.severity === "error").length,
    warnings: violations.filter((v) => v.severity === "warning").length,
  };
}

/** KiCad's own netlist of a schematic (kicadsexpr or spice). Throws with KiCad's message on failure. */
export async function exportNetlist(k: KicadInstall, sch: string, format: "kicadsexpr" | "spice" = "kicadsexpr"): Promise<string> {
  const { r, text } = await cliToTemp(k, (o) => ["sch", "export", "netlist", "--format", format, "-o", o, sch], format === "spice" ? "netlist.cir" : "netlist.net");
  if (text === undefined) throw new Error(`kicad-cli could not export the ${format} netlist: ${cliErr(r)}`);
  return text;
}

export interface DrcViolation { severity: string; type: string; description: string; items: { description: string; pos?: { x: number; y: number } }[] }
export interface DrcReport { ok: boolean; violations: DrcViolation[]; unconnected: DrcViolation[]; footprintIssues: DrcViolation[]; raw?: string; cliError?: string }

export async function runDrc(k: KicadInstall, pcb: string): Promise<DrcReport> {
  const { r, text } = await cliToTemp(k, (o) => ["pcb", "drc", "--format", "json", "--severity-all", "--units", "mm", "--schematic-parity", "-o", o, pcb], "drc.json");
  if (text === undefined) return { ok: false, violations: [], unconnected: [], footprintIssues: [], cliError: cliErr(r) };
  const j = JSON.parse(text) as { violations?: DrcViolation[]; unconnected_items?: DrcViolation[]; schematic_parity?: DrcViolation[] };
  return { ok: true, raw: text, violations: j.violations ?? [], unconnected: j.unconnected_items ?? [], footprintIssues: j.schematic_parity ?? [] };
}

export async function writeText(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}
