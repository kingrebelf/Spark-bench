// Assistant state: chat history, the proposal under review, and the validate/apply pipeline.
// The renderer never holds API keys; it asks the main process (sb:ai:*) to run completions.
import { create } from "zustand";
import { runChecks } from "../core/checks";
import { host } from "../core/host";
import { useProject } from "../core/store";
import type { Diagnostic, Project } from "../core/types";
import { useSim } from "../sim/store";
import { WorkerEngine } from "../sim/workerEngine";
import { computeDiff, type ProposalDiff } from "./diff";
import type { KeyStatus } from "./keys";
import { layoutProposal, type LayoutResult } from "./layout";
import { checkProposal, parseAiResponse, type AiResponse, type Proposal, type ProposalCheck } from "./proposal";
import { systemPrompt, userTurn, type AssistantAction } from "./prompt";
import type { AiError, AiSettings, ChatMessage, CompletionResult } from "./providers";
import { checkDesign, runSuggestedSimulation, stageOf, type SimulationCheck, type ValidationStage } from "./validate";

export interface HostState { settings: AiSettings; keys: KeyStatus; encryptionAvailable: boolean }
export type CodexStatus =
  | { found: false; message: string }
  | { found: true; path: string; version: string; login: string; chatgpt: boolean; apiKey: boolean };

export interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "error";
  /** What the user typed / the assistant's plain-language message / the error text. */
  text: string;
  /** user: full turn sent to the model (with circuit); assistant: raw JSON reply (sent back as history). */
  sent?: string;
  action?: AssistantAction;
  response?: AiResponse;
  diagnostics?: Diagnostic[];
  /** For errors: the request can be retried. */
  retry?: boolean;
  /** For errors: a one-click remedy reported by the main process. */
  fix?: AiError["fix"];
  /** Raw model output for "show raw output" on format errors. */
  raw?: string;
  meta?: string;
  /** assistant: its proposal failed validation (dropped from history on retry). */
  rejected?: boolean;
}

export interface Review {
  entryId: number;
  proposal: Proposal;
  base: Project;
  check: ProposalCheck;
  layout: LayoutResult;
  diff: ProposalDiff;
  checks: { ok: boolean; diagnostics: Diagnostic[] } | null;
  sims: SimulationCheck[];
  simRunning: boolean;
  /** Set when the user's circuit changed after the proposal was laid out. */
  rebased: boolean;
  footprints: Record<string, "found" | "missing" | "unknown">;
  applySimSettings: boolean;
}

interface AiState {
  host: HostState | null;
  hostError: string | null;
  codex: CodexStatus | null;
  chat: ChatEntry[];
  busy: boolean;
  review: Review | null;
  refresh: () => Promise<void>;
  refreshCodex: () => Promise<void>;
  send: (action: AssistantAction, text: string) => Promise<void>;
  retry: () => Promise<void>;
  /** Clear the Codex model setting (use the account's default) and retry. */
  resetCodexModel: () => Promise<void>;
  /** Send the validation errors of a rejected proposal back to the model. */
  askToFix: (diagnostics: Diagnostic[]) => Promise<void>;
  cancel: () => void;
  openReview: (entryId: number) => void;
  closeReview: () => void;
  simulateReview: () => Promise<void>;
  setApplySimSettings: (v: boolean) => void;
  apply: () => void;
  reject: (feedback?: string) => Promise<void>;
  clearChat: () => void;
}

let nextId = 1;
const engine = new WorkerEngine(); // separate worker: the user's own simulation and its Stop button are unaffected
const AUTO_SIM_MAX_PARTS = 30;

