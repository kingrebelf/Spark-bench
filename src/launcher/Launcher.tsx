// Start screen: version, update status, Launch, recent projects, and the What's new / Feedback / Support sections.
// It never blocks the app: every network-backed part degrades to a message, and Launch always works.
import { useEffect, useMemo, useState } from "react";
import changelog from "../../CHANGELOG.md?raw";
import logo from "../../build/icon.png";
import { openProject, openProjectText, newProject, saveProject } from "../app/fileActions";
import { host } from "../core/host";
import { useProject } from "../core/store";
import { launcherApi, type AppInfo, type LauncherSettings } from "./api";
import { DONATE_URL, RELEASES_URL } from "./config";
import { FeedbackForm } from "./FeedbackForm";
import { Markdown } from "./MarkdownView";
import { compareVersions, newSince, parseChangelog, type NotesResult } from "./notes";
import { formatBytes, type UpdateState } from "./updateState";
import "./launcher.css";

export type LauncherTab = "notes" | "feedback" | "support";

interface Props {
  info: AppInfo | null;
  settings: LauncherSettings | null;
  update: UpdateState | null;
  /** Version the user ran before this session (captured before it was updated), for "new" badges. */
  previousVersion?: string;
  tab: LauncherTab;
  setTab: (t: LauncherTab) => void;
  onSettings: (s: LauncherSettings) => void;
  onClose: () => void;
}

export function Launcher({ info, settings, update, previousVersion, tab, setTab, onSettings, onClose }: Props) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const setSetting = async (patch: Partial<LauncherSettings>) => {
    if (!settings) return;
    onSettings({ ...settings, ...patch });
    if (host.available) onSettings(await launcherApi.setSettings(patch));
  };

  return (
    <div className="launcher" role="dialog" aria-modal="true" aria-label="SparkBench start screen">
      <div className="launcher-card">
        <aside className="launcher-side">
          <div className="launcher-brand">
            <img src={logo} alt="" width={64} height={64} />
            <div>
              <h1>SparkBench</h1>
              <div className="launcher-version">
                Version {info?.version ?? "…"}{info?.portable ? " · portable" : ""}{settings?.beta ? " · beta channel" : ""}
              </div>
            </div>
          </div>

          <UpdateCard update={update} beta={settings?.beta ?? true} onBeta={(beta) => setSetting({ beta })} onNotes={() => setTab("notes")} />

          <button className="launcher-launch" onClick={onClose} autoFocus>Launch SparkBench</button>
          {host.available && (
            <label className="launcher-check">
              <input type="checkbox" checked={!!settings?.skipOnStartup} onChange={(e) => setSetting({ skipOnStartup: e.target.checked })} />
              Skip this screen on startup <span className="dim">(open it again with “Updates &amp; info”)</span>
            </label>
          )}

          <RecentProjects settings={settings} onSettings={onSettings} onOpened={onClose} />
        </aside>

        <section className="launcher-main">
          <nav className="launcher-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "notes"} className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>What's new</button>
            <button role="tab" aria-selected={tab === "feedback"} className={tab === "feedback" ? "on" : ""} onClick={() => setTab("feedback")}>Feedback &amp; bugs</button>
            <button role="tab" aria-selected={tab === "support"} className={tab === "support" ? "on" : ""} onClick={() => setTab("support")}>♥ Support</button>
            <span className="grow" />
            <button className="launcher-x" onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
          </nav>
          <div className="launcher-body">
            {tab === "notes" && <PatchNotes current={info?.version} previous={previousVersion} latest={update?.version} />}
            {tab === "feedback" && <FeedbackForm info={info} />}
            {tab === "support" && <Support />}
          </div>
        </section>
      </div>
    </div>
  );
}

