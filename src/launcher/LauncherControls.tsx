// Toolbar entry for the launcher ("Updates & info" and "♥ Donate") plus the start screen itself, shown on every
// start (it never blocks: Launch works at once). Also records opened/saved projects for the recent list.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { host } from "../core/host";
import { useProject } from "../core/store";
import { launcherApi, type AppInfo, type LauncherSettings } from "./api";
import { Launcher, type LauncherTab } from "./Launcher";
import type { UpdateState } from "./updateState";

/** Automated runs (Playwright capture and tests set navigator.webdriver) start in the editor; people always see it. */
const automated = () => typeof navigator !== "undefined" && navigator.webdriver;

export function LauncherControls() {
  // Open from the first frame, before info/settings arrive: Launch must never wait for anything.
  const [open, setOpen] = useState(() => host.available && !automated());
  const [tab, setTab] = useState<LauncherTab>("notes");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<LauncherSettings | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const previous = useRef<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    Promise.all([launcherApi.info(), launcherApi.settings()]).then(([i, s]) => {
      if (!live) return;
      previous.current = s.lastSeenVersion;
      setInfo(i); setSettings(s);
      if (host.available && s.lastSeenVersion !== i.version) launcherApi.setSettings({ lastSeenVersion: i.version }).catch(() => {});
    }).catch(() => {});
    launcherApi.updateState().then((u) => live && setUpdate(u), () => {});
    const off = launcherApi.onUpdate(setUpdate);
    return () => { live = false; off(); };
  }, []);

  // Recent projects: remember every real file the editor opens or saves.
  useEffect(() => {
    if (!host.available) return;
    let last = useProject.getState().filePath;
    return useProject.subscribe((s) => {
      if (s.filePath === last) return;
      last = s.filePath;
      if (s.filePath && /\.sbproj$/i.test(s.filePath)) launcherApi.addRecent(s.filePath).then((recent) => setSettings((x) => x && { ...x, recent }), () => {});
    });
  }, []);

  const close = useCallback(() => setOpen(false), []);
  const badge = update?.phase === "available" || update?.phase === "ready";

  return (
    <>
      <button className={`btn launcher-tb ${badge ? "has-update" : ""}`} onClick={() => { setTab("notes"); setOpen(true); }}
        title={badge ? `Version ${update?.version} is ${update?.phase === "ready" ? "ready to install" : "available"}` : "Updates, what's new, feedback and support"}>
        Updates &amp; info{badge && <span className="dot" aria-label="update available" />}
      </button>
      <button className="donate-btn" onClick={launcherApi.donate} title="Support SparkBench: opens a secure Stripe page in your browser">♥ Donate</button>
      {open && createPortal(
        <Launcher info={info} settings={settings} update={update} previousVersion={previous.current} tab={tab} setTab={setTab} onSettings={setSettings} onClose={close} />,
        document.body,
      )}
    </>
  );
}
