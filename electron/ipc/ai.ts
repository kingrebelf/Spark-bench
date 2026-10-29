// AI assistant: settings, encrypted API keys, provider calls and the Codex CLI.
// Keys are encrypted with safeStorage (DPAPI on Windows) in userData and never sent to the renderer;
// every network call and the Codex process run here in the main process.
import { app, ipcMain, safeStorage } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyVault, type KeyProvider } from "../../src/ai/keys";
import {
  buildCodexArgs, codexErrorMessage, codexPrompt, completeHttp, isCodexModelRejected, listAnthropicModels, mergeSettings, modelOptions,
  normalizeBaseUrl, OPENAI_BASE, parseCodexModels, parseModelList,
  type AiSettings, type ChatMessage, type CompletionResult, type FetchLike, type ModelListResult, type ProviderId,
} from "../../src/ai/providers";
import { AI_RESPONSE_JSON_SCHEMA } from "../../src/ai/schema";

const dir = () => path.join(app.getPath("userData"), "ai");
const settingsFile = () => path.join(dir(), "settings.json");
const keysFile = () => path.join(dir(), "keys.json");

const vault = new KeyVault(
  {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (u) => safeStorage.decryptString(Buffer.from(u)),
  },
  {
    read: async () => { try { return await fs.readFile(keysFile(), "utf8"); } catch { return null; } },
    write: async (t) => { await fs.mkdir(dir(), { recursive: true }); await fs.writeFile(`${keysFile()}.tmp`, t, "utf8"); await fs.rename(`${keysFile()}.tmp`, keysFile()); },
  },
);

async function loadSettings(): Promise<AiSettings> {
  try { return mergeSettings(JSON.parse(await fs.readFile(settingsFile(), "utf8"))); } catch { return mergeSettings(null); }
}
async function saveSettings(s: AiSettings) {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(s, null, 2), "utf8");
}

async function state() {
  const settings = await loadSettings();
  return {
    settings,
    keys: await vault.status(normalizeBaseUrl(settings.compatible.baseUrl)),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}

const nodeFetch: FetchLike = (url, init) => fetch(url, init) as ReturnType<FetchLike>;

// ------------------------------------------------------------------ Codex

function findCodex(configured: string): string | null {
  if (configured.trim()) return existsSync(configured.trim()) ? configured.trim() : null;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8", windowsHide: true });
  const hits = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => !/\.(cmd|bat|ps1)$/i.test(h)) ?? hits[0];
  if (exe) return exe;
  const guess = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe") : "";
  return guess && existsSync(guess) ? guess : null;
}

const needsShell = (exe: string) => /\.(cmd|bat)$/i.test(exe);

function codexStatus(settings: AiSettings) {
  const exe = findCodex(settings.codex.path);
  if (!exe) return { found: false as const, message: "Codex CLI was not found. Install it (see developers.openai.com/codex), run `codex login`, or set its path in Assistant settings." };
  const v = spawnSync(exe, ["--version"], { encoding: "utf8", windowsHide: true, shell: needsShell(exe), timeout: 15000 });
  const l = spawnSync(exe, ["login", "status"], { encoding: "utf8", windowsHide: true, shell: needsShell(exe), timeout: 15000 });
  const login = `${l.stdout ?? ""}${l.stderr ?? ""}`.split(/\r?\n/).filter((x) => x.trim() && !/models cache/i.test(x)).join(" ").trim();
  return { found: true as const, path: exe, version: (v.stdout ?? "").trim(), login, chatgpt: /logged in using chatgpt/i.test(login), apiKey: /api key/i.test(login) };
}

let running: { abort: () => void } | null = null;

