// Right-side "Assistant" panel: chat, quick actions, settings and the proposal review.
import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABEL } from "./providers";
import { ReviewDialog } from "./ReviewDialog";
import { SettingsDialog } from "./SettingsDialog";
import { useAssistant, type ChatEntry } from "./store";
import "./assistant.css";

function providerReady(h: ReturnType<typeof useAssistant.getState>["host"]): string | null {
  if (!h?.settings.provider) return "Choose an AI provider to start.";
  const s = h.settings;
  if (s.provider === "anthropic" && !h.keys.anthropic) return "Add your Anthropic API key.";
  if (s.provider === "openai" && (!h.keys.openai || !s.openai.model)) return "Add your OpenAI API key and choose a model.";
  if (s.provider === "compatible" && !s.compatible.model) return "Choose a model for your local server.";
  return null;
}

function Entry({ e, onPick }: { e: ChatEntry; onPick: (text: string) => void }) {
  const { openReview, retry, askToFix, busy } = useAssistant();
  const [raw, setRaw] = useState(false);
  const r = e.response;
  const last = useAssistant((s) => s.chat[s.chat.length - 1]?.id === e.id);
  return (
    <div className={`ai-msg ${e.role}`}>
      {e.text}
      {r?.questions.map((q, i) => (
        <div key={i} className="ai-q">
          {q.question}
          {q.why && <small>{q.why}</small>}
          {q.options.length > 0 && <div className="ai-chips">{q.options.map((o) => <button key={o} onClick={() => onPick(`${q.question} ${o}`)}>{o}</button>)}</div>}
        </div>
      ))}
      {r?.proposal && !e.rejected && (
        <div className="ai-chips"><button onClick={() => openReview(e.id)}>Review proposal: {r.proposal.title}</button></div>
      )}
      {e.diagnostics && e.diagnostics.length > 0 && <ul className="ai-diags">{e.diagnostics.map((d, i) => <li key={i} className={d.severity === "error" ? "error" : "warn"}>{d.message}</li>)}</ul>}
      {e.role === "error" && last && (
        <div className="ai-chips">
          {e.retry && <button onClick={() => retry()} disabled={busy}>Retry</button>}
          {e.diagnostics?.some((d) => d.severity === "error" && d.code.startsWith("ai-") && d.code !== "ai-invalid-json" && d.code !== "ai-schema") &&
            <button onClick={() => askToFix(e.diagnostics!)} disabled={busy}>Ask the assistant to fix these</button>}
          {e.raw && <button onClick={() => setRaw(!raw)}>{raw ? "Hide" : "Show"} raw output</button>}
        </div>
      )}
      {raw && e.raw && <div className="ai-raw">{e.raw}</div>}
      {e.meta && <span className="meta">{e.meta}</span>}
    </div>
  );
}

export function AssistantPanel() {
  const { host: hs, hostError, chat, busy, review, refresh, send, cancel, clearChat } = useAssistant();
  const [text, setText] = useState("");
  const [settings, setSettings] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [chat.length, busy]);

  if (hostError) return <div className="ai ai-setup"><p>{hostError}</p></div>;
  const notReady = providerReady(hs);
  const submit = () => { if (!text.trim() || busy) return; void send("chat", text); setText(""); };

  return (
    <div className="ai">
      <div className="ai-head">
        <span className="grow" title={hs?.settings.provider ? PROVIDER_LABEL[hs.settings.provider] : ""}>{hs?.settings.provider ? PROVIDER_LABEL[hs.settings.provider] : "No provider"}</span>
        {chat.length > 0 && <button className="btn" onClick={clearChat} disabled={busy}>New chat</button>}
        <button className="btn" onClick={() => setSettings(true)}>Settings</button>
      </div>
      <div className="ai-log" ref={log} aria-live="polite">
        {notReady && (
          <div className="ai-msg">
            <b>Set up the assistant.</b> {notReady}
            <div className="ai-chips"><button onClick={() => setSettings(true)}>Open Assistant settings</button></div>
            <span className="meta">Options: an Anthropic or OpenAI API key, a local OpenAI-compatible server (e.g. LM Studio), or the Codex CLI with your ChatGPT sign-in.</span>
          </div>
        )}
        {!notReady && chat.length === 0 && (
          <div className="ai-msg">
            Describe a circuit idea in plain words, e.g. “a 1 kHz low-pass filter for a 5 V signal” or “drive a red LED from 12 V”.
            I'll ask for missing requirements, then propose parts and connections from the SparkBench library. Nothing changes until you review and apply it.
          </div>
        )}
        {chat.map((e) => <Entry key={e.id} e={e} onPick={(t) => { void send("chat", t); }} />)}
        {busy && <div className="ai-msg">Thinking… <button className="btn" onClick={cancel}>Cancel</button></div>}
      </div>
      <div className="ai-actions">
        <button className="btn" disabled={busy || !!notReady} onClick={() => send("diagnose", text).then(() => setText(""))} title="Send the current circuit and its diagnostics">Diagnose</button>
        <button className="btn" disabled={busy || !!notReady} onClick={() => send("tests", text).then(() => setText(""))} title="Ask for simulations that test the current circuit">Suggest tests</button>
        <button className="btn" disabled={busy || !!notReady} onClick={() => send("kicad", text).then(() => setText(""))} title="Ask for footprint choices for a KiCad PCB">Prepare for KiCad</button>
      </div>
      <div className="ai-input">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={notReady ? "Set up a provider first" : "Describe your circuit idea…"} disabled={!!notReady}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Message to the assistant" />
        <button className="btn primary" onClick={submit} disabled={busy || !text.trim() || !!notReady}>Send</button>
      </div>
      {settings && <SettingsDialog onClose={() => { setSettings(false); void refresh(); }} />}
      {review && <ReviewDialog />}
    </div>
  );
}