function UpdateCard({ update, beta, onBeta, onNotes }: { update: UpdateState | null; beta: boolean; onBeta: (b: boolean) => void; onNotes: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => async () => { setBusy(true); try { await fn(); } catch { /* state events carry the error */ } finally { setBusy(false); } };
  const restart = async () => {
    if (useProject.getState().dirty) {
      const save = window.confirm("You have unsaved changes. Save them before restarting to update?\n\nOK saves first; Cancel keeps the update for later.");
      if (!save || !(await saveProject())) return;
    }
    await launcherApi.install();
  };
  if (!update) return <div className="update-card"><span className="spinner" /> Checking for updates…</div>;
  const checked = update.checkedAt ? ` · checked ${new Date(update.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  let body: React.ReactNode;
  switch (update.phase) {
    case "disabled":
      body = <><div className="update-line">Updates are off</div><div className="dim">{update.message}</div></>;
      break;
    case "idle":
    case "checking":
      body = <div className="update-line"><span className="spinner" /> Checking for updates…</div>;
      break;
    case "none":
      body = <>
        <div className="update-line ok">✓ You're up to date</div>
        <div className="dim">v{update.currentVersion}{checked}</div>
        <div className="update-actions"><button className="btn" disabled={busy} onClick={act(launcherApi.check)}>Check again</button></div>
      </>;
      break;
    case "available":
      body = <>
        <div className="update-line accent">Version {update.version} is available{update.sizeBytes ? ` · ${formatBytes(update.sizeBytes)}` : ""}</div>
        {update.portable && <div className="dim">The portable version can't update itself. Download the new one and replace this file.</div>}
        <div className="update-actions">
          <button className="btn primary" disabled={busy} onClick={act(launcherApi.download)}>{update.portable ? "Download the new version" : "Download update"}</button>
          <button className="btn" onClick={onNotes}>What's new?</button>
        </div>
      </>;
      break;
    case "downloading":
      body = <>
        <div className="update-line">Downloading {update.version}… {Math.floor(update.percent ?? 0)}%</div>
        <div className="progress"><div style={{ width: `${Math.max(2, update.percent ?? 0)}%` }} /></div>
        <div className="dim">{formatBytes(update.transferred)} of {formatBytes(update.total ?? update.sizeBytes)}{update.bytesPerSecond ? ` · ${formatBytes(update.bytesPerSecond)}/s` : ""} · you can keep working</div>
      </>;
      break;
    case "ready":
      body = <>
        <div className="update-line ok">Version {update.version} is ready</div>
        <div className="dim">It installs when you restart (or when you close SparkBench).</div>
        <div className="update-actions"><button className="btn primary" onClick={restart}>Restart &amp; update</button></div>
      </>;
      break;
    case "error":
      body = <>
        <div className={`update-line ${update.offline ? "" : "warn"}`}>{update.offline ? "Offline" : "Couldn't update"}</div>
        <div className="dim">{update.message}</div>
        <div className="update-actions">
          {update.version && !update.portable
            ? <button className="btn primary" disabled={busy} onClick={act(launcherApi.download)}>Retry download</button>
            : <button className="btn" disabled={busy} onClick={act(launcherApi.check)}>Try again</button>}
          {!update.offline && <button className="btn" onClick={() => launcherApi.openExternal(RELEASES_URL)}>Releases page</button>}
        </div>
      </>;
      break;
  }
  return (
    <div className="update-card" aria-live="polite">
      {body}
      {update.phase !== "disabled" && (
        <label className="launcher-check small">
          <input type="checkbox" checked={beta} onChange={(e) => onBeta(e.target.checked)} />
          Include pre-releases (beta channel)
        </label>
      )}
    </div>
  );
}

function RecentProjects({ settings, onSettings, onOpened }: { settings: LauncherSettings | null; onSettings: (s: LauncherSettings) => void; onOpened: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  if (!host.available) return null;
  const recent = settings?.recent ?? [];
  const open = async (p: string) => {
    setErr(null);
    if (useProject.getState().dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
    try {
      const r = await host.invoke<{ path: string; text: string }>("sb:file:read", p);
      if (await openProjectText(r.text, r.path)) onOpened();
    } catch {
      setErr(`Couldn't open ${p}. It may have been moved or deleted, so it was removed from the list.`);
      if (settings) onSettings({ ...settings, recent: await launcherApi.removeRecent(p) });
    }
  };
  // Close the launcher only if a project was actually opened (the user can cancel either dialog).
  const changed = async (fn: () => Promise<unknown>) => { const before = useProject.getState().project; await fn(); if (useProject.getState().project !== before) onOpened(); };
  return (
    <div className="launcher-recent">
      <h3>Recent projects</h3>
      {recent.length === 0 && <div className="dim">Projects you open or save show up here.</div>}
      {recent.map((r) => (
        <button key={r.path} className="recent-item" title={r.path} onClick={() => open(r.path)}>
          <span>{r.name}</span><span className="dim">{r.path}</span>
        </button>
      ))}
      {err && <div className="launcher-error">{err}</div>}
      <div className="update-actions">
        <button className="btn" onClick={() => changed(openProject)}>Open project…</button>
        <button className="btn" onClick={() => changed(newProject)}>New project</button>
      </div>
    </div>
  );
}

