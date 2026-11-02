// Renderer side of the launcher IPC (electron/ipc/updates.ts, electron/ipc/feedback.ts). Every call has a
// browser fallback so `npm run dev:web` still works without Electron.
import { version as PACKAGE_VERSION } from "../../package.json";
import { host } from "../core/host";
import { DONATE_URL } from "./config";
import type { NotesResult } from "./notes";
import type { SubmitResult } from "./feedbackQueue";
import type { FeedbackPayload } from "./feedback";
import { initialUpdateState, type UpdateState } from "./updateState";

export interface AppInfo { version: string; electron: string; chrome: string; os: string; packaged: boolean; portable: boolean }
export interface LauncherSettings { beta: boolean; skipOnStartup: boolean; lastSeenVersion?: string; recent: { path: string; name: string; openedAt: string }[] }

const BROWSER_VERSION = PACKAGE_VERSION;

export const launcherApi = {
  info: (): Promise<AppInfo> => host.available ? host.invoke<AppInfo>("sb:launcher:info")
    : Promise.resolve({ version: BROWSER_VERSION, electron: "-", chrome: navigator.userAgent, os: navigator.platform, packaged: false, portable: false }),
  settings: (): Promise<LauncherSettings> => host.available ? host.invoke<LauncherSettings>("sb:launcher:settings")
    : Promise.resolve({ beta: true, skipOnStartup: true, recent: [] }),
  setSettings: (patch: Partial<LauncherSettings>): Promise<LauncherSettings> => host.invoke<LauncherSettings>("sb:launcher:setSettings", patch),
  addRecent: (p: string) => host.invoke<LauncherSettings["recent"]>("sb:launcher:addRecent", p),
  removeRecent: (p: string) => host.invoke<LauncherSettings["recent"]>("sb:launcher:removeRecent", p),
  /** https links open in the system browser. */
  openExternal: (url: string) => {
    if (!/^https:\/\//i.test(url)) return;
    if (host.available) void host.invoke("sb:launcher:openExternal", url);
    else window.open(url, "_blank", "noopener");
  },
  donate: () => launcherApi.openExternal(DONATE_URL),

  updateState: (): Promise<UpdateState> => host.available ? host.invoke<UpdateState>("sb:updates:state")
    : Promise.resolve({ ...initialUpdateState(BROWSER_VERSION), phase: "disabled", message: "Updates need the desktop app." }),
  onUpdate: (cb: (s: UpdateState) => void) => host.on("sb:updates:changed", (s) => cb(s as UpdateState)),
  check: () => host.invoke<UpdateState>("sb:updates:check"),
  download: () => host.invoke<UpdateState>("sb:updates:download"),
  install: () => host.invoke<boolean>("sb:updates:install"),
  openReleases: () => host.invoke("sb:updates:openReleases"),
  notes: (): Promise<NotesResult> => host.available ? host.invoke<NotesResult>("sb:updates:notes")
    : Promise.resolve({ source: "bundled", releases: [], error: "Release notes from GitHub need the desktop app." }),

  feedbackStatus: (): Promise<{ relay: boolean; queued: number }> => host.available ? host.invoke("sb:feedback:status") : Promise.resolve({ relay: false, queued: 0 }),
  submitFeedback: (p: FeedbackPayload) => host.invoke<SubmitResult>("sb:feedback:submit", p),
  retryFeedback: () => host.invoke<{ queued: number }>("sb:feedback:retry"),
  onFeedbackDelivered: (cb: (r: { sent: { id: string; issueUrl?: string }[]; remaining: number }) => void) =>
    host.on("sb:feedback:delivered", (r) => cb(r as { sent: { id: string; issueUrl?: string }[]; remaining: number })),
  openIssue: async (url: string): Promise<boolean> => {
    if (host.available) return host.invoke<boolean>("sb:feedback:openIssue", url);
    return !!window.open(url, "_blank", "noopener") || true;
  },
};
