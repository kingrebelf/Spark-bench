import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref, stripHtml, type Block, type Inline } from "../src/launcher/markdown";
import { compareVersions, fromGithubReleases, newSince, parseChangelog } from "../src/launcher/notes";

describe("versions", () => {
  it("compares", () => {
    expect(compareVersions("v0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("V0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });
});

describe("GitHub releases", () => {
  const api = [
    { tag_name: "v0.1.0", name: "SparkBench 0.1.0", body: "First **release**", prerelease: true, published_at: "2026-10-29T09:00:00Z", html_url: "https://github.com/kingrebelf/Spark-bench/releases/tag/v0.1.0" },
    { tag_name: "V0.1.0", name: "dup", body: "", prerelease: true },
    { tag_name: "v0.2.0", name: "", body: null, draft: true },
    { tag_name: "nightly", name: "x", body: "" },
    { tag_name: "v0.1.1", name: null, body: "Fixes", prerelease: false, html_url: "javascript:alert(1)" },
  ];
  it("drops drafts, non-version tags and v/V duplicates; newest first", () => {
    const r = fromGithubReleases(api);
    expect(r.map((x) => x.version)).toEqual(["0.1.1", "0.1.0"]);
    expect(r[1]).toMatchObject({ title: "SparkBench 0.1.0", prerelease: true, date: "2026-10-29T09:00:00Z" });
    expect(r[0].title).toBe("SparkBench 0.1.1");
    expect(r[0].url).toBeUndefined();
  });
  it("rejects a non-list response", () => {
    expect(() => fromGithubReleases({ message: "API rate limit exceeded" })).toThrow(/not a list/);
  });
});

describe("CHANGELOG", () => {
  it("parses sections and skips Unreleased", () => {
    const md = "# Changelog\n\nintro\n\n## Unreleased\n- wip\n\n## v0.1.1 — 2026-11-02\n### Fixed\n- a\n\n## [0.1.0] - 2026-10-29 (pre-release)\n- first\n";
    const r = parseChangelog(md);
    expect(r.map((x) => x.version)).toEqual(["0.1.1", "0.1.0"]);
    expect(r[0]).toMatchObject({ date: "2026-11-02", body: "### Fixed\n- a" });
    expect(r[1].prerelease).toBe(true);
  });
  it("the bundled CHANGELOG.md has the current version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const r = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
    expect(r.some((x) => x.version === pkg.version)).toBe(true);
  });
});

describe("what's new since last run", () => {
  const rel = ["0.3.0", "0.2.1", "0.2.0", "0.1.0"].map((version) => ({ version, title: "", body: "", prerelease: false }));
  it("versions after the last seen one, up to the running one", () => {
    expect([...newSince(rel, "0.1.0", "0.2.1")]).toEqual(["0.2.1", "0.2.0"]);
  });
  it("first run highlights only the running version", () => {
    expect([...newSince(rel, undefined, "0.2.0")]).toEqual(["0.2.0"]);
  });
  it("nothing new when up to date", () => {
    expect(newSince(rel, "0.2.1", "0.2.1").size).toBe(0);
  });
});

const text = (c: Inline[]): string => c.map((n) => (n.t === "text" || n.t === "code" ? n.v : text(n.c))).join("");
const links = (bs: Block[]): string[] => {
  const out: string[] = [];
  const walk = (c: Inline[]) => c.forEach((n) => { if (n.t === "link") out.push(n.href); if ("c" in n) walk(n.c); });
  for (const b of bs) { if ("c" in b) walk(b.c); if (b.t === "list") b.items.forEach((i) => walk(i.c)); }
  return out;
};

describe("safe markdown", () => {
  it("parses headings, lists, code, quotes and rules", () => {
    const b = parseMarkdown("## New\n- one **bold**\n  - nested `code`\n1. first\n\n```\nnpm i\n```\n> note\n\n---\npara\nline two");
    expect(b.map((x) => x.t)).toEqual(["heading", "list", "list", "code", "quote", "hr", "para"]);
    const l = b[1] as Extract<Block, { t: "list" }>;
    expect(l.items.map((i) => i.depth)).toEqual([0, 1]);
    expect(text(l.items[0].c)).toBe("one bold");
    expect((b[3] as { v: string }).v).toBe("npm i");
    expect(text((b[6] as { c: Inline[] }).c)).toBe("para line two");
  });

  it("strips raw HTML and comments but keeps their text", () => {
    expect(stripHtml("a <script>alert(1)</script> b <!-- hidden --> <img src=x onerror=alert(1)>c")).toBe("a alert(1) b  c");
    const b = parseMarkdown("<details><summary>More</summary>\n\nHello <b>there</b>\n</details>");
    expect(JSON.stringify(b)).not.toMatch(/<|>/);
    expect(b.filter((x) => x.t === "para").map((x) => text((x as { c: Inline[] }).c)).join("|")).toContain("Hello there");
  });

  it("only keeps http(s) links; images become links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    const b = parseMarkdown("[x](javascript:alert(1)) [ok](https://github.com/a) ![shot](https://i.example/p.png) see https://example.com/z.");
    expect(links(b)).toEqual(["https://github.com/a", "https://i.example/p.png", "https://example.com/z"]);
    expect(text((b[0] as { c: Inline[] }).c)).toMatch(/^x ok shot/);
  });

  it("doesn't treat snake_case as emphasis", () => {
    expect(parseInline("use my_var_name here").every((n) => n.t === "text")).toBe(true);
    expect(parseInline("*em*")[0].t).toBe("em");
  });
});
