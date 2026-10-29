// Provider settings, request building and response parsing. Pure functions with an injectable
// fetch, used by the Electron main process (electron/ipc/ai.ts) and by tests with a mock fetch.
// No API key ever passes through the renderer: the main process reads it from the key vault and
// calls `complete()` itself.

export type ProviderId = "anthropic" | "openai" | "compatible" | "codex";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiSettings {
  provider: ProviderId | null;
  anthropic: { model: string; effort: Effort };
  openai: { model: string };
  /** Any server speaking the OpenAI Chat Completions API (LM Studio, Ollama, vLLM, llama.cpp ...). */
  compatible: { baseUrl: string; model: string };
  /** `path` "" = auto-detect; `model` "" = Codex's default for a ChatGPT sign-in. */
  codex: { path: string; model: string; timeoutSec: number };
}

export const DEFAULT_SETTINGS: AiSettings = {
  provider: null,
  anthropic: { model: "claude-opus-5-5", effort: "high" },
  openai: { model: "" },
  compatible: { baseUrl: "http://localhost:1234/v1", model: "" },
  codex: { path: "", model: "", timeoutSec: 300 },
};

/** Fixed endpoints: the renderer can never redirect a stored key to another host. */
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const OPENAI_BASE = "https://api.openai.com/v1";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic API (Claude)",
  openai: "OpenAI API",
  compatible: "OpenAI-compatible server (local models)",
  codex: "Codex CLI (uses your ChatGPT sign-in)",
};

export interface ChatMessage { role: "user" | "assistant"; content: string }
export interface CompletionRequest { system: string; messages: ChatMessage[]; schema: Record<string, unknown> }

export type AiErrorKind = "setup" | "network" | "http" | "refusal" | "truncated" | "format" | "codex" | "cancelled";
export interface AiError { kind: AiErrorKind; message: string; status?: number; detail?: string }
export type CompletionResult =
  | { ok: true; text: string; provider: ProviderId; model: string; note?: string }
  | { ok: false; error: AiError };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; statusText: string; text(): Promise<string>;
}>;

export function mergeSettings(saved: unknown): AiSettings {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<AiSettings>;
  const d = DEFAULT_SETTINGS;
  const providers: ProviderId[] = ["anthropic", "openai", "compatible", "codex"];
  return {
    provider: providers.includes(s.provider as ProviderId) ? (s.provider as ProviderId) : null,
    anthropic: { ...d.anthropic, ...s.anthropic },
    openai: { ...d.openai, ...s.openai },
    compatible: { ...d.compatible, ...s.compatible },
    codex: { ...d.codex, ...s.codex },
  };
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

// ------------------------------------------------------------------ Anthropic

export function buildAnthropicRequest(s: AiSettings["anthropic"], req: CompletionRequest, apiKey: string) {
  const body = {
    model: s.model,
    max_tokens: 16000,
    system: req.system,
    messages: req.messages,
    // Structured outputs: the reply is constrained to the JSON schema. No sampling parameters
    // (rejected by current models) and no prefill (not supported).
    output_config: { effort: s.effort, format: { type: "json_schema", schema: req.schema } },
  };
  return {
    url: ANTHROPIC_URL,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify(body),
    },
  };
}

export function parseAnthropicResponse(status: number, text: string): { ok: true; text: string; model: string } | { ok: false; error: AiError } {
  let json: any;
  try { json = JSON.parse(text); } catch { return { ok: false, error: { kind: "http", status, message: `Anthropic API returned HTTP ${status} with a non-JSON body.`, detail: text.slice(0, 500) } }; }
  if (status < 200 || status >= 300 || json?.type === "error") {
    const msg = json?.error?.message ?? text.slice(0, 300);
    const hint = status === 401 ? " Check the API key in Assistant settings." : status === 404 ? " Check the model id." : status === 429 ? " Rate limited; wait and retry." : status === 529 ? " The API is overloaded; retry shortly." : "";
    return { ok: false, error: { kind: "http", status, message: `Anthropic API error ${status} (${json?.error?.type ?? "error"}): ${msg}.${hint}` } };
  }
  if (json.stop_reason === "refusal") {
    const d = json.stop_details;
    return { ok: false, error: { kind: "refusal", message: `The model declined this request${d?.category ? ` (category: ${d.category})` : ""}.${d?.explanation ? ` ${d.explanation}` : ""}` } };
  }
  if (json.stop_reason === "max_tokens") return { ok: false, error: { kind: "truncated", message: "The reply was cut off at the output limit before it was complete. Retry, or ask for a smaller change." } };
  const block = (json.content ?? []).find((b: any) => b?.type === "text");
  if (!block?.text) return { ok: false, error: { kind: "format", message: "The Anthropic reply contained no text block." } };
  return { ok: true, text: block.text, model: json.model ?? "" };
}

