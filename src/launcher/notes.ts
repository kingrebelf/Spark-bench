// Release notes: GitHub Releases API JSON or the bundled CHANGELOG.md, both turned into one list (newest first).

export interface ReleaseNote {
  version: string;   // "0.1.1" (no leading v)
  title: string;
  /** ISO date, if known. */
  date?: string;
  /** Markdown body (rendered with ./markdown, never as HTML). */
  body: string;
  prerelease: boolean;
  url?: string;
}

export interface NotesResult {
  source: "github" | "cache" | "bundled";
  releases: ReleaseNote[];
  /** When the GitHub copy was fetched (github/cache sources). */
  fetchedAt?: string;
  /** Why GitHub wasn't used (shown next to cached/bundled notes). */
  error?: string;
}

/** "v0.1.2", "V0.1.2-beta.1" → [0,1,2,"beta.1"]; null when it isn't a version. */
export function parseVersion(v: string): { nums: number[]; pre: string } | null {
  const m = /^\s*[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? "" };
}

export const cleanVersion = (v: string) => v.trim().replace(/^[vV]/, "");

/** Semver-ish compare; a pre-release sorts before its release. Unparseable versions sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

interface GithubRelease { tag_name?: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean; published_at?: string | null; created_at?: string; html_url?: string }

/** GitHub `GET /repos/:o/:r/releases` → notes. Drafts and non-version tags are dropped; duplicate tags (v/V) collapse. */
export function fromGithubReleases(json: unknown): ReleaseNote[] {
  if (!Array.isArray(json)) throw new Error("Unexpected response from GitHub (not a list of releases).");
  const seen = new Set<string>();
  const out: ReleaseNote[] = [];
  for (const r of json as GithubRelease[]) {
    if (!r || typeof r !== "object" || r.draft || typeof r.tag_name !== "string" || !parseVersion(r.tag_name)) continue;
    const version = cleanVersion(r.tag_name);
    if (seen.has(version)) continue;
    seen.add(version);
    out.push({
      version,
      title: (r.name && r.name.trim()) || `SparkBench ${version}`,
      date: r.published_at ?? r.created_at ?? undefined,
      body: typeof r.body === "string" ? r.body : "",
      prerelease: !!r.prerelease,
      url: typeof r.html_url === "string" && r.html_url.startsWith("https://github.com/") ? r.html_url : undefined,
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * CHANGELOG.md → notes. Sections start with `## v0.1.1 — 2026-11-02` (or `## [0.1.1] - date`, or `## 0.1.1`);
 * an `## Unreleased` section is skipped. Text before the first section is ignored.
 */
export function parseChangelog(md: string): ReleaseNote[] {
  const out: ReleaseNote[] = [];
  let cur: ReleaseNote | null = null;
  let body: string[] = [];
  const flush = () => { if (cur) { cur.body = body.join("\n").trim(); out.push(cur); } cur = null; body = []; };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const text = h[1].replace(/[[\]]/g, "").trim();
      const v = /^[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
      if (!v) continue; // "Unreleased" or other headings: skip that section
      const date = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
      cur = { version: v[1], title: `SparkBench ${v[1]}`, date, body: "", prerelease: /-/.test(v[1]) || /pre-?release|beta/i.test(text) };
      continue;
    }
    if (cur) body.push(line);
  }
  flush();
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** Notes newer than the version the user last ran, up to and including the running one. */
export function newSince(releases: ReleaseNote[], lastSeen: string | undefined, current: string): Set<string> {
  const s = new Set<string>();
  for (const r of releases) {
    if (compareVersions(r.version, current) > 0) continue;
    if (!lastSeen) { if (compareVersions(r.version, current) === 0) s.add(r.version); continue; }
    if (compareVersions(r.version, lastSeen) > 0) s.add(r.version);
  }
  return s;
}
