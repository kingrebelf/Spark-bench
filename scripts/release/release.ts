// Release SparkBench: bump the version, write CHANGELOG.md, build the Windows installer + portable exe, check
// latest.yml, then commit, tag, push and publish a GitHub release with all four assets.
//
//   npm run release -- patch|minor|major [--dry-run] [--stable] [--skip-build]
//   npm run release -- publish [--stable]       (publish the version already in package.json, built earlier)
//
// --dry-run   bump, build and verify, print what would be published, then put package.json/CHANGELOG.md back.
// --stable    mark the GitHub release as a full release (default: pre-release).
// --skip-build reuse release/ output (it must match the new version).
// The GitHub token comes from GH_TOKEN or `git credential fill` and is never printed.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assetNames, bumpVersion, notesFromCommits, parseCredential, prependRelease, releaseBody, sectionNotes, sha256hex, unreleasedNotes, verifyArtifacts, type Bump } from "./lib.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, "release");
const REPO = "kingrebelf/Spark-bench";
const API = `https://api.github.com/repos/${REPO}`;
const VERSION_FILES = ["package.json", "package-lock.json", "CHANGELOG.md"];

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--"));
const flag = (f: string) => args.includes(f);
const dryRun = flag("--dry-run"), stable = flag("--stable"), skipBuild = flag("--skip-build");

const log = (m: string) => console.log(`\x1b[36m[release]\x1b[0m ${m}`);
const die = (m: string): never => { console.error(`\x1b[31m[release] ${m}\x1b[0m`); process.exit(1); };

function run(cmd: string, a: string[], opts: { input?: string; quiet?: boolean; shell?: boolean } = {}): string {
  const r = spawnSync(cmd, a, { cwd: ROOT, encoding: "utf8", input: opts.input, shell: opts.shell, stdio: opts.quiet || opts.input !== undefined ? "pipe" : ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) die(`${cmd} ${a.join(" ")} failed (${r.status}).${r.stderr ? "\n" + r.stderr.trim() : ""}`);
  return (r.stdout ?? "").trim();
}
const git = (...a: string[]) => run("git", a, { quiet: true });

function token(): string {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const r = spawnSync("git", ["credential", "fill"], { cwd: ROOT, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const t = r.status === 0 ? parseCredential(r.stdout) : null;
  return t ?? die("No GitHub token: set GH_TOKEN or store a github.com credential for git.");
}

async function gh(method: string, url: string, tok: string, body?: unknown): Promise<any> {
  const res = await fetch(url.startsWith("http") ? url : API + url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sparkbench-release", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) die(`GitHub ${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function upload(uploadUrl: string, file: string, tok: string) {
  const name = path.basename(file);
  const url = uploadUrl.replace(/\{\?name,label\}$/, "") + `?name=${encodeURIComponent(name)}`;
  const data = readFileSync(file);
  log(`uploading ${name} (${(data.length / 1048576).toFixed(1)} MB)…`);
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "Content-Type": "application/octet-stream", "Content-Length": String(data.length), "User-Agent": "sparkbench-release" }, body: data });
  if (!res.ok) die(`upload of ${name} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

const readJson = (f: string) => JSON.parse(readFileSync(path.join(ROOT, f), "utf8"));
const writeJson = (f: string, v: unknown) => writeFileSync(path.join(ROOT, f), JSON.stringify(v, null, 2) + "\n", "utf8");

function lastReleaseRef(): string | null {
  const tags = git("ls-remote", "--tags", "origin").split("\n").map((l) => l.split(/\s+/)).filter(([, ref]) => /refs\/tags\/v\d+\.\d+\.\d+$/.test(ref ?? ""));
  tags.sort((a, b) => cmp(b[1].replace(/.*\/v/, ""), a[1].replace(/.*\/v/, "")));
  for (const [sha] of tags) if (spawnSync("git", ["cat-file", "-e", sha], { cwd: ROOT }).status === 0) return sha;
  return null;
}
const cmp = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

async function publish(version: string, notes: string) {
  const tok = token();
  const tag = `v${version}`;
  const check = verifyArtifacts(OUT, version);
  if (!check.ok) die(`build output isn't releasable:\n  ${check.problems.join("\n  ")}`);
  if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) die(`${tag} already exists on GitHub.`);

  if (git("status", "--porcelain", "--", ...VERSION_FILES)) {
    log(`committing ${VERSION_FILES.join(", ")}`);
    git("commit", "-m", `release: ${tag}`, "--", ...VERSION_FILES);
  }
  // A rerun after a failed push finds the tag already made on the release commit (an ancestor of HEAD).
  const localTag = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  if (!localTag) git("tag", "-a", tag, "-m", `SparkBench ${tag}`);
  else if (spawnSync("git", ["merge-base", "--is-ancestor", localTag, "HEAD"], { cwd: ROOT }).status !== 0) die(`a local tag ${tag} exists on a commit that isn't in main; delete it (git tag -d ${tag}) and rerun.`);
  log(`pushing main and ${tag}`);
  const pushed = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: ROOT, stdio: "inherit" });
  if (pushed.status !== 0) die(`push was rejected (main moved on GitHub). Run:
  git pull --no-rebase origin main
  npm run release -- publish`);
  run("git", ["push", "origin", tag]);

  const sums = Object.fromEntries([assetNames(version).installer, assetNames(version).portable].map((n) => [n, sha256hex(path.join(OUT, n))]));
  // Draft first, so an updater never sees the release before latest.yml is attached.
  const rel = await gh("POST", "/releases", tok, { tag_name: tag, name: `SparkBench ${version}`, body: releaseBody(notes, version, sums, !stable), draft: true, prerelease: !stable });
  for (const f of check.files) await upload(rel.upload_url, f, tok);
  const done = await gh("PATCH", `/releases/${rel.id}`, tok, { draft: false });
  log(`published ${done.html_url}`);
}