async function runCodex(settings: AiSettings, system: string, messages: ChatMessage[]): Promise<CompletionResult> {
  const exe = findCodex(settings.codex.path);
  if (!exe) return { ok: false, error: { kind: "setup", message: "Codex CLI was not found. Install it, run `codex login` (choose “Sign in with ChatGPT”), or set its path in Assistant settings." } };
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "sparkbench-codex-"));
  const empty = path.join(work, "empty");
  await fs.mkdir(empty);
  const schemaPath = path.join(work, "schema.json");
  const outPath = path.join(work, "reply.json");
  await fs.writeFile(schemaPath, JSON.stringify(AI_RESPONSE_JSON_SCHEMA), "utf8");
  const args = buildCodexArgs({ model: settings.codex.model, schemaPath, outPath, workDir: empty });
  try {
    const { code, stdout, stderr, killed } = await new Promise<{ code: number | null; stdout: string; stderr: string; killed: "timeout" | "cancel" | null }>((resolve) => {
      const child = spawn(exe, args, { cwd: empty, windowsHide: true, shell: needsShell(exe) });
      let out = "", err = "", killed: "timeout" | "cancel" | null = null;
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      const timer = setTimeout(() => { killed = "timeout"; child.kill(); }, Math.max(30, settings.codex.timeoutSec) * 1000);
      running = { abort: () => { killed = "cancel"; child.kill(); } };
      child.on("error", (e) => { err += `\nERROR: ${e.message}`; });
      child.on("close", (c) => { clearTimeout(timer); running = null; resolve({ code: c, stdout: out, stderr: err, killed }); });
      child.stdin.end(codexPrompt({ system, messages, schema: AI_RESPONSE_JSON_SCHEMA }));
    });
    if (killed === "cancel") return { ok: false, error: { kind: "cancelled", message: "Request cancelled." } };
    if (killed === "timeout") return { ok: false, error: { kind: "codex", message: `Codex did not answer within ${settings.codex.timeoutSec} s and was stopped. Increase the timeout in Assistant settings or retry.` } };
    let text = "";
    try { text = await fs.readFile(outPath, "utf8"); } catch { /* no reply file */ }
    if (code !== 0 || !text.trim()) {
      const fix = settings.codex.model.trim() && isCodexModelRejected(stderr) ? "codex-default-model" as const : undefined;
      return { ok: false, error: { kind: "codex", message: codexErrorMessage(code, stderr, stdout), detail: stderr.slice(-2000), fix } };
    }
    const model = /^model:\s*(\S+)/m.exec(stdout + "\n" + stderr)?.[1] ?? settings.codex.model;
    return { ok: true, text, provider: "codex", model, note: "Answered by Codex CLI with your ChatGPT sign-in (counts toward your ChatGPT plan's Codex limits)." };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The models this Codex sign-in can use, from `codex debug models` (the CLI's own catalog, refreshed from
 * OpenAI for the logged-in account; a debug subcommand, so its format may change between Codex versions).
 * Only stdout is parsed: stderr carries unrelated cache warnings.
 */
async function codexModels(settings: AiSettings): Promise<ModelListResult> {
  const exe = findCodex(settings.codex.path);
  if (!exe) return { ok: false, error: "Codex CLI was not found." };
  const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(exe, ["debug", "models"], { windowsHide: true, shell: needsShell(exe) });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: "" }); });
    child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, stdout: out }); });
  });
  const models = code === 0 ? parseCodexModels(stdout) : null;
  if (!models) return { ok: false, error: `Could not read the model list from Codex (\`codex debug models\` exited with ${code}). Use “Codex default” or enter a model id under Custom.` };
  const v = spawnSync(exe, ["--version"], { encoding: "utf8", windowsHide: true, shell: needsShell(exe), timeout: 15000 });
  return { ok: true, models, source: `Models offered to your sign-in by ${(v.stdout ?? "").trim() || "the Codex CLI"} (\`codex debug models\`).` };
}

// ------------------------------------------------------------------ KiCad footprint lookup

function footprintDirs(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) if (/^KICAD\d*_FOOTPRINT_DIR$/.test(k) && v) out.push(v);
  const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "KiCad"), process.env.ProgramFiles && path.join(process.env.ProgramFiles, "KiCad")].filter(Boolean) as string[];
  for (const r of roots) {
    try {
      for (const ver of readdirSync(r)) out.push(path.join(r, ver, "share", "kicad", "footprints"));
    } catch { /* not installed here */ }
  }
  return out.filter((d) => existsSync(d));
}

// ------------------------------------------------------------------ IPC

