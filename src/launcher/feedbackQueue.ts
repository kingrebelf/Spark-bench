// Offline queue for relay reports: a report that can't be delivered (offline, relay down, rate limited) is kept
// on disk and retried with backoff. Pure apart from the injected storage, sender and clock.
import type { FeedbackPayload } from "./feedback";

export interface QueueItem {
  id: string;
  payload: FeedbackPayload;
  queuedAt: string;
  attempts: number;
  /** Epoch ms of the next try. */
  nextAt: number;
  lastError?: string;
}

/** ok: delivered. retry: worth trying again later (network, 429, 5xx). Otherwise the relay refused it for good. */
export type SendResult = { ok: true; issueUrl?: string } | { ok: false; retry: boolean; error: string };

export type SubmitResult =
  | { status: "sent"; issueUrl?: string }
  | { status: "queued"; error: string }
  | { status: "rejected"; error: string };

export interface QueueStore { load(): Promise<QueueItem[]>; save(items: QueueItem[]): Promise<void> }

export const QUEUE_MAX = 25;
export const MAX_ATTEMPTS = 30;
const BASE_DELAY = 60_000, MAX_DELAY = 6 * 3600_000;
export const backoff = (attempts: number) => Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.max(0, attempts - 1));

export class FeedbackQueue {
  private busy: Promise<unknown> = Promise.resolve();
  constructor(
    private store: QueueStore,
    private send: (p: FeedbackPayload) => Promise<SendResult>,
    private now: () => number = Date.now,
    private newId: () => string = () => Math.random().toString(36).slice(2, 10),
  ) {}

  /** One operation at a time, so a retry timer and a submit never write the file concurrently. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  async pending(): Promise<QueueItem[]> { return this.store.load(); }

  submit(payload: FeedbackPayload): Promise<SubmitResult> {
    return this.serial(async () => {
      const r = await safeSend(this.send, payload);
      if (r.ok) return { status: "sent", issueUrl: r.issueUrl };
      if (!r.retry) return { status: "rejected", error: r.error };
      const items = await this.store.load();
      items.push({ id: this.newId(), payload, queuedAt: new Date(this.now()).toISOString(), attempts: 1, nextAt: this.now() + backoff(1), lastError: r.error });
      await this.store.save(items.slice(-QUEUE_MAX));
      return { status: "queued", error: r.error };
    });
  }

  /** Try every item that is due (or all, when `force`). Returns what was delivered. */
  flush(force = false): Promise<{ sent: { id: string; issueUrl?: string }[]; dropped: string[]; remaining: number }> {
    return this.serial(async () => {
      const items = await this.store.load();
      const keep: QueueItem[] = [], sent: { id: string; issueUrl?: string }[] = [], dropped: string[] = [];
      let offline = false;
      for (const it of items) {
        if (offline || (!force && it.nextAt > this.now())) { keep.push(it); continue; }
        const r = await safeSend(this.send, it.payload);
        if (r.ok) { sent.push({ id: it.id, issueUrl: r.issueUrl }); continue; }
        const attempts = it.attempts + 1;
        if (!r.retry || attempts > MAX_ATTEMPTS) { dropped.push(it.id); continue; }
        keep.push({ ...it, attempts, nextAt: this.now() + backoff(attempts), lastError: r.error });
        // Still unreachable: don't hammer it with the rest of the queue now.
        offline = true;
      }
      if (sent.length || dropped.length || keep.some((k, i) => k !== items[i])) await this.store.save(keep);
      return { sent, dropped, remaining: keep.length };
    });
  }
}

async function safeSend(send: (p: FeedbackPayload) => Promise<SendResult>, p: FeedbackPayload): Promise<SendResult> {
  try { return await send(p); } catch (e) { return { ok: false, retry: true, error: (e as Error)?.message ?? String(e) }; }
}

/** Classify a relay HTTP response. */
export function classifyRelayResponse(status: number, body: unknown): SendResult {
  const b = (body && typeof body === "object" ? body : {}) as { issueUrl?: unknown; error?: unknown };
  if (status >= 200 && status < 300) return { ok: true, issueUrl: typeof b.issueUrl === "string" && b.issueUrl.startsWith("https://github.com/") ? b.issueUrl : undefined };
  const error = typeof b.error === "string" ? b.error.slice(0, 300) : `The feedback service answered ${status}.`;
  if (status === 429 || status === 408 || status >= 500) return { ok: false, retry: true, error };
  return { ok: false, retry: false, error };
}
