// Pure helpers for scripts/release/release.ts (unit-tested in tests/launcher-release.test.ts).
// Only erasable TypeScript: Node runs this file directly.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type Bump = "patch" | "minor" | "major";

export function bumpVersion(v: string, kind: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`Can't bump "${v}": expected x.y.z`);
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  return kind === "major" ? `${a + 1}.0.0` : kind === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

const AREAS: Record<string, string> = {
  sim: "Simulation", scope: "Simulation", editor: "Editor", library: "Library", kicad: "KiCad", ai: "AI assistant",
  launcher: "Launcher", relay: "Feedback", core: "App", app: "App", docs: "Docs", readme: "Docs",
};
const SKIP = /^(release|test|tests|ci|chore|build|merge|wip)\b|^Merge /i;

/** Commit subjects since the last release → markdown (fixes first, then the rest, labeled by area). */
export function notesFromCommits(subjects: string[]): string {
  const fixed: string[] = [], changed: string[] = [];
  for (const s of subjects.map((x) => x.trim()).filter(Boolean)) {
    if (SKIP.test(s)) continue;
    const m = /^([\w-]+)(?:\([^)]*\))?:\s*(.+)$/.exec(s);
    const area = m ? AREAS[m[1].toLowerCase()] : undefined;
    if (m && !area && /^(docs?|style|refactor)$/i.test(m[1])) continue;
    const text = (m ? m[2] : s).replace(/^\w/, (c) => c.toUpperCase());
    const line = `- ${area ? `**${area}:** ` : ""}${text}`;
    (/\bfix(e[sd])?\b|\bbug\b|\bcrash/i.test(s) ? fixed : changed).push(line);
  }
  const out: string[] = [];
  if (changed.length) out.push("### Changes", ...changed);
  if (fixed.length) out.push(...(out.length ? [""] : []), "### Fixed", ...fixed);
  return out.join("\n") || "- Maintenance release.";
}

/** The body of the `## Unreleased` section (trimmed), or "" when there is none. */
export function unreleasedNotes(changelog: string): string {
  const m = /^## +\[?Unreleased\]?[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/im.exec(changelog.replace(/\r\n?/g, "\n"));
  return m ? m[1].trim() : "";
}

/** The notes of an existing `## vX.Y.Z` section. */
export function sectionNotes(changelog: string, version: string): string | null {
  const esc = version.replace(/\./g, "\\.");
  const m = new RegExp(`^## +\\[?v?${esc}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "im").exec(changelog.replace(/\r\n?/g, "\n"));
  return m ? m[1].trim() : null;
}

/** Empty the Unreleased section and add `## vX — date` with the notes right below it. */
export function prependRelease(changelog: string, version: string, date: string, notes: string, prerelease: boolean): string {
  const text = changelog.replace(/\r\n?/g, "\n");
  const heading = `## v${version} — ${date}${prerelease ? " (pre-release)" : ""}`;
  const section = `${heading}\n\n${notes.trim()}\n\n`;
  const un = /^## +\[?Unreleased\]?[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/im.exec(text);
  if (un) return text.slice(0, un.index) + "## Unreleased\n\n" + section + text.slice(un.index + un[0].length).replace(/^\n+/, "");
  const first = /^## /m.exec(text);
  if (first) return text.slice(0, first.index) + section + text.slice(first.index);
  return `${text.trimEnd()}\n\n${section}`;
}

export interface LatestYml { version: string; files: { url: string; sha512: string; size: number }[]; path: string; sha512: string; releaseDate?: string }

/** electron-builder's latest.yml (a fixed, simple shape; no YAML library needed). */
export function parseLatestYml(text: string): LatestYml {
  const get = (k: string, src = text) => new RegExp(`^${k}:\\s*'?([^'\\n]*)'?\\s*$`, "m").exec(src)?.[1]?.trim();
  const files: LatestYml["files"] = [];
  const block = /^files:\n([\s\S]*?)(?=^\S)/m.exec(text)?.[1] ?? "";
  for (const item of block.split(/^\s*-\s+/m).slice(1)) {
    const f = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, "m").exec(item)?.[1]?.trim() ?? "";
    files.push({ url: f("url"), sha512: f("sha512"), size: Number(f("size")) });
  }
  const version = get("version"), p = get("path"), sha = get("sha512");
  if (!version || !p || !sha) throw new Error("latest.yml is missing version, path or sha512");
  return { version, files, path: p, sha512: sha, releaseDate: get("releaseDate") };
}

export const assetNames = (version: string) => ({
  installer: `SparkBench-Setup-${version}.exe`,
  blockmap: `SparkBench-Setup-${version}.exe.blockmap`,
  portable: `SparkBench-${version}-portable.exe`,
  latest: "latest.yml",
});

const sha512b64 = (file: string) => createHash("sha512").update(readFileSync(file)).digest("base64");
export const sha256hex = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Check the build output: all four assets exist and latest.yml describes this version's installer exactly. */
export function verifyArtifacts(dir: string, version: string): { ok: true; files: string[]; latest: LatestYml } | { ok: false; problems: string[] } {
  const names = assetNames(version);
  const problems: string[] = [];
  for (const n of Object.values(names)) if (!existsSync(path.join(dir, n))) problems.push(`missing ${n}`);
  if (problems.length) return { ok: false, problems };
  const latest = parseLatestYml(readFileSync(path.join(dir, names.latest), "utf8"));
  const installer = path.join(dir, names.installer);
  if (latest.version !== version) problems.push(`latest.yml is for ${latest.version}, not ${version}`);
  if (latest.path !== names.installer) problems.push(`latest.yml path is ${latest.path}, expected ${names.installer}`);
  const f = latest.files[0];
  if (!f || f.url !== names.installer) problems.push(`latest.yml files[0].url is ${f?.url}, expected ${names.installer}`);
  const sha = sha512b64(installer);
  if (latest.sha512 !== sha || f?.sha512 !== sha) problems.push("latest.yml sha512 doesn't match the installer");
  if (f && f.size !== statSync(installer).size) problems.push("latest.yml size doesn't match the installer");
  if (problems.length) return { ok: false, problems };
  return { ok: true, files: Object.values(names).map((n) => path.join(dir, n)), latest };
}

/** `git credential fill` output → the password (token). Never log the result. */
export function parseCredential(out: string): string | null {
  const m = /^password=(.+)$/m.exec(out);
  return m ? m[1].trim() : null;
}

/** Release body for GitHub: the notes plus install help and checksums. */
export function releaseBody(notes: string, version: string, sums: Record<string, string>, prerelease: boolean): string {
  const n = assetNames(version);
  return [
    notes.trim(),
    "",
    "## Install",
    `- **${n.installer}**: installer. Installed copies update themselves (SparkBench → Updates & info).`,
    `- **${n.portable}**: a single file, no install. It can't update itself; the launcher tells you when a new version is out.`,
    "",
    "The EXEs aren't code-signed, so Windows SmartScreen may say \"Windows protected your PC\". Click **More info → Run anyway**." +
      (prerelease ? " This is a pre-release." : ""),
    "",
    "## SHA-256",
    "```",
    ...Object.entries(sums).map(([f, h]) => `${h}  ${f}`),
    "```",
  ].join("\n");
}