// ------------------------------------------------------------------ OpenAI / OpenAI-compatible

export function buildOpenAiRequest(baseUrl: string, model: string, req: CompletionRequest, apiKey: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = {
    model,
    messages: [{ role: "system", content: req.system }, ...req.messages],
    response_format: { type: "json_schema", json_schema: { name: "sparkbench_reply", strict: true, schema: req.schema } },
  };
  return { url: `${normalizeBaseUrl(baseUrl)}/chat/completions`, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

export function parseOpenAiResponse(status: number, text: string, who: string): { ok: true; text: string; model: string } | { ok: false; error: AiError } {
  let json: any;
  try { json = JSON.parse(text); } catch { return { ok: false, error: { kind: "http", status, message: `${who} returned HTTP ${status} with a non-JSON body.`, detail: text.slice(0, 500) } }; }
  if (status < 200 || status >= 300 || json?.error) {
    const msg = typeof json?.error === "string" ? json.error : json?.error?.message ?? text.slice(0, 300);
    const hint = status === 401 ? " Check the API key." : status === 404 ? " Check the base URL and model id." : status === 429 ? " Rate limited or out of quota." : "";
    return { ok: false, error: { kind: "http", status, message: `${who} error ${status}: ${msg}.${hint}` } };
  }
  const choice = json?.choices?.[0];
  if (choice?.message?.refusal) return { ok: false, error: { kind: "refusal", message: `The model declined: ${choice.message.refusal}` } };
  if (choice?.finish_reason === "length") return { ok: false, error: { kind: "truncated", message: "The reply was cut off at the output limit before it was complete. Retry, or raise the server's context/output limit." } };
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) return { ok: false, error: { kind: "format", message: `${who} returned no message content.` } };
  return { ok: true, text: content, model: json.model ?? "" };
}

export function parseModelList(text: string): string[] {
  try {
    const j = JSON.parse(text);
    return (j?.data ?? []).map((m: any) => m?.id).filter((x: unknown): x is string => typeof x === "string").sort();
  } catch { return []; }
}

// ------------------------------------------------------------------ dispatch (HTTP providers)

/** Node's fetch reports every transport failure as "fetch failed"; the real reason is in `cause`. */
export function networkMessage(e: unknown, who: string, local: boolean): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return `${who} did not answer within 5 minutes (the HTTP client's limit), so the request was abandoned. Retry, lower the effort, or ask for a smaller change.`;
  }
  if (code === "ECONNREFUSED") return `Could not connect to ${who} (connection refused).${local ? " Is the server running and is a model loaded?" : ""}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Could not resolve the host for ${who}. Check your internet connection${local ? " and the base URL" : ""}.`;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
  return `Could not reach ${who}: ${(e as Error)?.message ?? String(e)}${detail ? ` (${detail})` : ""}.${local ? " Is the server running?" : " Check your internet connection."}`;
}

