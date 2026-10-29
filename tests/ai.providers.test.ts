import { describe, expect, it, vi } from "vitest";
import { KeyVault, type Crypto } from "../src/ai/keys";
import {
  ANTHROPIC_URL, buildCodexArgs, codexErrorMessage, codexPrompt, completeHttp, DEFAULT_SETTINGS, mergeSettings,
  parseModelList, type AiSettings, type FetchLike,
} from "../src/ai/providers";
import { AI_RESPONSE_JSON_SCHEMA } from "../src/ai/schema";

const req = { system: "SYS", messages: [{ role: "user" as const, content: "Design an LED driver" }], schema: AI_RESPONSE_JSON_SCHEMA };
const settings = (patch: Partial<AiSettings> = {}): AiSettings => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch });

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  const f: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 300, status, statusText: "", text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  });
  return { f, calls };
}

describe("Anthropic provider", () => {
  it("builds a Messages API request with structured output and no sampling params", async () => {
    const { f, calls } = mockFetch(200, { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "{\"ok\":1}" }] });
    const r = await completeHttp(settings(), "anthropic", req, "sk-ant-test", f);
    expect(r).toEqual({ ok: true, text: "{\"ok\":1}", provider: "anthropic", model: "claude-opus-5-5" });
    expect(calls[0].url).toBe(ANTHROPIC_URL);
    const h = calls[0].init.headers;
    expect(h["x-api-key"]).toBe("sk-ant-test");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toBe("SYS");
    expect(body.messages).toEqual(req.messages);
    expect(body.output_config.format).toEqual({ type: "json_schema", schema: AI_RESPONSE_JSON_SCHEMA });
    expect(body.output_config.effort).toBe("high");
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice"]) expect(body[k]).toBeUndefined();
  });
  it("reports HTTP errors with status and the API's message", async () => {
    const { f } = mockFetch(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const r = await completeHttp(settings(), "anthropic", req, "bad", f);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.status).toBe(401); expect(r.error.message).toMatch(/invalid x-api-key/); expect(r.error.message).toMatch(/API key/); }
  });
  it("reports refusals and truncation instead of parsing partial output", async () => {
    let r = await completeHttp(settings(), "anthropic", req, "k", mockFetch(200, { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }).f);
    expect(!r.ok && r.error.kind).toBe("refusal");
    r = await completeHttp(settings(), "anthropic", req, "k", mockFetch(200, { stop_reason: "max_tokens", content: [{ type: "text", text: "{\"mess" }] }).f);
    expect(!r.ok && r.error.kind).toBe("truncated");
  });
  it("without a key, explains setup and that a subscription is not API access", async () => {
    const { f } = mockFetch(200, {});
    const r = await completeHttp(settings(), "anthropic", req, null, f);
    expect(!r.ok && r.error.kind).toBe("setup");
    expect(!r.ok && r.error.message).toMatch(/subscription does not include API access/);
    expect(f).not.toHaveBeenCalled();
  });
  it("network failures are reported, not retried silently", async () => {
    const f: FetchLike = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    const r = await completeHttp(settings(), "anthropic", req, "k", f);
    expect(!r.ok && r.error.kind).toBe("network");
  });
});

describe("OpenAI and OpenAI-compatible providers", () => {
  it("builds a Chat Completions request with a strict json_schema response format", async () => {
    const { f, calls } = mockFetch(200, { model: "m1", choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
    const s = settings({ openai: { model: "gpt-test" } });
    const r = await completeHttp(s, "openai", req, "sk-test", f);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].init.headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0].init.body);
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual(AI_RESPONSE_JSON_SCHEMA);
    expect(body.temperature).toBeUndefined();
  });
  it("uses the configured base URL for local servers and sends no auth header without a key", async () => {
    const { f, calls } = mockFetch(200, { choices: [{ message: { content: "{}" } }] });
    const s = settings({ compatible: { baseUrl: "http://localhost:1234/v1/", model: "qwen" } });
    const r = await completeHttp(s, "compatible", req, null, f);
    expect(r.ok && r.model).toBe("qwen");
    expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");
    expect(calls[0].init.headers.authorization).toBeUndefined();
  });
  it("requires a model and reports server errors", async () => {
    let r = await completeHttp(settings(), "compatible", req, null, mockFetch(200, {}).f);
    expect(!r.ok && r.error.kind).toBe("setup");
    const s = settings({ compatible: { baseUrl: "http://localhost:1234/v1", model: "x" } });
    r = await completeHttp(s, "compatible", req, null, mockFetch(400, { error: { message: "response_format not supported" } }).f);
    expect(!r.ok && r.error.message).toMatch(/response_format not supported/);
    r = await completeHttp(s, "compatible", req, null, mockFetch(200, { choices: [{ finish_reason: "length", message: { content: "{" } }] }).f);
    expect(!r.ok && r.error.kind).toBe("truncated");
  });
  it("parses /models listings", () => {
    expect(parseModelList(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }))).toEqual(["a", "b"]);
    expect(parseModelList("nope")).toEqual([]);
  });
});

