import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv, createRelay, RateLimiter, toIssue, validateReport, type RelayConfig } from "../relay/lib";
import { buildPayload } from "../src/launcher/feedback";

const good = { kind: "bug", title: "Scope freezes", description: "The scope stops after a minute of live mode." };

describe("relay validation", () => {
  it("accepts what the app sends (all opt-ins on)", () => {
    const r = buildPayload({ ...good, kind: "bug", email: "me@example.com", includeDiagnostics: true, attachProject: true },
      { appVersion: "0.1.1", os: "Windows_NT 10.0 x64", electron: "45.1.0", diagnostics: Array(100).fill("e".repeat(1000)), simLog: Array(400).fill("x".repeat(100)), project: "{}", projectName: "n".repeat(300) });
    if (!r.ok) throw new Error("invalid");
    const v = validateReport(JSON.parse(JSON.stringify(r.payload)));
    expect(v.ok).toBe(true);
  });

  it.each([
    [null, /object/],
    [{ ...good, kind: "rant" }, /kind/],
    [{ ...good, title: "x" }, /title/],
    [{ ...good, description: "d".repeat(8001) }, /description/],
    [{ ...good, email: "not-an-email" }, /email/],
    [{ ...good, diagnostics: { appVersion: "1", os: "w", electron: "1", diagnostics: "nope", simLog: "" } }, /diagnostics/],
    [{ ...good, project: { name: "p", text: "x".repeat(40001) } }, /project/],
  ])("rejects %#", (input, re) => {
    const v = validateReport(input);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(re);
  });

  it("drops unknown fields", () => {
    const v = validateReport({ ...good, labels: ["admin"], assignees: ["x"] });
    expect(v.ok && Object.keys(v.report).sort()).toEqual(["description", "kind", "title"]);
  });
});

describe("issue formatting", () => {
  it("labels by kind, defangs mentions and fenced blocks", () => {
    const i = toIssue({ kind: "idea", title: "More parts", description: "cc @someone see #4", diagnostics: { appVersion: "0.1.1", os: "Win", electron: "45", diagnostics: [], simLog: "a ``` b" } });
    expect(i.title).toBe("Idea: More parts");
    expect(i.labels).toEqual(["feedback", "idea", "from-app"]);
    expect(i.body).toContain("@​someone");
    expect(i.body).toContain("#​4");
    expect(i.body).not.toContain("a ``` b");
  });
});

describe("rate limiter", () => {
  it("allows N per window per key, then reports retry-after", () => {
    let t = 0;
    const l = new RateLimiter(2, 60_000, () => t);
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(true);
    const r = l.take("a");
    expect(r).toEqual({ ok: false, retryAfter: 60 });
    expect(l.take("b").ok).toBe(true);
    t = 60_001;
    expect(l.take("a").ok).toBe(true);
  });
});

describe("relay HTTP service", () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => { server ? server.close(() => r()) : r(); server = null; }));

  async function start(over: Partial<RelayConfig> = {}, gh: (url: string, init: RequestInit) => Response = () => new Response(JSON.stringify({ html_url: "https://github.com/kingrebelf/Spark-bench/issues/42", number: 42 }), { status: 201 })) {
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const cfg: RelayConfig = {
      token: "test-token", repo: "kingrebelf/Spark-bench", perIp: 3, perIpWindowMs: 60_000, global: 100, globalWindowMs: 3600_000, maxBody: 4096, trustProxy: false,
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) }); return gh(url, init); }) as typeof fetch,
      log: () => {}, ...over,
    };
    const handle = createRelay(cfg);
    server = createServer((q, s) => void handle(q, s));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/feedback`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { base, post, calls };
  }

  it("creates a labeled issue with the token and returns its URL", async () => {
    const { post, calls } = await start();
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, issueUrl: "https://github.com/kingrebelf/Spark-bench/issues/42", number: 42 });
    expect(calls[0].url).toBe("https://api.github.com/repos/kingrebelf/Spark-bench/issues");
    expect(calls[0].auth).toBe("Bearer test-token");
    expect(calls[0].body).toMatchObject({ title: "Bug: Scope freezes", labels: ["feedback", "bug", "from-app"] });
  });

  it("rate limits per IP", async () => {
    const { post } = await start();
    for (let i = 0; i < 3; i++) expect((await post(good)).status).toBe(201);
    const r = await post(good);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("only trusts X-Forwarded-For when configured", async () => {
    const a = await start({ perIp: 1 });
    expect((await a.post(good, { "X-Forwarded-For": "1.1.1.1" })).status).toBe(201);
    expect((await a.post(good, { "X-Forwarded-For": "2.2.2.2" })).status).toBe(429); // same socket IP
    await new Promise<void>((r) => server!.close(() => r())); server = null;
    const b = await start({ perIp: 1, trustProxy: true });
    expect((await b.post(good, { "X-Forwarded-For": "1.1.1.1" })).status).toBe(201);
    expect((await b.post(good, { "X-Forwarded-For": "2.2.2.2, 10.0.0.1" })).status).toBe(201);
  });

  it("rejects oversize bodies, bad JSON, wrong methods and content types", async () => {
    const { base, post, calls } = await start();
    expect((await post({ ...good, description: "x".repeat(5000) })).status).toBe(413);
    expect((await post("{not json")).status).toBe(400);
    expect((await fetch(`${base}/feedback`)).status).toBe(405);
    expect((await fetch(`${base}/feedback`, { method: "POST", body: "a=b", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("honeypot: pretends success, files nothing", async () => {
    const { post, calls } = await start();
    const r = await post({ ...good, website: "http://spam.example" });
    expect(r.status).toBe(202);
    expect(calls).toHaveLength(0);
  });

  it("retries without labels when GitHub refuses them", async () => {
    let n = 0;
    const { post, calls } = await start({}, () => (++n === 1 ? new Response("{}", { status: 422 }) : new Response(JSON.stringify({ html_url: "https://github.com/x/y/issues/1", number: 1 }), { status: 201 })));
    expect((await post(good)).status).toBe(201);
    expect(calls[1].body.labels).toBeUndefined();
  });

  it("answers 502 (retryable) when GitHub fails", async () => {
    const { post } = await start({}, () => { throw new Error("ECONNRESET"); });
    expect((await post(good)).status).toBe(502);
  });

  it("needs a token", () => {
    expect(() => configFromEnv({})).toThrow(/GITHUB_TOKEN/);
    expect(configFromEnv({ GITHUB_TOKEN: "t", TRUST_PROXY: "1", RATE_PER_IP: "9" })).toMatchObject({ trustProxy: true, perIp: 9, repo: "kingrebelf/Spark-bench" });
  });
});