/** A date-only CHANGELOG date is a calendar day, not UTC midnight (which shows as the day before in the Americas). */
const showDate = (d: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d).toLocaleDateString();

function PatchNotes({ current, previous, latest }: { current?: string; previous?: string; latest?: string }) {
  const [notes, setNotes] = useState<NotesResult | null>(null);
  const bundled = useMemo(() => parseChangelog(changelog), []);
  useEffect(() => { let live = true; launcherApi.notes().then((n) => live && setNotes(n), (e) => live && setNotes({ source: "bundled", releases: [], error: String(e?.message ?? e) })); return () => { live = false; }; }, []);
  if (!notes) return <div className="dim"><span className="spinner" /> Loading release notes…</div>;
  const releases = notes.releases.length ? notes.releases : bundled;
  const source = notes.releases.length ? notes.source : "bundled";
  const fresh = current ? newSince(releases, previous, current) : new Set<string>();
  return (
    <div className="notes">
      <div className="notes-source dim">
        {source === "github" && "From GitHub releases."}
        {source === "cache" && `Saved copy from ${notes.fetchedAt ? new Date(notes.fetchedAt).toLocaleString() : "earlier"} (${notes.error ?? "GitHub unavailable"}).`}
        {source === "bundled" && `Notes included with this version${notes.error ? ` (${notes.error})` : ""}.`}
        {" "}<a href={RELEASES_URL} onClick={(e) => { e.preventDefault(); launcherApi.openExternal(RELEASES_URL); }}>All releases</a>
      </div>
      {releases.length === 0 && <div className="dim">No release notes yet.</div>}
      {releases.map((r) => {
        const upcoming = current && compareVersions(r.version, current) > 0;
        const isNew = fresh.has(r.version);
        return (
          <article key={r.version} className={`release ${isNew ? "is-new" : ""} ${upcoming ? "is-upcoming" : ""}`}>
            <header>
              <h2>{r.title}</h2>
              {r.prerelease && <span className="tag">pre-release</span>}
              {isNew && <span className="tag new">new since your last run</span>}
              {current && compareVersions(r.version, current) === 0 && <span className="tag">installed</span>}
              {upcoming && <span className="tag accent">{latest && compareVersions(latest, r.version) === 0 ? "update available" : "newer"}</span>}
              <span className="grow" />
              {r.date && <span className="dim">{showDate(r.date)}</span>}
              {r.url && <a href={r.url} onClick={(e) => { e.preventDefault(); launcherApi.openExternal(r.url!); }}>on GitHub</a>}
            </header>
            <Markdown source={r.body || "_No notes for this release._"} />
          </article>
        );
      })}
    </div>
  );
}

function Support() {
  return (
    <div className="support">
      <div className="support-heart" aria-hidden>♥</div>
      <h2>Support SparkBench</h2>
      <p>SparkBench is free; if it helps you, you can chip in any amount.</p>
      <p className="dim">Payments go through Stripe in your browser. You choose the amount; nothing is stored in SparkBench.</p>
      <button className="launcher-launch donate" onClick={() => launcherApi.openExternal(DONATE_URL)}>Donate any amount</button>
      <p className="dim">Other ways to help: report bugs, suggest ideas, or star the project on GitHub.</p>
    </div>
  );
}