async function main() {
  if (!mode || !["patch", "minor", "major", "publish"].includes(mode)) die("usage: npm run release -- patch|minor|major [--dry-run] [--stable] [--skip-build]  |  npm run release -- publish");
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") die("releases are made from main.");

  const pkg = readJson("package.json");
  if (mode === "publish") {
    const notes = sectionNotes(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), pkg.version) ?? die(`CHANGELOG.md has no section for ${pkg.version}.`);
    if (dryRun) { const c = verifyArtifacts(OUT, pkg.version); log(c.ok ? `would publish v${pkg.version}` : c.problems.join("; ")); return; }
    return publish(pkg.version, notes);
  }

  const dirty = git("status", "--porcelain", "--", ...VERSION_FILES);
  if (dirty) die(`commit or discard changes to ${VERSION_FILES.join(", ")} first:\n${dirty}`);
  if (!dryRun) token(); // fail before building if publishing can't work

  const version = bumpVersion(pkg.version, mode as Bump);
  const date = new Date().toISOString().slice(0, 10);
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  const originals = Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(path.join(ROOT, f), "utf8")]));
  const changelog = originals["CHANGELOG.md"];
  let notes = unreleasedNotes(changelog);
  if (!notes) {
    const since = lastReleaseRef();
    const subjects = git("log", "--no-merges", "--format=%s", since ? `${since}..HEAD` : "HEAD").split("\n");
    notes = notesFromCommits(subjects);
    log(`notes from ${subjects.length} commits since ${since ? since.slice(0, 7) : "the start"}`);
  }
  log(`${pkg.version} → ${version}${dryRun ? " (dry run)" : ""}`);

  const restore = () => { for (const [f, t] of Object.entries(originals)) writeFileSync(path.join(ROOT, f), t, "utf8"); };
  try {
    writeJson("package.json", { ...pkg, version });
    const lock = readJson("package-lock.json");
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeJson("package-lock.json", lock);
    writeFileSync(changelogPath, prependRelease(changelog, version, date, notes, !stable), "utf8");

    if (!skipBuild) {
      log("building (npm run dist:win)…");
      // No token in the build's environment: electron-builder must never publish on its own.
      const env = { ...process.env }; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
      const b = spawnSync("npm run dist:win", { cwd: ROOT, stdio: "inherit", shell: true, env });
      if (b.status !== 0) throw new Error(`npm run dist:win failed (${b.status})`);
    }
    const check = verifyArtifacts(OUT, version);
    if (!check.ok) throw new Error(`build output isn't releasable:\n  ${check.problems.join("\n  ")}`);
    log(`verified latest.yml for ${version}:`);
    for (const f of check.files) console.log(`  ${path.relative(ROOT, f)}  ${(statSync(f).size / 1048576).toFixed(1)} MB`);

    if (dryRun) {
      console.log(`\n--- release notes (v${version}) ---\n${releaseBody(notes, version, Object.fromEntries([assetNames(version).installer, assetNames(version).portable].map((n) => [n, sha256hex(path.join(OUT, n))])), !stable)}\n---`);
      log(`would: commit ${VERSION_FILES.join(", ")} as "release: v${version}", tag v${version}, push main + tag,`);
      log(`       create a draft ${stable ? "" : "pre-"}release on ${REPO}, upload ${check.files.map((f) => path.basename(f)).join(", ")}, then publish it.`);
      restore();
      log("dry run: package.json, package-lock.json and CHANGELOG.md restored.");
      return;
    }
  } catch (e) {
    restore();
    die(`${(e as Error).message}\n(version files restored)`);
  }
  await publish(version, notes);
}

main().catch((e) => die(e?.stack ?? String(e)));
