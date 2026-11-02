// Feedback / bug reports: the payload the app sends to the relay, and the prefilled GitHub "new issue" link used
// when no relay is configured. Pure, so the limits and opt-ins are unit-tested.
import { NEW_ISSUE_URL } from "./config";

export type FeedbackKind = "bug" | "idea" | "other";

export interface FeedbackForm {
  kind: FeedbackKind;
  title: string;
  description: string;
  email?: string;
  /** Opt-in: app version, OS, Electron version, current diagnostics and the recent simulation log. */
  includeDiagnostics: boolean;
  /** Opt-in: the open project file. */
  attachProject: boolean;
  /** Honeypot (hidden field). People leave it empty; the relay drops reports that fill it. */
  website?: string;
}

/** What the app knows when the form is sent. Only used when the matching opt-in is ticked. */
export interface FeedbackContext {
  appVersion: string;
  os: string;
  electron: string;
  diagnostics: string[];
  simLog: string[];
  /** Serialized project (.sbproj text). */
  project?: string;
  projectName?: string;
}

export interface FeedbackPayload {
  kind: FeedbackKind;
  title: string;
  description: string;
  email?: string;
  diagnostics?: { appVersion: string; os: string; electron: string; diagnostics: string[]; simLog: string };
  project?: { name: string; text: string };
  /** Set when the user asked to attach the project but it was too large. */
  projectOmitted?: string;
  website?: string;
}

export const LIMITS = {
  titleMin: 4, titleMax: 120,
  descriptionMin: 10, descriptionMax: 8000,
  emailMax: 200,
  diagnosticsMax: 40, diagnosticChars: 400,
  simLogLines: 150, simLogChars: 12000,
  /** GitHub issue bodies max out at 65536 characters; the relay puts the project in the body. */
  projectChars: 40000,
  /** Total JSON size accepted by the relay. */
  payloadBytes: 96 * 1024,
} as const;

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

export function validateForm(f: FeedbackForm): string[] {
  const errors: string[] = [];
  const title = f.title.trim(), desc = f.description.trim(), email = (f.email ?? "").trim();
  if (!["bug", "idea", "other"].includes(f.kind)) errors.push("Choose bug, idea or other.");
  if (title.length < LIMITS.titleMin) errors.push(`Give it a short title (at least ${LIMITS.titleMin} characters).`);
  if (title.length > LIMITS.titleMax) errors.push(`The title is too long (max ${LIMITS.titleMax} characters).`);
  if (desc.length < LIMITS.descriptionMin) errors.push(`Describe it in a sentence or two (at least ${LIMITS.descriptionMin} characters).`);
  if (desc.length > LIMITS.descriptionMax) errors.push(`The description is too long (max ${LIMITS.descriptionMax} characters).`);
  if (email && (email.length > LIMITS.emailMax || !EMAIL.test(email))) errors.push("That email address doesn't look right (or leave it empty).");
  return errors;
}

const tail = (lines: string[], n: number, chars: number) => {
  let out = lines.slice(-n).join("\n");
  if (out.length > chars) out = "…" + out.slice(out.length - chars + 1);
  return out;
};

export function buildPayload(f: FeedbackForm, ctx: FeedbackContext): { ok: true; payload: FeedbackPayload } | { ok: false; errors: string[] } {
  const errors = validateForm(f);
  if (errors.length) return { ok: false, errors };
  const p: FeedbackPayload = { kind: f.kind, title: f.title.trim(), description: f.description.trim() };
  const email = (f.email ?? "").trim();
  if (email) p.email = email;
  if (f.website) p.website = f.website;
  if (f.includeDiagnostics) {
    p.diagnostics = {
      appVersion: ctx.appVersion, os: ctx.os, electron: ctx.electron,
      diagnostics: ctx.diagnostics.slice(0, LIMITS.diagnosticsMax).map((d) => d.slice(0, LIMITS.diagnosticChars)),
      simLog: tail(ctx.simLog, LIMITS.simLogLines, LIMITS.simLogChars),
    };
  }
  if (f.attachProject && ctx.project !== undefined) {
    if (ctx.project.length <= LIMITS.projectChars) p.project = { name: ctx.projectName || "project", text: ctx.project };
    else p.projectOmitted = `The project is ${Math.round(ctx.project.length / 1024)} KB, too large to attach automatically (max ${Math.round(LIMITS.projectChars / 1024)} KB).`;
  }
  if (new TextEncoder().encode(JSON.stringify(p)).length > LIMITS.payloadBytes) {
    // Only the optional parts can make it this big; drop them before the user's words.
    if (p.project) { p.projectOmitted = "The project was too large to attach."; delete p.project; }
    if (p.diagnostics) p.diagnostics.simLog = tail(p.diagnostics.simLog.split("\n"), 30, 3000);
  }
  return { ok: true, payload: p };
}

