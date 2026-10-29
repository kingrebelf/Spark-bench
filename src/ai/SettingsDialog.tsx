import { useEffect, useState } from "react";
import { host } from "../core/host";
import type { KeyProvider } from "./keys";
import { DEFAULT_SETTINGS, PROVIDER_LABEL, type AiSettings, type Effort, type ProviderId } from "./providers";
import { useAssistant, type HostState } from "./store";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function KeyField({ provider, set, before }: { provider: KeyProvider; set: boolean; before?: () => Promise<void> }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try { await before?.(); useAssistant.setState({ host: await host.invoke<HostState>("sb:ai:setKey", { provider, key }) }); setKey(""); }
    catch (e) { setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
  };
  const clear = async () => useAssistant.setState({ host: await host.invoke<HostState>("sb:ai:clearKey", provider) });
  return (
    <>
      <div className="row">
        <span>API key: <b className={set ? "ai-pass" : "ai-na"}>{set ? "set" : "not set"}</b></span>
        <input type="password" autoComplete="off" placeholder={set ? "Paste a new key to replace it" : "Paste key"} value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${PROVIDER_LABEL[provider]} API key`} />
        <button className="btn" onClick={save} disabled={!key.trim()}>Save key</button>
        {set && <button className="btn" onClick={clear}>Remove</button>}
      </div>
      {err && <p className="error">{err}</p>}
    </>
  );
}

function ModelPicker({ provider, value, onChange }: { provider: "openai" | "compatible"; value: string; onChange: (v: string) => void }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = async () => {
    setErr(null);
    const r = await host.invoke<{ ok: boolean; models?: string[]; error?: string }>("sb:ai:listModels", provider);
    if (r.ok) setModels(r.models ?? []); else setErr(r.error ?? "Failed.");
  };
  return (
    <>
      <div className="row">
        <span>Model:</span>
        <input value={value} onChange={(e) => onChange(e.target.value)} list={`ai-models-${provider}`} placeholder="model id" aria-label="Model id" />
        <datalist id={`ai-models-${provider}`}>{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        <button className="btn" onClick={list} title="Save settings first if you changed the URL or key">List models</button>
      </div>
      {models && <p className="hint">{models.length ? `${models.length} models available; pick one from the field's suggestions.` : "The server listed no models."}</p>}
      {err && <p className="error">{err}</p>}
    </>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { host: hs, codex, refreshCodex } = useAssistant();
  const [s, setS] = useState<AiSettings>(hs?.settings ?? DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(true);
  useEffect(() => { void refreshCodex(); }, [refreshCodex]);
  const patch = (fn: (d: AiSettings) => void) => { const d = structuredClone(s); fn(d); setS(d); setSaved(false); };
  const save = async () => { useAssistant.setState({ host: await host.invoke<HostState>("sb:ai:saveSettings", s) }); setSaved(true); void refreshCodex(); };
  const keys = hs?.keys;
  const radio = (id: ProviderId, body: React.ReactNode) => (
    <label className={`radio ${s.provider === id ? "on" : ""}`}>
      <input type="radio" name="ai-provider" checked={s.provider === id} onChange={() => patch((d) => { d.provider = id; })} />
      <div style={{ flex: 1 }}><b>{PROVIDER_LABEL[id]}</b>{s.provider === id && <div>{body}</div>}</div>
    </label>
  );

  return (
    <div className="ai-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ai-modal narrow ai-settings" role="dialog" aria-label="Assistant settings">
        <header><h2>Assistant settings</h2><button className="btn" onClick={onClose}>Close</button></header>
        <div className="body">
          <p className="hint">API keys are encrypted with Windows' credential protection (DPAPI via Electron safeStorage) and stay in SparkBench's main process; this window only sees whether a key is set. Requests go straight from your computer to the provider you choose.</p>
          {hs && !hs.encryptionAvailable && <p className="error">Secure storage is unavailable on this system, so API keys cannot be saved. Local servers without keys and Codex still work.</p>}
          {radio("anthropic", <>
            <p className="hint">Needs an API key from console.anthropic.com. A Claude.ai subscription does not include API access; API use is billed separately.</p>
            <KeyField provider="anthropic" set={!!keys?.anthropic} />
            <div className="row"><span>Model:</span><input value={s.anthropic.model} onChange={(e) => patch((d) => { d.anthropic.model = e.target.value; })} aria-label="Claude model" /></div>
            <div className="row"><span>Effort:</span><select value={s.anthropic.effort} onChange={(e) => patch((d) => { d.anthropic.effort = e.target.value as Effort; })}>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select></div>
          </>)}
          {radio("openai", <>
            <p className="hint">Needs an API key from platform.openai.com. A ChatGPT Plus/Pro subscription does not include API access; API use is billed separately. To use your ChatGPT subscription, choose the Codex CLI option.</p>
            <KeyField provider="openai" set={!!keys?.openai} />
            <ModelPicker provider="openai" value={s.openai.model} onChange={(v) => patch((d) => { d.openai.model = v; })} />
          </>)}
          {radio("compatible", <>
            <p className="hint">Any server with the OpenAI Chat Completions API and JSON-schema output, e.g. LM Studio (http://localhost:1234/v1), Ollama (http://localhost:11434/v1), vLLM or llama.cpp. Small local models often fail the proposal format; SparkBench shows that as an error rather than guessing.</p>
            <div className="row"><span>Base URL:</span><input value={s.compatible.baseUrl} onChange={(e) => patch((d) => { d.compatible.baseUrl = e.target.value; })} aria-label="Base URL" /></div>
            <ModelPicker provider="compatible" value={s.compatible.model} onChange={(v) => patch((d) => { d.compatible.model = v; })} />
            <KeyField provider="compatible" set={!!keys?.compatible} before={saved ? undefined : save} />
            <p className="hint">Optional key; it is tied to this base URL and removed if you change the URL.</p>
          </>)}
          {radio("codex", <>
            <p className="hint">Runs OpenAI's Codex CLI on this computer in its documented non-interactive mode (<code>codex exec</code>) with your existing <code>codex login</code>. With “Sign in with ChatGPT”, requests count toward your ChatGPT plan's Codex usage limits; no API key is involved. This is not API access: Codex is an agent, and SparkBench runs it in a read-only sandbox in an empty temporary folder, without your Codex config file, and takes only its schema-checked final answer. OpenAI's docs describe ChatGPT-managed auth as an option for trusted machines; your own PC is one.</p>
            <div className="row">
              <span>Status:</span>
              {!codex ? <span className="ai-na">checking…</span> : codex.found
                ? <span className={codex.chatgpt ? "ai-pass" : "warn"}>{codex.version} · {codex.login || "login status unknown"}</span>
                : <span className="error">{codex.message}</span>}
              <button className="btn" onClick={() => refreshCodex()}>Recheck</button>
            </div>
            {codex?.found && !codex.chatgpt && <p className="warn">Codex is not signed in with ChatGPT{codex.apiKey ? " (it uses an API key, which is billed as API usage)" : ""}. Run <code>codex login</code> in a terminal to sign in.</p>}
            <div className="row"><span>Codex path:</span><input value={s.codex.path} placeholder={codex?.found ? codex.path : "auto-detect"} onChange={(e) => patch((d) => { d.codex.path = e.target.value; })} aria-label="Codex path" /></div>
            <div className="row"><span>Model:</span><input value={s.codex.model} placeholder="Codex default for your account" onChange={(e) => patch((d) => { d.codex.model = e.target.value; })} aria-label="Codex model" /></div>
            <div className="row"><span>Timeout (s):</span><input type="number" min={30} value={s.codex.timeoutSec} onChange={(e) => patch((d) => { d.codex.timeoutSec = Number(e.target.value) || 300; })} aria-label="Codex timeout" /></div>
          </>)}
        </div>
        <footer>
          <span className="hint">{saved ? "Saved." : "Unsaved changes."}</span>
          <span className="grow" style={{ flex: 1 }} />
          <button className="btn primary" onClick={save} disabled={saved}>Save settings</button>
        </footer>
      </div>
    </div>
  );
}