export async function completeHttp(
  settings: AiSettings, provider: Exclude<ProviderId, "codex">, req: CompletionRequest, apiKey: string | null,
  fetchImpl: FetchLike, signal?: AbortSignal,
): Promise<CompletionResult> {
  let built: { url: string; init: { method: string; headers: Record<string, string>; body: string } };
  let who: string;
  if (provider === "anthropic") {
    if (!apiKey) return { ok: false, error: { kind: "setup", message: "No Anthropic API key is set. Open Assistant settings and paste a key from console.anthropic.com (Settings → API keys). A Claude.ai subscription does not include API access." } };
    built = buildAnthropicRequest(settings.anthropic, req, apiKey);
    who = "Anthropic API";
  } else if (provider === "openai") {
    if (!apiKey) return { ok: false, error: { kind: "setup", message: "No OpenAI API key is set. Open Assistant settings and paste a key from platform.openai.com/api-keys. A ChatGPT subscription does not include API access; use the Codex CLI provider to use your ChatGPT sign-in." } };
    if (!settings.openai.model.trim()) return { ok: false, error: { kind: "setup", message: "Choose an OpenAI model in Assistant settings (use “List models” to see what your key can use)." } };
    built = buildOpenAiRequest(OPENAI_BASE, settings.openai.model, req, apiKey);
    who = "OpenAI API";
  } else {
    if (!/^https?:\/\//.test(settings.compatible.baseUrl.trim())) return { ok: false, error: { kind: "setup", message: "Set the server's base URL in Assistant settings, e.g. http://localhost:1234/v1 for LM Studio." } };
    if (!settings.compatible.model.trim()) return { ok: false, error: { kind: "setup", message: "Choose a model for the OpenAI-compatible server in Assistant settings (use “List models”)." } };
    built = buildOpenAiRequest(settings.compatible.baseUrl, settings.compatible.model, req, apiKey);
    who = `Server at ${normalizeBaseUrl(settings.compatible.baseUrl)}`;
  }
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(built.url, { ...built.init, signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") return { ok: false, error: { kind: "cancelled", message: "Request cancelled." } };
    return { ok: false, error: { kind: "network", message: networkMessage(e, who, provider === "compatible") } };
  }
  const body = await res.text();
  const parsed = provider === "anthropic" ? parseAnthropicResponse(res.status, body) : parseOpenAiResponse(res.status, body, who);
  if (!parsed.ok) return parsed;
  return { ok: true, text: parsed.text, provider, model: parsed.model || (provider === "anthropic" ? settings.anthropic.model : provider === "openai" ? settings.openai.model : settings.compatible.model) };
}

// ------------------------------------------------------------------ Codex CLI

/**
 * Arguments for `codex exec`. Documented non-interactive usage (learn.chatgpt.com/docs/non-interactive-mode):
 * read-only sandbox, no session files, JSON-Schema-constrained final message written to a file.
 * `--ignore-user-config` keeps the user's personal config (which may pin a model their ChatGPT
 * sign-in cannot use, or a different provider) out of SparkBench's calls; auth still comes from CODEX_HOME.
 * The prompt is passed on stdin ("-") to avoid Windows command-line length limits.
 */
export function buildCodexArgs(o: { model: string; schemaPath: string; outPath: string; workDir: string }): string[] {
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral",
    "--sandbox", "read-only", "--color", "never", "-C", o.workDir, "--output-schema", o.schemaPath, "-o", o.outPath];
  if (o.model.trim()) args.push("-m", o.model.trim());
  args.push("-");
  return args;
}

/** Codex has no multi-turn API in exec mode: the conversation is flattened into one prompt. */
export function codexPrompt(req: CompletionRequest): string {
  const turns = req.messages.map((m) => `### ${m.role === "user" ? "User" : "Assistant (your earlier JSON reply)"}\n${m.content}`).join("\n\n");
  return `${req.system}\n\nDo not run shell commands or read files; everything you need is below. Answer the last user message with the JSON reply only.\n\n${turns}`;
}

/** Turn Codex stderr/stdout into an honest error message (keeps the CLI's own wording). */
export function codexErrorMessage(exitCode: number | null, stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/);
  const err = lines.filter((l) => /^ERROR:|error":|not supported|not logged in|login/i.test(l) && !/models_manager|models cache/i.test(l));
  const m = err.map((l) => { const j = /"message":"([^"]+)"/.exec(l); return j ? j[1] : l.replace(/^ERROR:\s*/, ""); });
  const uniq = [...new Set(m.map((x) => x.trim()).filter(Boolean))].slice(0, 3);
  return uniq.length ? `Codex CLI failed (exit ${exitCode}): ${uniq.join(" | ")}` : `Codex CLI exited with code ${exitCode} without producing a reply.`;
}
