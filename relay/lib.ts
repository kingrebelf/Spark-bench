// SparkBench feedback relay: receives reports from the app and files them as labeled GitHub issues.
// No dependencies (Node 22.6+ runs this file directly with type stripping; only erasable TypeScript is used).
// Everything is here so the tests exercise exactly what runs; server.ts only reads the environment and listens.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RelayConfig {
  /** Fine-grained PAT with only "Issues: read and write" on the one repository. */
  token: string;
  /** "owner/name" */
  repo: string;
  /** Requests per IP per window. */
  perIp: number;
  perIpWindowMs: number;
  /** Issues created per window, all clients together (caps abuse even with many IPs). */
  global: number;
  globalWindowMs: number;
  /** Max request body in bytes. */
  maxBody: number;
  /** Use X-Forwarded-For (only behind a proxy you control, e.g. nginx or a platform router). */
  trustProxy: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

export const DEFAULTS = {
  perIp: 5, perIpWindowMs: 10 * 60_000,
  global: 60, globalWindowMs: 60 * 60_000,
  maxBody: 128 * 1024,
} as const;

export interface Report {
  kind: "bug" | "idea" | "other";
  title: string;
  description: string;
  email?: string;
  diagnostics?: { appVersion: string; os: string; electron: string; diagnostics: string[]; simLog: string };
  project?: { name: string; text: string };
  projectOmitted?: string;
}

const LIM = { title: 120, description: 8000, email: 200, diag: 40, diagChars: 400, simLog: 12000, project: 40000, short: 120 };
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Validate and copy only known fields. Returns an error sentence for the app to show. */
export function validateReport(x: unknown): { ok: true; report: Report } | { ok: false; error: string } {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, error: "The report must be a JSON object." };
  const o = x as Record<string, unknown>;
  if (o.kind !== "bug" && o.kind !== "idea" && o.kind !== "other") return { ok: false, error: "kind must be bug, idea or other." };
  if (!str(o.title, LIM.title) || o.title.trim().length < 4) return { ok: false, error: `The title must be 4 to ${LIM.title} characters.` };
  if (!str(o.description, LIM.description) || o.description.trim().length < 10) return { ok: false, error: `The description must be 10 to ${LIM.description} characters.` };
  const r: Report = { kind: o.kind, title: o.title.trim(), description: o.description.trim() };
  if (o.email !== undefined && o.email !== "") {
    if (!str(o.email, LIM.email) || !/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(o.email)) return { ok: false, error: "The email address isn't valid." };
    r.email = o.email;
  }
  if (o.diagnostics !== undefined) {
    const d = o.diagnostics as Record<string, unknown>;
    if (!d || typeof d !== "object" || !str(d.appVersion, LIM.short) || !str(d.os, LIM.short) || !str(d.electron, LIM.short)
      || !Array.isArray(d.diagnostics) || d.diagnostics.length > LIM.diag || !d.diagnostics.every((s) => str(s, LIM.diagChars))
      || !str(d.simLog, LIM.simLog)) return { ok: false, error: "The diagnostics section is malformed or too large." };
    r.diagnostics = { appVersion: d.appVersion, os: d.os, electron: d.electron, diagnostics: d.diagnostics as string[], simLog: d.simLog };
  }
  if (o.project !== undefined) {
    const p = o.project as Record<string, unknown>;
    if (!p || typeof p !== "object" || !str(p.name, LIM.short) || !str(p.text, LIM.project)) return { ok: false, error: "The attached project is malformed or too large." };
    r.project = { name: p.name, text: p.text };
  }
  if (o.projectOmitted !== undefined) {
    if (!str(o.projectOmitted, 300)) return { ok: false, error: "projectOmitted is too long." };
    r.projectOmitted = o.projectOmitted;
  }
  return { ok: true, report: r };
}

/** Sliding-window counter per key (in memory: one relay instance). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private limit: number;
  private windowMs: number;
  private now: () => number;
  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit; this.windowMs = windowMs; this.now = now;
  }
  /** Records a hit and says whether it is allowed; `retryAfter` is in seconds. */
  take(key: string): { ok: boolean; retryAfter: number } {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((h) => h > t - this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((arr[0] + this.windowMs - t) / 1000)) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.prune(t);
    return { ok: true, retryAfter: 0 };
  }
  private prune(t: number) { for (const [k, v] of this.hits) if (!v.some((h) => h > t - this.windowMs)) this.hits.delete(k); }
}

