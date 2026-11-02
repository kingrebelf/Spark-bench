import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assetNames, bumpVersion, notesFromCommits, parseCredential, parseLatestYml, prependRelease, sectionNotes, unreleasedNotes, verifyArtifacts } from "../scripts/release/lib";
import { parseChangelog } from "../src/launcher/notes";

describe("release helpers", () => {
  it("bumps versions", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.2.3", "major")).toBe("1.0.0");
    expect(() => bumpVersion("0.1", "patch")).toThrow();
  });

  it("turns commits into notes, skipping tests and merges", () => {
    const n = notesFromCommits([
      "sim: live mode continues in short chunks",
      "kicad: fix nested library tables",
      "test: KiCad 10 nested library table expansion",
      "Merge branch 'x'",
      "release: v0.1.0",
      "Add a README screenshot",
    ]);
    expect(n).toBe("### Changes\n- **Simulation:** Live mode continues in short chunks\n- Add a README screenshot\n\n### Fixed\n- **KiCad:** Fix nested library tables");
    expect(notesFromCommits(["test: x"])).toBe("- Maintenance release.");
  });

  const CL = "# Changelog\n\nIntro.\n\n## Unreleased\n\n### New\n- Launcher\n\n## v0.1.0 — 2026-10-29 (pre-release)\n\nFirst.\n";

  it("reads the Unreleased section and moves it into a new version", () => {
    expect(unreleasedNotes(CL)).toBe("### New\n- Launcher");
    const out = prependRelease(CL, "0.1.1", "2026-11-02", unreleasedNotes(CL), true);
    expect(out).toBe("# Changelog\n\nIntro.\n\n## Unreleased\n\n## v0.1.1 — 2026-11-02 (pre-release)\n\n### New\n- Launcher\n\n## v0.1.0 — 2026-10-29 (pre-release)\n\nFirst.\n");
    expect(unreleasedNotes(out)).toBe("");
    expect(sectionNotes(out, "0.1.1")).toBe("### New\n- Launcher");
    // The launcher reads it back.
    expect(parseChangelog(out).map((r) => [r.version, r.prerelease])).toEqual([["0.1.1", true], ["0.1.0", true]]);
  });

  it("adds a section even without Unreleased", () => {
    expect(prependRelease("# C\n\n## v0.1.0\nx\n", "0.2.0", "2026-12-01", "- y", false)).toBe("# C\n\n## v0.2.0 — 2026-12-01\n\n- y\n\n## v0.1.0\nx\n");
  });

  it("the real CHANGELOG keeps an Unreleased heading for the script (it may be empty right after a release)", () => {
    expect(readFileSync("CHANGELOG.md", "utf8")).toMatch(/^## Unreleased\s*$/m);
  });

  it("parses credentials without echoing anything else", () => {
    expect(parseCredential("protocol=https\nhost=github.com\nusername=me\npassword=gho_abc\n")).toBe("gho_abc");
    expect(parseCredential("protocol=https\n")).toBeNull();
  });
});

describe("latest.yml", () => {
  const yml = (v: string, sha: string, size: number) =>
    `version: ${v}\nfiles:\n  - url: SparkBench-Setup-${v}.exe\n    sha512: ${sha}\n    size: ${size}\npath: SparkBench-Setup-${v}.exe\nsha512: ${sha}\nreleaseDate: '2026-11-02T10:00:00.000Z'\n`;

  it("parses electron-builder's format (the real v0.1.0 file shape)", () => {
    const y = parseLatestYml(yml("0.1.0", "abc==", 125531175));
    expect(y).toEqual({ version: "0.1.0", files: [{ url: "SparkBench-Setup-0.1.0.exe", sha512: "abc==", size: 125531175 }], path: "SparkBench-Setup-0.1.0.exe", sha512: "abc==", releaseDate: "2026-11-02T10:00:00.000Z" });
  });

  it("verifies the build output against latest.yml", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sb-rel-"));
    const n = assetNames("0.1.1");
    const exe = Buffer.from("installer bytes");
    writeFileSync(path.join(dir, n.installer), exe);
    writeFileSync(path.join(dir, n.blockmap), "bm");
    writeFileSync(path.join(dir, n.portable), "portable");
    const sha = createHash("sha512").update(exe).digest("base64");
    writeFileSync(path.join(dir, n.latest), yml("0.1.1", sha, exe.length));
    const ok = verifyArtifacts(dir, "0.1.1");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.files.map((f) => path.basename(f)).sort()).toEqual([n.blockmap, n.installer, n.portable, "latest.yml"].sort());

    writeFileSync(path.join(dir, n.latest), yml("0.1.1", "wrong==", exe.length));
    const bad = verifyArtifacts(dir, "0.1.1");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join()).toMatch(/sha512/);
    expect(verifyArtifacts(dir, "0.1.2")).toMatchObject({ ok: false });
  });
});