export const labelsFor = (kind: FeedbackKind) => ["feedback", ...(kind === "other" ? [] : [kind]), "from-app"];

/** Keep `@name` from pinging GitHub users and `#123` from linking issues in reports. */
export const defang = (s: string) => s.replace(/@(?=[A-Za-z0-9-])/g, "@​").replace(/(^|\s)#(?=\d)/g, "$1#​");

/** Markdown issue body (browser fallback). The relay formats its own copy server-side. */
export function issueBody(p: FeedbackPayload, opts: { simLogLines?: number; maxDescription?: number } = {}): string {
  const parts: string[] = [];
  const desc = opts.maxDescription !== undefined && p.description.length > opts.maxDescription
    ? p.description.slice(0, opts.maxDescription) + "\n\n…(shortened to fit a link; add the rest here)"
    : p.description;
  parts.push(defang(desc));
  if (p.diagnostics) {
    const d = p.diagnostics;
    parts.push(`### Diagnostics\n- SparkBench ${d.appVersion}\n- ${d.os}\n- Electron ${d.electron}`);
    if (d.diagnostics.length) parts.push("Current problems:\n" + d.diagnostics.map((x) => `- ${defang(x)}`).join("\n"));
    const log = opts.simLogLines !== undefined ? d.simLog.split("\n").slice(-opts.simLogLines).join("\n") : d.simLog;
    if (opts.simLogLines !== 0 && log.trim()) parts.push("<details><summary>Recent simulation log</summary>\n\n```\n" + log.replace(/```/g, "ˋˋˋ") + "\n```\n</details>");
  }
  if (p.project || p.projectOmitted) parts.push(`### Project\n${p.projectOmitted ?? "Please drag your .sbproj file into this issue (it's too long for a link)."}`);
  parts.push(`---\nLabels: ${labelsFor(p.kind).join(", ")} · sent from the SparkBench app`);
  return parts.join("\n\n");
}

/** Windows hands long URLs to the browser intact well past this; GitHub itself rejects very long query strings. */
export const ISSUE_URL_MAX = 7000;

/**
 * Prefilled `issues/new` link. Email is left out (the reporter is signed in to GitHub, and issues are public).
 * When the link would be too long it drops, in order: the simulation log, then the end of the description.
 */
export function buildIssueUrl(p: FeedbackPayload, base = NEW_ISSUE_URL, max = ISSUE_URL_MAX): string {
  const prefix = p.kind === "bug" ? "Bug: " : p.kind === "idea" ? "Idea: " : "";
  const make = (body: string) => {
    const q = new URLSearchParams({ title: prefix + p.title, body, labels: labelsFor(p.kind).join(",") });
    return `${base}?${q.toString()}`;
  };
  const attempts: Parameters<typeof issueBody>[1][] = [{}, { simLogLines: 40 }, { simLogLines: 10 }, { simLogLines: 0 }];
  for (const o of attempts) { const u = make(issueBody(p, o)); if (u.length <= max) return u; }
  for (let keep = Math.min(p.description.length, 3000); keep >= 100; keep = Math.floor(keep * 0.7)) {
    const u = make(issueBody(p, { simLogLines: 0, maxDescription: keep }));
    if (u.length <= max) return u;
  }
  return make(issueBody({ ...p, diagnostics: undefined }, { maxDescription: 100 }));
}
