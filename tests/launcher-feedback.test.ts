import { describe, expect, it } from "vitest";
import { buildIssueUrl, buildPayload, defang, ISSUE_URL_MAX, labelsFor, LIMITS, validateForm, type FeedbackContext, type FeedbackForm } from "../src/launcher/feedback";
import { backoff, classifyRelayResponse, FeedbackQueue, MAX_ATTEMPTS, type QueueItem, type SendResult } from "../src/launcher/feedbackQueue";

const form = (o: Partial<FeedbackForm> = {}): FeedbackForm =>
  ({ kind: "bug", title: "Scope freezes", description: "The scope stops updating after a minute of live mode.", includeDiagnostics: false, attachProject: false, ...o });
const ctx: FeedbackContext = {
  appVersion: "0.1.1", os: "Windows_NT 10.0.26300 x64", electron: "45.1.0",
  diagnostics: ["error: no ground", "warning: R1 floating"], simLog: Array.from({ length: 500 }, (_, i) => `line ${i}`),
  project: '{"format":"sparkbench"}', projectName: "blinker",
};

describe("feedback payload", () => {
  it("validates title, description and email", () => {
    expect(validateForm(form())).toEqual([]);
    expect(validateForm(form({ title: "x", description: "short", email: "nope" }))).toHaveLength(3);
    expect(validateForm(form({ title: "y".repeat(121) }))[0]).toMatch(/too long/);
  });

  it("sends no diagnostics and no project unless opted in", () => {
    const r = buildPayload(form(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.diagnostics).toBeUndefined();
    expect(r.payload.project).toBeUndefined();
    expect(JSON.stringify(r.payload)).not.toContain("sparkbench\"");
    expect(JSON.stringify(r.payload)).not.toContain("Windows");
  });

  it("includes diagnostics when opted in, with the sim log trimmed", () => {
    const r = buildPayload(form({ includeDiagnostics: true }), ctx);
    if (!r.ok) throw new Error("invalid");
    const d = r.payload.diagnostics!;
    expect(d).toMatchObject({ appVersion: "0.1.1", electron: "45.1.0", diagnostics: ctx.diagnostics });
    expect(d.simLog.split("\n")).toHaveLength(LIMITS.simLogLines);
    expect(d.simLog.endsWith("line 499")).toBe(true);
    expect(r.payload.project).toBeUndefined();
  });

  it("attaches the project only when ticked, and refuses one that is too large", () => {
    const r = buildPayload(form({ attachProject: true }), ctx);
    if (!r.ok) throw new Error("invalid");
    expect(r.payload.project).toEqual({ name: "blinker", text: ctx.project });
    const big = buildPayload(form({ attachProject: true }), { ...ctx, project: "x".repeat(LIMITS.projectChars + 1) });
    if (!big.ok) throw new Error("invalid");
    expect(big.payload.project).toBeUndefined();
    expect(big.payload.projectOmitted).toMatch(/too large/);
  });

  it("stays under the relay's size limit", () => {
    const r = buildPayload(form({ includeDiagnostics: true, attachProject: true, description: "d".repeat(8000) }),
      { ...ctx, diagnostics: Array.from({ length: 200 }, () => "e".repeat(2000)), simLog: Array.from({ length: 1000 }, () => "l".repeat(500)), project: "p".repeat(LIMITS.projectChars) });
    if (!r.ok) throw new Error("invalid");
    expect(new TextEncoder().encode(JSON.stringify(r.payload)).length).toBeLessThanOrEqual(LIMITS.payloadBytes);
    expect(r.payload.description).toHaveLength(8000);
    expect(r.payload.diagnostics!.diagnostics).toHaveLength(LIMITS.diagnosticsMax);
  });

  it("labels by kind", () => {
    expect(labelsFor("bug")).toEqual(["feedback", "bug", "from-app"]);
    expect(labelsFor("other")).toEqual(["feedback", "from-app"]);
  });

  it("defangs mentions and issue refs", () => {
    expect(defang("ping @octocat about #12, email a@b.com")).toBe("ping @​octocat about #​12, email a@​b.com");
  });
});

describe("prefilled GitHub issue link", () => {
  const payload = (o: Partial<FeedbackForm> = {}, c = ctx) => { const r = buildPayload(form(o), c); if (!r.ok) throw new Error("invalid"); return r.payload; };

  it("carries title, body and labels, without email", () => {
    const u = new URL(buildIssueUrl(payload({ email: "me@example.com", includeDiagnostics: true })));
    expect(u.origin + u.pathname).toBe("https://github.com/kingrebelf/Spark-bench/issues/new");
    expect(u.searchParams.get("title")).toBe("Bug: Scope freezes");
    expect(u.searchParams.get("labels")).toBe("feedback,bug,from-app");
    const body = u.searchParams.get("body")!;
    expect(body).toContain("The scope stops updating");
    expect(body).toContain("Electron 45.1.0");
    expect(body).toContain("Labels: feedback, bug, from-app");
    expect(body).not.toContain("me@example.com");
  });

  it("never puts project contents in the link", () => {
    const body = new URL(buildIssueUrl(payload({ attachProject: true }))).searchParams.get("body")!;
    expect(body).not.toContain('{"format"');
    expect(body).toMatch(/drag your \.sbproj/);
  });

  it("fits within the URL limit by trimming the log, then the description", () => {
    const big = payload({ includeDiagnostics: true, description: "word ".repeat(1500) }, { ...ctx, simLog: Array.from({ length: 150 }, () => "x".repeat(80)) });
    const u = buildIssueUrl(big);
    expect(u.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(new URL(u).searchParams.get("body")).toMatch(/shortened to fit a link/);
    const small = buildIssueUrl(payload({ includeDiagnostics: true }, { ...ctx, simLog: ["only line"] }));
    expect(new URL(small).searchParams.get("body")).toContain("only line");
  });
});

describe("offline queue", () => {
  const p = (() => { const r = buildPayload(form(), ctx); if (!r.ok) throw new Error(); return r.payload; })();
  const memStore = () => { let items: QueueItem[] = []; return { load: async () => items.map((x) => ({ ...x })), save: async (x: QueueItem[]) => { items = x; }, get items() { return items; } }; };

  it("sends straight away when the relay answers", async () => {
    const store = memStore();
    const q = new FeedbackQueue(store, async () => ({ ok: true, issueUrl: "https://github.com/kingrebelf/Spark-bench/issues/7" }));
    expect(await q.submit(p)).toEqual({ status: "sent", issueUrl: "https://github.com/kingrebelf/Spark-bench/issues/7" });
    expect(store.items).toHaveLength(0);
  });

  it("queues when offline and delivers on a later flush with backoff", async () => {
    let t = 1_000_000, online = false, sends = 0;
    const store = memStore();
    const q = new FeedbackQueue(store, async (): Promise<SendResult> => { sends++; if (!online) throw new Error("fetch failed"); return { ok: true }; }, () => t);
    expect((await q.submit(p)).status).toBe("queued");
    expect(store.items[0]).toMatchObject({ attempts: 1, nextAt: t + backoff(1) });
    expect((await q.flush()).remaining).toBe(1); // not due yet
    expect(sends).toBe(1);
    t += backoff(1);
    expect(await q.flush()).toMatchObject({ remaining: 1, sent: [] }); // due, still offline
    expect(store.items[0].attempts).toBe(2);
    online = true;
    expect((await q.flush(true)).sent).toHaveLength(1);
    expect(store.items).toHaveLength(0);
  });

  it("doesn't queue reports the relay refused for good", async () => {
    const q = new FeedbackQueue(memStore(), async () => classifyRelayResponse(400, { error: "Title is required." }));
    expect(await q.submit(p)).toEqual({ status: "rejected", error: "Title is required." });
  });

  it("stops after one failure per flush and gives up after the max attempts", async () => {
    const store = memStore();
    let t = 0, sends = 0;
    await store.save([1, 2, 3].map((i) => ({ id: `q${i}`, payload: p, queuedAt: "", attempts: MAX_ATTEMPTS - 1, nextAt: 0 })));
    const q = new FeedbackQueue(store, async () => { sends++; return { ok: false, retry: true, error: "503" }; }, () => t);
    const r = await q.flush();
    expect(sends).toBe(1);
    expect(r.remaining).toBe(3);
    t = 1e12;
    await q.flush(); await q.flush(); await q.flush();
    expect(store.items.length).toBeLessThan(3);
  });

  it("classifies relay answers", () => {
    expect(classifyRelayResponse(201, { issueUrl: "https://github.com/a/b/issues/1" })).toEqual({ ok: true, issueUrl: "https://github.com/a/b/issues/1" });
    expect(classifyRelayResponse(201, { issueUrl: "https://evil.example/" })).toEqual({ ok: true, issueUrl: undefined });
    expect(classifyRelayResponse(429, {})).toMatchObject({ ok: false, retry: true });
    expect(classifyRelayResponse(502, {})).toMatchObject({ ok: false, retry: true });
    expect(classifyRelayResponse(413, { error: "too big" })).toEqual({ ok: false, retry: false, error: "too big" });
  });
});