describe("settings", () => {
  it("fills defaults and ignores unknown providers", () => {
    const s = mergeSettings({ provider: "evil", anthropic: { model: "claude-sonnet-5-5" } });
    expect(s.provider).toBeNull();
    expect(s.anthropic).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(mergeSettings(null).anthropic.model).toBe("claude-opus-5-5");
  });
});

describe("Codex CLI invocation", () => {
  it("runs read-only, ephemeral, schema-constrained, prompt on stdin", () => {
    const a = buildCodexArgs({ model: "", schemaPath: "S.json", outPath: "O.json", workDir: "W" });
    expect(a[0]).toBe("exec");
    expect(a).toEqual(expect.arrayContaining(["--ignore-user-config", "--skip-git-repo-check", "--ephemeral", "--output-schema", "S.json", "-o", "O.json", "-C", "W"]));
    expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(a.at(-1)).toBe("-");
    expect(a).not.toContain("-m");
    expect(a).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(buildCodexArgs({ model: "gpt-x", schemaPath: "S", outPath: "O", workDir: "W" })).toEqual(expect.arrayContaining(["-m", "gpt-x"]));
  });
  it("flattens the conversation into one prompt", () => {
    const p = codexPrompt({ ...req, messages: [...req.messages, { role: "assistant", content: "{\"a\":1}" }, { role: "user", content: "5 V supply" }] });
    expect(p.startsWith("SYS")).toBe(true);
    expect(p.indexOf("Design an LED driver")).toBeLessThan(p.indexOf("5 V supply"));
  });
  it("surfaces the CLI's own error and ignores the models-cache noise", () => {
    const stderr = "2026 ERROR codex_models_manager::cache: failed to load models cache\nERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'x' model is not supported when using Codex with a ChatGPT account.\"}}";
    const m = codexErrorMessage(1, stderr, "");
    expect(m).toMatch(/not supported when using Codex with a ChatGPT account/);
    expect(m).not.toMatch(/models cache/);
  });
});

describe("key vault (safeStorage mocked)", () => {
  const mk = (available = true) => {
    let file: string | null = null;
    const crypto: Crypto = {
      isEncryptionAvailable: () => available,
      encryptString: (s) => new TextEncoder().encode([...s].reverse().join("")),
      decryptString: (u) => [...new TextDecoder().decode(u)].reverse().join(""),
    };
    const vault = new KeyVault(crypto, { read: async () => file, write: async (t) => { file = t; } });
    return { vault, raw: () => file };
  };
  it("stores keys encrypted and only reports yes/no status", async () => {
    const { vault, raw } = mk();
    await vault.set("anthropic", "  sk-ant-secret  ");
    expect(raw()).not.toContain("sk-ant-secret");
    expect(await vault.get("anthropic")).toBe("sk-ant-secret");
    const st = await vault.status("http://localhost:1234/v1");
    expect(st).toEqual({ anthropic: true, openai: false, compatible: false });
    expect(JSON.stringify(st)).not.toContain("secret");
    await vault.clear("anthropic");
    expect(await vault.get("anthropic")).toBeNull();
  });
  it("refuses to store anything when encryption is unavailable (no plaintext fallback)", async () => {
    const { vault, raw } = mk(false);
    await expect(vault.set("openai", "sk-x")).rejects.toThrow(/never stores API keys unencrypted/);
    expect(raw()).toBeNull();
  });
  it("binds a compatible-server key to its base URL", async () => {
    const { vault } = mk();
    await vault.set("compatible", "local-key", "http://localhost:1234/v1");
    expect(await vault.get("compatible", "http://localhost:1234/v1")).toBe("local-key");
    expect(await vault.get("compatible", "https://evil.example/v1")).toBeNull();
    expect(await vault.rebindCheck("https://evil.example/v1")).toBe(true);
    expect(await vault.get("compatible", "http://localhost:1234/v1")).toBeNull();
  });
  it("rejects empty or multi-line keys", async () => {
    const { vault } = mk();
    await expect(vault.set("openai", "  ")).rejects.toThrow(/empty/);
    await expect(vault.set("openai", "sk-a\nsk-b")).rejects.toThrow(/spaces/);
  });
});