export function registerAiIpc(): void {
  ipcMain.handle("sb:ai:getState", () => state());

  ipcMain.handle("sb:ai:saveSettings", async (_e, incoming: unknown) => {
    const prev = await loadSettings();
    const next = mergeSettings(incoming);
    next.compatible.baseUrl = normalizeBaseUrl(next.compatible.baseUrl);
    if (next.compatible.baseUrl !== normalizeBaseUrl(prev.compatible.baseUrl)) await vault.rebindCheck(next.compatible.baseUrl);
    await saveSettings(next);
    return state();
  });

  ipcMain.handle("sb:ai:setKey", async (_e, a: { provider: KeyProvider; key: string }) => {
    if (!["anthropic", "openai", "compatible"].includes(a?.provider)) throw new Error("Unknown provider.");
    const s = await loadSettings();
    await vault.set(a.provider, String(a.key ?? ""), normalizeBaseUrl(s.compatible.baseUrl));
    return state();
  });

  ipcMain.handle("sb:ai:clearKey", async (_e, provider: KeyProvider) => {
    if (!["anthropic", "openai", "compatible"].includes(provider)) throw new Error("Unknown provider.");
    await vault.clear(provider);
    return state();
  });

  ipcMain.handle("sb:ai:listModels", async (_e, provider: ProviderId): Promise<ModelListResult> => {
    const s = await loadSettings();
    if (provider === "codex") return codexModels(s);
    if (provider === "anthropic") {
      const key = await vault.get("anthropic");
      if (!key) return { ok: false, error: "Save an Anthropic API key to list the models it can use." };
      return listAnthropicModels(key, nodeFetch, AbortSignal.timeout(15000));
    }
    if (provider !== "openai" && provider !== "compatible") return { ok: false, error: "Unknown provider." };
    const base = provider === "openai" ? OPENAI_BASE : normalizeBaseUrl(s.compatible.baseUrl);
    const key = await vault.get(provider, provider === "compatible" ? base : undefined);
    if (provider === "openai" && !key) return { ok: false, error: "Save an OpenAI API key to list the models it can use." };
    try {
      const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      return { ok: true, models: modelOptions(parseModelList(text)), source: `Models listed by ${base}/models.` };
    } catch (e) {
      return { ok: false, error: `Could not reach ${base}: ${(e as Error).message}` };
    }
  });

  ipcMain.handle("sb:ai:codexStatus", async () => codexStatus(await loadSettings()));

  ipcMain.handle("sb:ai:complete", async (_e, a: { system: string; messages: ChatMessage[] }): Promise<CompletionResult> => {
    const s = await loadSettings();
    if (!s.provider) return { ok: false, error: { kind: "setup", message: "No AI provider is set up. Open Assistant settings and choose one." } };
    if (running) return { ok: false, error: { kind: "setup", message: "Another assistant request is still running." } };
    const messages = (a?.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    if (!messages.length || typeof a?.system !== "string") return { ok: false, error: { kind: "setup", message: "Empty request." } };
    if (s.provider === "codex") return runCodex(s, a.system, messages);
    const key = await vault.get(s.provider, s.provider === "compatible" ? normalizeBaseUrl(s.compatible.baseUrl) : undefined);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10 * 60_000);
    running = { abort: () => ctl.abort() };
    try {
      return await completeHttp(s, s.provider, { system: a.system, messages, schema: AI_RESPONSE_JSON_SCHEMA }, key, nodeFetch, ctl.signal);
    } finally {
      clearTimeout(timer);
      running = null;
    }
  });

  ipcMain.handle("sb:ai:cancel", () => { running?.abort(); });

  /** For "prepare for KiCad": which proposed footprints exist in the installed KiCad libraries. */
  ipcMain.handle("sb:ai:checkFootprints", (_e, ids: string[]) => {
    const dirs = footprintDirs();
    const out: Record<string, "found" | "missing" | "unknown"> = {};
    for (const id of Array.isArray(ids) ? ids.slice(0, 500) : []) {
      const m = /^([^:/\\]+):([^:/\\]+)$/.exec(String(id));
      if (!m || !dirs.length) { out[id] = m ? "unknown" : "missing"; continue; }
      out[id] = dirs.some((d) => existsSync(path.join(d, `${m[1]}.pretty`, `${m[2]}.kicad_mod`))) ? "found" : "missing";
    }
    return out;
  });
}