const defang = (s: string) => s.replace(/@(?=[A-Za-z0-9-])/g, "@​").replace(/(^|\s)#(?=\d)/g, "$1#​");
const fence = (s: string) => s.replace(/```/g, "ˋˋˋ");

export const labelsFor = (kind: Report["kind"]) => ["feedback", ...(kind === "other" ? [] : [kind]), "from-app"];

/** The GitHub issue for a report. User text is defanged so it can't @-mention people or link issues. */
export function toIssue(r: Report): { title: string; body: string; labels: string[] } {
  const prefix = r.kind === "bug" ? "Bug: " : r.kind === "idea" ? "Idea: " : "";
  const parts = [defang(r.description)];
  if (r.email) parts.push(`**Contact:** ${defang(r.email)}`);
  if (r.diagnostics) {
    const d = r.diagnostics;
    parts.push(`### Diagnostics\n- SparkBench ${defang(d.appVersion)}\n- ${defang(d.os)}\n- Electron ${defang(d.electron)}`);
    if (d.diagnostics.length) parts.push("Current problems:\n" + d.diagnostics.map((x) => `- ${defang(x)}`).join("\n"));
    if (d.simLog.trim()) parts.push("<details><summary>Recent simulation log</summary>\n\n```\n" + fence(d.simLog) + "\n```\n</details>");
  }
  if (r.project) parts.push(`<details><summary>Project: ${defang(r.project.name).replace(/[<>]/g, "")}.sbproj</summary>\n\n\`\`\`json\n${fence(r.project.text)}\n\`\`\`\n</details>`);
  else if (r.projectOmitted) parts.push(`### Project\n${defang(r.projectOmitted)}`);
  parts.push("---\n_Sent from the SparkBench app through the feedback relay._");
  return { title: (prefix + r.title).slice(0, 256), body: parts.join("\n\n").slice(0, 65000), labels: labelsFor(r.kind) };
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) { req.resume(); resolve(null); return; }
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > max) over = true; else chunks.push(c); });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The HTTP handler: POST /feedback (and /), GET /health. */
export function createRelay(cfg: RelayConfig) {
  const now = cfg.now ?? Date.now;
  const doFetch = cfg.fetch ?? fetch;
  const log = cfg.log ?? ((m: string) => console.log(m));
  const perIp = new RateLimiter(cfg.perIp, cfg.perIpWindowMs, now);
  const global = new RateLimiter(cfg.global, cfg.globalWindowMs, now);
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) throw new Error("GITHUB_REPO must look like owner/name");

  async function createIssue(issue: { title: string; body: string; labels: string[] }, withLabels = true): Promise<Response> {
    const res = await doFetch(`https://api.github.com/repos/${cfg.repo}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "sparkbench-feedback-relay" },
      body: JSON.stringify(withLabels ? issue : { title: issue.title, body: issue.body }),
    });
    // A token that may not set labels (or a label that doesn't exist) gets 403/422: file it without labels.
    if (withLabels && (res.status === 422 || res.status === 403)) {
      log(`labels refused (${res.status}); retrying without labels`);
      return createIssue(issue, false);
    }
    return res;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname !== "/feedback" && url.pathname !== "/") return send(res, 404, { error: "Not found." });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST." }, { Allow: "POST" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return send(res, 415, { error: "Send JSON." });

    const ip = clientIp(req, cfg.trustProxy);
    const lim = perIp.take(ip);
    if (!lim.ok) return send(res, 429, { error: "Too many reports from this address. Try again later." }, { "Retry-After": String(lim.retryAfter) });

    let text: string | null;
    try { text = await readBody(req, cfg.maxBody); } catch { return send(res, 400, { error: "Couldn't read the request." }); }
    if (text === null) return send(res, 413, { error: `The report is larger than ${Math.round(cfg.maxBody / 1024)} KB.` });
    let json: unknown;
    try { json = JSON.parse(text); } catch { return send(res, 400, { error: "The report isn't valid JSON." }); }

    // Honeypot: the app's hidden "website" field. Pretend success so bots don't learn anything.
    const hp = (json as Record<string, unknown>)?.website;
    if (typeof hp === "string" && hp.trim()) { log(`honeypot hit from ${ip}`); return send(res, 202, { ok: true }); }

    const v = validateReport(json);
    if (!v.ok) return send(res, 400, { error: v.error });

    const g = global.take("all");
    if (!g.ok) return send(res, 429, { error: "The feedback service is busy. Your report will be retried later." }, { "Retry-After": String(g.retryAfter) });

    try {
      const gh = await createIssue(toIssue(v.report));
      if (gh.status === 201) {
        const issue = await gh.json() as { html_url?: string; number?: number };
        log(`created issue #${issue.number} (${v.report.kind}) for ${ip}`);
        return send(res, 201, { ok: true, issueUrl: issue.html_url, number: issue.number });
      }
      log(`GitHub answered ${gh.status}: ${(await gh.text().catch(() => "")).slice(0, 300)}`);
      return send(res, 502, { error: "GitHub didn't accept the report right now. It will be retried." });
    } catch (e) {
      log(`GitHub request failed: ${(e as Error)?.message ?? e}`);
      return send(res, 502, { error: "Couldn't reach GitHub. The report will be retried." });
    }
  };
}

/** Config from environment variables (see README.md). */
export function configFromEnv(env: Record<string, string | undefined>): RelayConfig {
  const token = env.GITHUB_TOKEN ?? "";
  if (!token) throw new Error("GITHUB_TOKEN is not set (a fine-grained PAT with Issues: read and write on the repository).");
  const num = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    token,
    repo: env.GITHUB_REPO ?? "kingrebelf/Spark-bench",
    perIp: num("RATE_PER_IP", DEFAULTS.perIp),
    perIpWindowMs: num("RATE_PER_IP_WINDOW_MIN", DEFAULTS.perIpWindowMs / 60_000) * 60_000,
    global: num("RATE_GLOBAL_PER_HOUR", DEFAULTS.global),
    globalWindowMs: DEFAULTS.globalWindowMs,
    maxBody: num("MAX_BODY_KB", DEFAULTS.maxBody / 1024) * 1024,
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
  };
}