/** Conversation history in provider format: user turns and the assistant's own JSON replies. */
function history(chat: ChatEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of chat) {
    if (e.role === "user" && e.sent) out.push({ role: "user", content: e.sent });
    else if (e.role === "assistant" && e.sent) out.push({ role: "assistant", content: e.sent });
  }
  // Providers require alternating turns ending with the user: merge consecutive user turns.
  const merged: ChatMessage[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`; else merged.push({ ...m });
  }
  return merged;
}

function buildReview(entryId: number, proposal: Proposal, base: Project): { review?: Review; diagnostics: Diagnostic[] } {
  const check = checkProposal(proposal, base);
  if (!check.ok) return { diagnostics: check.diagnostics };
  const layout = layoutProposal(base, proposal, check.nets);
  if (!layout.ok) return { diagnostics: [...check.diagnostics, ...layout.diagnostics] };
  const names = new Map([...layout.netNames].map(([k, v]) => [v, k]));
  const diff = computeDiff(base, layout.project, undefined, names);
  return {
    diagnostics: check.diagnostics,
    review: {
      entryId, proposal, base, check, layout, diff, checks: null, sims: [], simRunning: false, rebased: false, footprints: {},
      applySimSettings: proposal.simulations.length > 0,
    },
  };
}

export function reviewStage(r: Review): ValidationStage {
  return r.checks ? stageOf(r.checks.ok, r.sims) : "unvalidated";
}

export const useAssistant = create<AiState>((set, get) => ({
  host: null,
  hostError: null,
  codex: null,
  chat: [],
  busy: false,
  review: null,

  refresh: async () => {
    if (!host.available) { set({ hostError: "The assistant runs in the SparkBench desktop app: API keys are kept and used only by its main process." }); return; }
    try { set({ host: await host.invoke<HostState>("sb:ai:getState"), hostError: null }); }
    catch (e) { set({ hostError: (e as Error).message }); }
  },
  refreshCodex: async () => {
    if (!host.available) return;
    set({ codex: await host.invoke<CodexStatus>("sb:ai:codexStatus") });
  },

  send: async (action, text) => {
    if (get().busy) return;
    const project = useProject.getState().project;
    const diagnostics = action === "diagnose" ? [...runChecks(project), ...(useSim.getState().result?.diagnostics ?? [])] : undefined;
    const sim = action === "diagnose" ? useSim.getState().result : undefined;
    const sent = userTurn(action, text.trim(), project, { diagnostics, sim });
    const label: Record<AssistantAction, string> = { chat: text.trim(), diagnose: "Diagnose my circuit", tests: "Suggest tests", kicad: "Prepare for KiCad" };
    const entry: ChatEntry = { id: nextId++, role: "user", text: text.trim() && action !== "chat" ? `${label[action]}: ${text.trim()}` : label[action], sent, action };
    set({ chat: [...get().chat, entry] });
    await run();
  },

  retry: async () => {
    if (get().busy) return;
    // Drop trailing error entries; resend the same history.
    const chat = [...get().chat];
    while (chat.length && chat[chat.length - 1].role === "error") chat.pop();
    if (chat.length && chat[chat.length - 1].rejected) chat.pop();
    set({ chat });
    await run();
  },

  resetCodexModel: async () => {
    const hs = get().host;
    if (!hs || get().busy) return;
    const settings = structuredClone(hs.settings);
    settings.codex.model = "";
    set({ host: await host.invoke<HostState>("sb:ai:saveSettings", settings) });
    await get().retry();
  },

  askToFix: async (diagnostics) => {
    const lines = diagnostics.filter((d) => d.severity === "error").map((d) => `- ${d.message}`).join("\n");
    await get().send("chat", `SparkBench rejected your last proposal:\n${lines}\nPlease send a corrected proposal.`);
  },

  cancel: () => { if (host.available) host.invoke("sb:ai:cancel"); },

  openReview: (entryId) => {
    const e = get().chat.find((x) => x.id === entryId);
    const p = e?.response?.proposal;
    if (!p) return;
    const { review, diagnostics } = buildReview(entryId, p, useProject.getState().project);
    if (!review) { pushError("The proposal no longer fits your current circuit.", diagnostics, false); return; }
    set({ review });
    void validate();
  },
  closeReview: () => set({ review: null }),

  simulateReview: async () => {
    const r = get().review;
    if (!r || r.simRunning || !r.proposal.simulations.length) return;
    set({ review: { ...r, simRunning: true } });
    const sims: SimulationCheck[] = [];
    for (const s of r.proposal.simulations) {
      try { sims.push(await runSuggestedSimulation(r.layout.project, s, r.layout.netNames, engine)); }
      catch (e) {
        sims.push({ simulation: s, matches: false, expectations: [], result: { ok: false, analysis: s.analysis, vectors: [], netlist: "", log: [], elapsedMs: 0,
          diagnostics: [{ severity: "error", code: "engine-crash", source: "spice", message: `The simulation engine stopped: ${(e as Error).message}` }] } });
      }
    }
    const cur = get().review;
    if (cur && cur.entryId === r.entryId) set({ review: { ...cur, sims, simRunning: false } });
  },

  setApplySimSettings: (v) => { const r = get().review; if (r) set({ review: { ...r, applySimSettings: v } }); },

  apply: () => {
    const r = get().review;
    if (!r || !r.checks) return;
    const current = useProject.getState().project;
    if (current !== r.base) {
      // The circuit changed while reviewing: redo the layout on the current circuit and ask again.
      const { review, diagnostics } = buildReview(r.entryId, r.proposal, current);
      if (!review) { set({ review: null }); pushError("Your circuit changed while the proposal was open, and the proposal no longer fits it.", diagnostics, false); return; }
      set({ review: { ...review, rebased: true } });
      void validate();
      return;
    }
    const next = r.layout.project;
    const sim = r.applySimSettings ? r.proposal.simulations[0] : undefined;
    useProject.getState().update(`AI: ${r.proposal.title || "proposal"}`, (draft) => {
      draft.schematic = structuredClone(next.schematic);
      if (sim) {
        draft.simulation.analysis = sim.analysis;
        if (sim.tran) { draft.simulation.tran.stop = sim.tran.stop; draft.simulation.tran.step = sim.tran.step; }
        if (sim.ac) draft.simulation.ac = { sweep: "dec", points: sim.ac.pointsPerDecade, start: sim.ac.start, stop: sim.ac.stop };
      }
    });
    const added = r.diff.parts.filter((p) => p.kind === "added").map((p) => r.layout.refToId.get(p.ref)!).filter(Boolean);
    useProject.getState().setSelection(added);
    set({ review: null, chat: [...get().chat, { id: nextId++, role: "assistant", text: `Applied “${r.proposal.title}”. Undo (Ctrl+Z) reverts it in one step.`, meta: "SparkBench" }] });
  },

  reject: async (feedback) => {
    const r = get().review;
    set({ review: null });
    if (!r) return;
    const f = feedback?.trim();
    if (!f) { set({ chat: [...get().chat, { id: nextId++, role: "assistant", text: `Proposal “${r.proposal.title}” rejected; nothing was changed.`, meta: "SparkBench" }] }); return; }
    // Modify: loop back to the chat with the review's facts so the model can correct itself.
    const facts: string[] = [];
    if (r.checks && !r.checks.ok) facts.push("Design checks failed:\n" + r.checks.diagnostics.filter((d) => d.severity === "error").map((d) => `- ${d.message}`).join("\n"));
    for (const s of r.sims) for (const e of s.expectations) if (e.pass === false) facts.push(`Expectation "${e.expectation.description}" on ${e.expectation.net}: measured ${e.measured} ${e.unit}, expected ${e.expectation.min ?? "-∞"}…${e.expectation.max ?? "∞"}.`);
    await get().send("chat", `${f}${facts.length ? `\n\nResults from SparkBench for your last proposal:\n${facts.join("\n")}` : ""}`);
  },

  clearChat: () => set({ chat: [], review: null }),
}));

function pushError(text: string, diagnostics: Diagnostic[] | undefined, retry: boolean, raw?: string, fix?: AiError["fix"]) {
  const s = useAssistant.getState();
  useAssistant.setState({ chat: [...s.chat, { id: nextId++, role: "error", text, diagnostics, retry, raw, fix }] });
}

async function run() {
  const st = useAssistant.getState();
  if (!host.available) { pushError("The assistant needs the SparkBench desktop app.", undefined, false); return; }
  useAssistant.setState({ busy: true });
  let res: CompletionResult;
  try {
    res = await host.invoke<CompletionResult>("sb:ai:complete", { system: systemPrompt(), messages: history(st.chat) });
  } catch (e) {
    res = { ok: false, error: { kind: "network", message: (e as Error).message } };
  }
  useAssistant.setState({ busy: false });
  if (!res.ok) {
    if (res.error.kind === "cancelled") { pushError("Request cancelled.", undefined, true); return; }
    pushError(res.error.message, undefined, res.error.kind !== "setup", res.error.detail, res.error.fix);
    return;
  }
  const parsed = parseAiResponse(res.text);
  if (!parsed.response) { pushError("The model's reply could not be used.", parsed.diagnostics, true, res.text); return; }
  const entry: ChatEntry = {
    id: nextId++, role: "assistant", text: parsed.response.message, sent: res.text, response: parsed.response,
    meta: `${res.model}${res.note ? ` · ${res.note}` : ""}`,
  };
  const p = parsed.response.proposal;
  const built = p ? buildReview(entry.id, p, useProject.getState().project) : null;
  if (built?.review && built.diagnostics.length) entry.diagnostics = built.diagnostics; // warnings only
  useAssistant.setState({ chat: [...useAssistant.getState().chat, entry] });
  if (!built) return;
  if (!built.review) {
    entry.rejected = true;
    pushError("The proposal was rejected before review. Nothing was changed.", built.diagnostics, true);
    return;
  }
  useAssistant.setState({ review: built.review });
  await validate();
}

/** Checks always; simulation automatically for small circuits (the user can run it otherwise). */
async function validate() {
  const r = useAssistant.getState().review;
  if (!r) return;
  const checks = checkDesign(r.layout.project);
  let footprints: Review["footprints"] = {};
  const fps = r.proposal.parts.map((p) => p.kicadFootprint).filter((x): x is string => !!x);
  if (fps.length && host.available) { try { footprints = await host.invoke("sb:ai:checkFootprints", fps); } catch { /* lookup is advisory */ } }
  const cur = useAssistant.getState().review;
  if (!cur || cur.entryId !== r.entryId) return;
  useAssistant.setState({ review: { ...cur, checks, footprints } });
  const parts = r.layout.project.schematic.components.length;
  if (checks.ok && r.proposal.simulations.length && parts <= AUTO_SIM_MAX_PARTS) await useAssistant.getState().simulateReview();
}
