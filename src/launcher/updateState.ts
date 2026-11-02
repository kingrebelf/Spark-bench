// Update status as the launcher shows it. Pure: no Electron imports, so it is unit-tested and shared by the main
// process (electron/ipc/updates.ts) and the renderer.
//
// A check first compares the running version with the newest GitHub release (decideUpdate). Only when that
// release is newer AND this copy can install updates itself (the installed build) does electron-updater run.
import { compareVersions } from "./notes";

export type UpdatePhase =
  | "disabled"     // dev run
  | "idle"         // not checked yet
  | "checking"
  | "none"         // up to date
  | "available"    // a newer version exists (self-installing: Download; `manual`: releases page)
  | "downloading"
  | "ready"        // downloaded; installs on restart
  | "error";

/** Why a newer version has to be downloaded by hand. */
export type ManualReason = "portable" | "not-installed" | "no-update-info";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  /** Newer version on offer. */
  version?: string;
  /** Newest release on GitHub (for "up to date (newest release: x)"). */
  latestVersion?: string;
  /** Set when the newer version can't be installed automatically here. */
  manual?: ManualReason;
  /** Installer download size in bytes. */
  sizeBytes?: number;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** Plain-language explanation for disabled/error phases. */
  message?: string;
  /** The error came from no connection (offline or GitHub unreachable). */
  offline?: boolean;
  /** ISO time of the last finished check. */
  checkedAt?: string;
  /** Running the portable exe. */
  portable: boolean;
  /** This copy can download and install updates itself (installed with the setup exe). */
  selfUpdate: boolean;
  /** Pre-releases are offered. */
  beta: boolean;
}

export type UpdateEvent =
  | { type: "checking" }
  /** Result of comparing with GitHub's releases: nothing newer. */
  | { type: "latest"; newest?: string }
  /** A newer release exists that this copy can't install itself. */
  | { type: "manual"; version: string; reason: ManualReason }
  | { type: "available"; version: string; files?: { size?: number }[] }
  | { type: "not-available"; version?: string }
  | { type: "progress"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: "downloaded"; version: string }
  | { type: "download-started" }
  | { type: "error"; message: string }
  | { type: "disabled"; message: string };

export const initialUpdateState = (currentVersion: string, opts: { portable?: boolean; beta?: boolean; selfUpdate?: boolean } = {}): UpdateState =>
  ({ phase: "idle", currentVersion, portable: !!opts.portable, selfUpdate: opts.selfUpdate ?? !opts.portable, beta: opts.beta ?? true });

/** Newest eligible release, and whether it is newer than the running version. Pre-releases count on the beta channel. */
export function decideUpdate(current: string, releases: { version: string; prerelease: boolean }[], beta: boolean): { newest?: string; newer?: string } {
  let newest: string | undefined;
  for (const r of releases) {
    if (r.prerelease && !beta) continue;
    if (!newest || compareVersions(r.version, newest) > 0) newest = r.version;
  }
  return { newest, newer: newest && compareVersions(newest, current) > 0 ? newest : undefined };
}

export function updateReducer(s: UpdateState, e: UpdateEvent, now = new Date()): UpdateState {
  const base = { currentVersion: s.currentVersion, portable: s.portable, selfUpdate: s.selfUpdate, beta: s.beta, checkedAt: s.checkedAt, latestVersion: s.latestVersion };
  const at = now.toISOString();
  switch (e.type) {
    case "disabled":
      return { ...base, phase: "disabled", message: e.message };
    case "checking":
      // A check while a download is running or finished must not hide that state.
      if (s.phase === "downloading" || s.phase === "ready") return s;
      return { ...base, phase: "checking" };
    case "latest":
      if (s.phase === "ready" || s.phase === "downloading") return s;
      return { ...base, phase: "none", latestVersion: e.newest, checkedAt: at };
    case "manual":
      return { ...base, phase: "available", version: e.version, latestVersion: e.version, manual: e.reason, checkedAt: at };
    case "available":
      if (s.phase === "ready" && s.version === e.version) return s;
      return { ...base, phase: "available", version: e.version, latestVersion: s.latestVersion ?? e.version, sizeBytes: e.files?.[0]?.size, checkedAt: at };
    case "not-available":
      if (s.phase === "ready" || s.phase === "downloading") return s;
      return { ...base, phase: "none", checkedAt: at };
    case "download-started":
      return { ...s, phase: "downloading", percent: 0, message: undefined, offline: undefined };
    case "progress":
      return { ...s, phase: "downloading", percent: e.percent, transferred: e.transferred, total: e.total, bytesPerSecond: e.bytesPerSecond };
    case "downloaded":
      return { ...base, phase: "ready", version: e.version, sizeBytes: s.sizeBytes, percent: 100 };
    case "error": {
      // A newer release without update info isn't an error for the user: offer it from the releases page.
      if (s.version && /latest\.yml/i.test(e.message) && /404|Cannot find/i.test(e.message))
        return { ...base, phase: "available", version: s.version, manual: "no-update-info", checkedAt: at };
      const { message, offline } = explainUpdateError(e.message, s.beta);
      // A failed download keeps the offer so the user can retry.
      return { ...base, phase: "error", version: s.version, sizeBytes: s.sizeBytes, message, offline, checkedAt: at };
    }
  }
}

/** One sentence for the launcher when a newer version must be downloaded by hand. */
export function manualText(s: UpdateState): string {
  switch (s.manual) {
    case "portable": return "The portable version can't update itself. Download the new one and replace this file.";
    case "not-installed": return "This copy isn't installed, so it can't update itself (automatic updates work in the installed version). Download it from the releases page.";
    case "no-update-info": return `A newer version (${s.version}) is available but can't be installed automatically. Download it from the releases page.`;
    default: return "";
  }
}

const OFFLINE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_PROXY|ERR_ADDRESS_UNREACHABLE|net::ERR_|fetch failed|timed? ?out|aborted/i;

/** Turn an error into one plain sentence. Raw messages (paths, stack-like dumps) are never shown. */
export function explainUpdateError(raw: string, beta: boolean): { message: string; offline: boolean } {
  const m = raw || "";
  if (OFFLINE.test(m)) return { offline: true, message: "You're offline or GitHub can't be reached. SparkBench works normally; it will check again later." };
  if (/latest\.yml/i.test(m) && /404|Cannot find/i.test(m))
    return { offline: false, message: "The newest release can't be installed automatically. Download it from the releases page." };
  if (/No published versions|Unable to find latest version/i.test(m) || (/releases\/latest/.test(m) && /404/.test(m)))
    return { offline: false, message: beta ? "No releases are published on GitHub yet." : "No stable release is published yet. Turn on the beta channel to get pre-releases." };
  if (/app-update\.yml/i.test(m))
    return { offline: false, message: "This copy can't install updates itself. Automatic updates work in the installed version." };
  if (/\b(403|429)\b|rate limit/i.test(m)) return { offline: false, message: "GitHub is limiting requests right now. SparkBench will try again later." };
  if (/sha512 checksum mismatch/i.test(m)) return { offline: false, message: "The downloaded update didn't match its checksum and was discarded. Try again." };
  return { offline: false, message: "Couldn't check for updates right now. SparkBench will try again later." };
}

/** The portable build sets PORTABLE_EXECUTABLE_FILE (electron-builder's portable launcher). */
export const isPortable = (env: Record<string, string | undefined>) => !!env.PORTABLE_EXECUTABLE_FILE;

export function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
