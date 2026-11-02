// Feedback / bug report form. Sends through the relay when one is configured (queued offline), otherwise opens a
// prefilled GitHub issue in the browser. Diagnostics and the project are only included when ticked.
import { useEffect, useState } from "react";
import { useApp } from "../app/store";
import { serializeProject } from "../core/project";
import { useProject } from "../core/store";
import { useSim } from "../sim/store";
import type { AppInfo } from "./api";
import { launcherApi } from "./api";
import { REPO_URL } from "./config";
import { buildIssueUrl, buildPayload, LIMITS, type FeedbackContext, type FeedbackForm as Form, type FeedbackKind } from "./feedback";

type Outcome =
  | { kind: "sent"; issueUrl?: string }
  | { kind: "queued"; error: string }
  | { kind: "browser" }
  | { kind: "failed"; error: string; fallbackUrl?: string };

/** What the app knows right now (only the ticked parts end up in the report). */
function context(info: AppInfo | null): FeedbackContext {
  const sim = useSim.getState();
  const diag = [...useApp.getState().projectDiagnostics, ...sim.blocked, ...(sim.result?.diagnostics ?? [])];
  const { project } = useProject.getState();
  return {
    appVersion: info?.version ?? "unknown",
    os: info?.os ?? navigator.platform,
    electron: info?.electron ?? "-",
    diagnostics: diag.map((d) => `${d.severity}: ${d.message}${d.fix ? ` (fix: ${d.fix})` : ""}`),
    simLog: sim.result?.log ?? [],
    project: serializeProject(project),
    projectName: project.meta.name,
  };
}

const EMPTY: Form = { kind: "bug", title: "", description: "", email: "", includeDiagnostics: true, attachProject: false, website: "" };

export function FeedbackForm({ info }: { info: AppInfo | null }) {
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [status, setStatus] = useState<{ relay: boolean; queued: number } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    launcherApi.feedbackStatus().then(setStatus, () => setStatus({ relay: false, queued: 0 }));
    return launcherApi.onFeedbackDelivered((r) => setStatus((s) => s && { ...s, queued: r.remaining }));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = buildPayload(f, context(info));
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors([]); setBusy(true);
    const fallbackUrl = buildIssueUrl(r.payload);
    try {
      if (status?.relay) {
        const res = await launcherApi.submitFeedback(r.payload);
        if (res.status === "sent") { setOutcome({ kind: "sent", issueUrl: res.issueUrl }); setF(EMPTY); }
        else if (res.status === "queued") { setOutcome({ kind: "queued", error: res.error }); setF(EMPTY); setStatus((s) => s && { ...s, queued: s.queued + 1 }); }
        else setOutcome({ kind: "failed", error: res.error, fallbackUrl });
      } else {
        const ok = await launcherApi.openIssue(fallbackUrl);
        setOutcome(ok ? { kind: "browser" } : { kind: "failed", error: "The browser couldn't be opened." });
      }
    } catch (err) {
      setOutcome({ kind: "failed", error: (err as Error)?.message ?? String(err), fallbackUrl });
    } finally { setBusy(false); }
  };

  return (
    <form className="feedback" onSubmit={submit} noValidate>
      <p className="dim">
        Found a bug or have an idea? Reports become issues on <a href={REPO_URL} onClick={(e) => { e.preventDefault(); launcherApi.openExternal(REPO_URL); }}>SparkBench's GitHub</a>, where they're public.
        {status && !status.relay && " Sending opens GitHub in your browser with the report filled in; sign in and press “Submit new issue”."}
      </p>
      <div className="seg" role="radiogroup" aria-label="Kind">
        {(["bug", "idea", "other"] as FeedbackKind[]).map((k) => (
          <button type="button" key={k} role="radio" aria-checked={f.kind === k} className={f.kind === k ? "on" : ""} onClick={() => set("kind", k)}>
            {k === "bug" ? "🐞 Bug" : k === "idea" ? "💡 Idea" : "💬 Other"}
          </button>
        ))}
      </div>
      <label>Title
        <input value={f.title} maxLength={LIMITS.titleMax} onChange={(e) => set("title", e.target.value)} placeholder={f.kind === "bug" ? "e.g. Scope stops updating in live mode" : "A short summary"} />
      </label>
      <label>Description
        <textarea value={f.description} maxLength={LIMITS.descriptionMax} rows={6} onChange={(e) => set("description", e.target.value)}
          placeholder={f.kind === "bug" ? "What did you do, what did you expect, and what happened instead?" : "Tell us more"} />
      </label>
      {status?.relay && (
        <label>Email <span className="dim">(optional, so we can reply; it appears in the public issue)</span>
          <input type="email" value={f.email} maxLength={LIMITS.emailMax} onChange={(e) => set("email", e.target.value)} />
        </label>
      )}
      {/* Honeypot: hidden from people and screen readers; bots that fill every field get dropped by the relay. */}
      <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={f.website} onChange={(e) => set("website", e.target.value)} />
      <label className="launcher-check">
        <input type="checkbox" checked={f.includeDiagnostics} onChange={(e) => set("includeDiagnostics", e.target.checked)} />
        <span>Include diagnostics <span className="dim">(app version, OS, Electron version, current problems and the recent simulation log)</span></span>
      </label>
      <label className="launcher-check">
        <input type="checkbox" checked={f.attachProject} onChange={(e) => set("attachProject", e.target.checked)} />
        <span>Attach my current project <span className="dim">({status?.relay ? "its contents become part of the public issue" : "you'll be asked to drag the .sbproj file into the issue"})</span></span>
      </label>
      {errors.length > 0 && <ul className="launcher-error">{errors.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="update-actions">
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Sending…" : status?.relay ? "Send report" : "Continue on GitHub"}</button>
        {status && status.queued > 0 && (
          <button type="button" className="btn" onClick={async () => setStatus({ ...status, queued: (await launcherApi.retryFeedback()).queued })}>
            Retry {status.queued} waiting report{status.queued > 1 ? "s" : ""}
          </button>
        )}
      </div>
      {outcome && <OutcomeLine o={outcome} />}
    </form>
  );
}

function OutcomeLine({ o }: { o: Outcome }) {
  switch (o.kind) {
    case "sent":
      return <div className="launcher-ok">✓ Thanks! Your report was filed{o.issueUrl && <> as <a href={o.issueUrl} onClick={(e) => { e.preventDefault(); launcherApi.openExternal(o.issueUrl!); }}>a GitHub issue</a></>}.</div>;
    case "queued":
      return <div className="launcher-ok">Saved on this computer. It couldn't be delivered yet ({o.error.replace(/\.$/, "")}), so SparkBench will send it automatically later.</div>;
    case "browser":
      return <div className="launcher-ok">✓ GitHub opened in your browser with the report filled in. Sign in if asked, then press “Submit new issue”.</div>;
    case "failed":
      return (
        <div className="launcher-error">
          Couldn't send the report: {o.error}
          {o.fallbackUrl && <> <button type="button" className="btn" onClick={() => launcherApi.openIssue(o.fallbackUrl!)}>Open it on GitHub instead</button></>}
        </div>
      );
  }
}
