// Thin wrappers around kicad-cli commands used for validation (Node only).
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli, type KicadInstall } from "./install";

export interface ErcViolation { severity: string; type: string; description: string; items: { description: string; pos?: { x: number; y: number } }[] }
export interface ErcReport { ok: boolean; violations: ErcViolation[]; errors: number; warnings: number; raw?: string; cliError?: string }

/** `kicad-cli sch erc --format json`. ok=false only when the CLI itself failed. */
export async function runErc(k: KicadInstall, sch: string): Promise<ErcReport> {
  const out = sch.replace(/\.kicad_sch$/, "-erc.json");
  const r = runCli(k, ["sch", "erc", "--format", "json", "--severity-all", "--units", "mm", "-o", out, sch]);
  let raw: string;
  try { raw = await fs.readFile(out, "utf8"); } catch {
    return { ok: false, violations: [], errors: 0, warnings: 0, cliError: (r.stderr || r.stdout).trim() || `kicad-cli exited with ${r.code}` };
  }
  const j = JSON.parse(raw) as { sheets?: { violations?: ErcViolation[] }[] };
  const violations = (j.sheets ?? []).flatMap((s) => s.violations ?? []);
  return {
    ok: true, violations, raw,
    errors: violations.filter((v) => v.severity === "error").length,
    warnings: violations.filter((v) => v.severity === "warning").length,
  };
}

/** KiCad's own netlist of a schematic (kicadsexpr or spice). Throws with KiCad's message on failure. */
export async function exportNetlist(k: KicadInstall, sch: string, format: "kicadsexpr" | "spice" = "kicadsexpr"): Promise<string> {
  const out = sch.replace(/\.kicad_sch$/, format === "spice" ? ".cir" : ".net");
  const r = runCli(k, ["sch", "export", "netlist", "--format", format, "-o", out, sch]);
  try { return await fs.readFile(out, "utf8"); } catch {
    throw new Error(`kicad-cli could not export the ${format} netlist: ${(r.stderr || r.stdout).trim() || `exit code ${r.code}`}`);
  }
}

export interface DrcViolation { severity: string; type: string; description: string; items: { description: string; pos?: { x: number; y: number } }[] }
export interface DrcReport { ok: boolean; violations: DrcViolation[]; unconnected: DrcViolation[]; footprintIssues: DrcViolation[]; raw?: string; cliError?: string }

export async function runDrc(k: KicadInstall, pcb: string): Promise<DrcReport> {
  const out = pcb.replace(/\.kicad_pcb$/, "-drc.json");
  const r = runCli(k, ["pcb", "drc", "--format", "json", "--severity-all", "--units", "mm", "--schematic-parity", "-o", out, pcb]);
  let raw: string;
  try { raw = await fs.readFile(out, "utf8"); } catch {
    return { ok: false, violations: [], unconnected: [], footprintIssues: [], cliError: (r.stderr || r.stdout).trim() || `kicad-cli exited with ${r.code}` };
  }
  const j = JSON.parse(raw) as { violations?: DrcViolation[]; unconnected_items?: DrcViolation[]; schematic_parity?: DrcViolation[] };
  return { ok: true, raw, violations: j.violations ?? [], unconnected: j.unconnected_items ?? [], footprintIssues: j.schematic_parity ?? [] };
}

export async function writeText(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}
