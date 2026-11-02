// Update status as the launcher shows it, derived from electron-updater events. Pure: no Electron imports,
// so it is unit-tested and shared by the main process (electron/ipc/updates.ts) and the renderer.

export type UpdatePhase =
  | "disabled"     // dev build, or updates impossible here
  | "idle"         // not checked yet
  | "checking"
  | "none"         // up to date
  | "available"    // a newer version exists (installer: can download; portable: open the release page)
  | "downloading"
  | "ready"        // downloaded; installs on restart
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  /** Newer version offered by the feed. */
  version?: string;
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
  /** Running the portable exe: it can't update itself, so the launcher links to the release page instead. */
  portable: boolean;
  /** Pre-releases are offered. */
  beta: boolean;
}

/** Events as forwarded from electron-updater (shapes trimmed to what we use). */
export type UpdateEvent =
  | { type: "checking" }
  | { type: "available"; version: string; files?: { size?: number }[] }
  | { type: "not-available"; version?: string }
  | { type: "progress"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: "downloaded"; version: string }
  | { type: "download-started" }
  | { type: "error"; message: string }
  | { type: "disabled"; message: string };

export const initialUpdateState = (currentVersion: string, opts: { portable?: boolean; beta?: boolean } = {}): UpdateState =>
  ({ phase: "idle", currentVersion, portable: !!opts.portable, beta: opts.beta ?? true });

export function updateReducer(s: UpdateState, e: UpdateEvent, now = new Date()): UpdateState {
  const base = { currentVersion: s.currentVersion, portable: s.portable, beta: s.beta, checkedAt: s.checkedAt };
  switch (e.type) {
    case "disabled":
      return { ...base, phase: "disabled", message: e.message };
    case "checking":
      // A check while a download is running or finished must not hide that state.
      if (s.phase === "downloading" || s.phase === "ready") return s;
      return { ...base, phase: "checking" };
    case "available":
      if (s.phase === "ready" && s.version === e.version) return s;
      return { ...base, phase: "available", version: e.version, sizeBytes: e.files?.[0]?.size, checkedAt: now.toISOString() };
    case "not-available":
      if (s.phase === "ready" || s.phase === "downloading") return s;
      return { ...base, phase: "none", checkedAt: now.toISOString() };
    case "download-started":
      return { ...s, phase: "downloading", percent: 0, message: undefined, offline: undefined };
    case "progress":
      return { ...s, phase: "downloading", percent: e.percent, transferred: e.transferred, total: e.total, bytesPerSecond: e.bytesPerSecond };
    case "downloaded":
      return { ...base, phase: "ready", version: e.version, sizeBytes: s.sizeBytes, percent: 100 };
    case "error": {
      const { message, offline } = explainUpdateError(e.message, s.beta);
      // A failed download keeps the offer so the user can retry.
      return { ...base, phase: "error", version: s.version, sizeBytes: s.sizeBytes, message, offline, checkedAt: now.toISOString() };
    }
  }
}

const OFFLINE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_PROXY|ERR_ADDRESS_UNREACHABLE|net::ERR_/i;

/** Turn an electron-updater error into one plain sentence. Raw messages are long stack-like dumps. */
export function explainUpdateError(raw: string, beta: boolean): { message: string; offline: boolean } {
  const m = raw || "";
  if (OFFLINE.test(m)) return { offline: true, message: "You're offline or GitHub can't be reached. SparkBench works normally; it will check again later." };
  if (/latest\.yml/i.test(m) && /404|Cannot find/i.test(m))
    return { offline: false, message: "The newest release on GitHub has no update information (latest.yml), so it can't be installed automatically. Download it from the releases page." };
  if (/No published versions|Unable to find latest version/i.test(m) || (/releases\/latest/.test(m) && /404/.test(m)))
    return { offline: false, message: beta ? "No releases are published on GitHub yet." : "No stable release is published yet. Turn on the beta channel to get pre-releases." };
  if (/app-update\.yml/i.test(m) && /ENOENT/.test(m))
    return { offline: false, message: "This build can't install updates itself (it has no update configuration). Download new versions from the releases page." };
  if (/\b(403|429)\b|rate limit/i.test(m)) return { offline: false, message: "GitHub is limiting requests right now. SparkBench will try again later." };
  if (/sha512 checksum mismatch/i.test(m)) return { offline: false, message: "The downloaded update didn't match its checksum and was discarded. Try again." };
  const first = m.split(/\r?\n/)[0].slice(0, 200);
  return { offline: false, message: `Update check failed: ${first || "unknown error"}` };
}

/** The portable build sets PORTABLE_EXECUTABLE_FILE (electron-builder's portable launcher). */
export const isPortable = (env: Record<string, string | undefined>) => !!env.PORTABLE_EXECUTABLE_FILE;

/** The installer build can download and install updates itself; the portable one can't. */
export const canSelfInstall = (s: UpdateState) => !s.portable && s.phase !== "disabled";

export function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
