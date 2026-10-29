// KiCad installation discovery and kicad-cli/python execution (Node only: Electron main process and tests).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface KicadInstall {
  /** Install root, e.g. C:\Users\x\AppData\Local\Programs\KiCad\10.0 */
  root: string;
  /** Output of `kicad-cli version`, e.g. "10.0.6". */
  version: string;
  major: number;
  cli: string;
  /** Bundled Python with the pcbnew module, if present. */
  python?: string;
  /** KiCad main executable used to open projects. */
  kicadExe?: string;
  shareDir: string;
  symbolDir: string;
  footprintDir: string;
  templateDir: string;
  /** How the install was found. */
  source: "env" | "registry" | "known-path" | "path";
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function candidateRoots(): { root: string; source: KicadInstall["source"] }[] {
  const out: { root: string; source: KicadInstall["source"] }[] = [];
  if (process.env.SPARKBENCH_KICAD_DIR) out.push({ root: process.env.SPARKBENCH_KICAD_DIR, source: "env" });
  if (process.platform === "win32") {
    // Installer writes an Uninstall key with InstallLocation, per user (HKCU) or machine-wide (HKLM).
    for (const hive of ["HKCU", "HKLM"]) {
      try {
        const txt = execFileSync("reg", ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", "KiCad", "/d"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10000 });
        for (const m of txt.matchAll(/InstallLocation\s+REG_\w+\s+(.+)/g)) out.push({ root: m[1].trim(), source: "registry" });
      } catch { /* no key */ }
    }
    const bases = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "KiCad"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "KiCad"),
      "C:\\Program Files\\KiCad",
    ].filter(Boolean) as string[];
    for (const b of bases) {
      if (!existsSync(b)) continue;
      for (const v of readdirSync(b).sort().reverse()) out.push({ root: path.join(b, v), source: "known-path" });
    }
  } else if (process.platform === "darwin") {
    out.push({ root: "/Applications/KiCad/KiCad.app/Contents", source: "known-path" });
  } else {
    out.push({ root: "/usr", source: "known-path" }, { root: "/usr/local", source: "known-path" });
  }
  return out;
}

function layout(root: string): Omit<KicadInstall, "version" | "major" | "source"> | null {
  const binCandidates = [path.join(root, "bin"), path.join(root, "MacOS"), root];
  const bin = binCandidates.find((b) => existsSync(path.join(b, exe("kicad-cli"))));
  if (!bin) return null;
  const shareCandidates = [path.join(root, "share", "kicad"), path.join(root, "SharedSupport")];
  const shareDir = shareCandidates.find((s) => existsSync(path.join(s, "symbols"))) ?? shareCandidates[0];
  const py = [path.join(bin, exe("python")), path.join(bin, exe("python3"))].find(existsSync);
  const kicadExe = [path.join(bin, exe("kicad"))].find(existsSync);
  return {
    root, cli: path.join(bin, exe("kicad-cli")), python: py, kicadExe, shareDir,
    symbolDir: path.join(shareDir, "symbols"), footprintDir: path.join(shareDir, "footprints"), templateDir: path.join(shareDir, "template"),
  };
}

let cached: KicadInstall | null | undefined;

/** Find the newest usable KiCad. Returns null (never throws) when none is installed. */
export function findKicad(refresh = false): KicadInstall | null {
  if (cached !== undefined && !refresh) return cached;
  const found: KicadInstall[] = [];
  const seen = new Set<string>();
  for (const { root, source } of candidateRoots()) {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const l = layout(root);
    if (!l) continue;
    try {
      const version = execFileSync(l.cli, ["version"], { encoding: "utf8", windowsHide: true, timeout: 30000 }).trim();
      found.push({ ...l, version, major: parseInt(version, 10) || 0, source });
    } catch { /* broken install */ }
  }
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  cached = found[0] ?? null;
  return cached;
}

export interface CliResult { code: number; stdout: string; stderr: string }

/** Run kicad-cli synchronously. */
export function runCli(k: KicadInstall, args: string[], timeoutMs = 120000): CliResult {
  const r = spawnSync(k.cli, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run a Python script with KiCad's bundled interpreter (isolated mode: no site/user paths). */
export function runPython(k: KicadInstall, script: string, args: string[], timeoutMs = 180000): CliResult {
  if (!k.python) throw new Error("This KiCad installation has no bundled Python (pcbnew).");
  const r = spawnSync(k.python, ["-I", script, ...args], { encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const tmpBase = () => os.tmpdir();
