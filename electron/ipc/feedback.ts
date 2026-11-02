// Feedback delivery: POST to the relay (which files a labeled GitHub issue), with an offline queue on disk.
// Without a relay the renderer opens a prefilled GitHub issue page instead (sb:feedback:openIssue).
import { app, BrowserWindow, ipcMain, net } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FEEDBACK_RELAY_URL, FEEDBACK_RETRY_INTERVAL_MS, NEW_ISSUE_URL } from "../../src/launcher/config";
import type { FeedbackPayload } from "../../src/launcher/feedback";
import { classifyRelayResponse, FeedbackQueue, type QueueItem, type SendResult } from "../../src/launcher/feedbackQueue";
import { openHttps } from "./updates";

const queueFile = () => path.join(app.getPath("userData"), "feedback-queue.json");

/** https only (http allowed for a relay on this machine while testing). */
export function relayUrl(): string {
  const raw = (process.env.SPARKBENCH_FEEDBACK_RELAY || FEEDBACK_RELAY_URL).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) return u.toString();
  } catch { /* fall through */ }
  return "";
}

async function send(p: FeedbackPayload): Promise<SendResult> {
  const url = relayUrl();
  if (!url) return { ok: false, retry: false, error: "No feedback service is configured." };
  let res: Response;
  try {
    res = await net.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `SparkBench/${app.getVersion()}` },
      body: JSON.stringify(p),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, retry: true, error: `Couldn't reach the feedback service (${(e as Error)?.message ?? e}).` };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return classifyRelayResponse(res.status, body);
}

const queue = new FeedbackQueue({
  load: async () => {
    try { const x = JSON.parse(await fs.readFile(queueFile(), "utf8")); return Array.isArray(x) ? (x as QueueItem[]) : []; }
    catch { return []; }
  },
  save: async (items) => {
    await fs.mkdir(path.dirname(queueFile()), { recursive: true });
    await fs.writeFile(queueFile() + ".tmp", JSON.stringify(items), "utf8");
    await fs.rename(queueFile() + ".tmp", queueFile());
  },
}, send);

async function flush(force = false) {
  if (!relayUrl()) return;
  const r = await queue.flush(force);
  if (r.sent.length || r.dropped.length)
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("sb:feedback:delivered", { ...r });
}

export function registerFeedbackIpc(): void {
  ipcMain.handle("sb:feedback:status", async () => ({ relay: !!relayUrl(), queued: (await queue.pending()).length }));
  ipcMain.handle("sb:feedback:submit", async (_e, p: FeedbackPayload) => {
    if (!relayUrl()) return { status: "rejected", error: "No feedback service is configured." };
    return queue.submit(p);
  });
  ipcMain.handle("sb:feedback:retry", async () => { await flush(true); return { queued: (await queue.pending()).length }; });
  ipcMain.handle("sb:feedback:openIssue", (_e, url: unknown) => {
    if (typeof url !== "string" || !url.startsWith(NEW_ISSUE_URL + "?")) return false;
    return openHttps(url);
  });
  app.whenReady().then(() => {
    setTimeout(() => void flush(), 8000);
    setInterval(() => void flush(), FEEDBACK_RETRY_INTERVAL_MS).unref?.();
  });
}
