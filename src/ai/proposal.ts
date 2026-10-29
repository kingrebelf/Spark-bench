// The assistant's structured reply and its validation against the live part library.
// The zod schema mirrors src/ai/schema.ts (the JSON Schema sent to providers). Validation never
// "repairs" a bad proposal: every problem becomes a Diagnostic and the proposal is not applied.
import { z } from "zod";
import { computeConnectivity, sanitizeNetName } from "../core/connectivity";
import { getPart } from "../core/library";
import { parseSI } from "../core/units";
import type { ComponentDef, Diagnostic, Project } from "../core/types";
import { MEASURES } from "./schema";

const keyValue = z.object({ key: z.string(), value: z.string() });

export const partSchema = z.object({
  ref: z.string().min(1),
  type: z.string().min(1),
  values: z.array(keyValue),
  role: z.string(),
  uncertain: z.boolean(),
  uncertaintyNote: z.string(),
  kicadFootprint: z.string().nullable(),
  kicadSymbol: z.string().nullable(),
});

export const netSchema = z.object({
  name: z.string().min(1),
  ground: z.boolean(),
  pins: z.array(z.string()),
});

export const expectationSchema = z.object({
  description: z.string(),
  net: z.string(),
  measure: z.enum(MEASURES),
  min: z.number().nullable(),
  max: z.number().nullable(),
  frequency: z.number().nullable(),
});

export const simulationSchema = z.object({
  description: z.string(),
  analysis: z.enum(["op", "tran", "ac"]),
  tran: z.object({ stop: z.string(), step: z.string() }).nullable(),
  ac: z.object({ start: z.string(), stop: z.string(), pointsPerDecade: z.number().int() }).nullable(),
  expectations: z.array(expectationSchema),
});

export const proposalSchema = z.object({
  title: z.string(),
  summary: z.string(),
  assumptions: z.array(z.string()),
  parts: z.array(partSchema),
  remove: z.array(z.string()),
  nets: z.array(netSchema),
  simulations: z.array(simulationSchema),
  kicadNotes: z.array(z.string()),
});

export const aiResponseSchema = z.object({
  message: z.string(),
  questions: z.array(z.object({ question: z.string(), why: z.string(), options: z.array(z.string()) })),
  proposal: proposalSchema.nullable(),
});

export type ProposalPart = z.infer<typeof partSchema>;
export type ProposalNet = z.infer<typeof netSchema>;
export type Expectation = z.infer<typeof expectationSchema>;
export type SuggestedSimulation = z.infer<typeof simulationSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type AiResponse = z.infer<typeof aiResponseSchema>;

const diag = (severity: Diagnostic["severity"], code: string, message: string, fix?: string): Diagnostic =>
  ({ severity, code, message, fix, source: "ai" });

/** Parse the raw model text. Returns diagnostics instead of throwing; never patches the content. */
export function parseAiResponse(text: string): { response?: AiResponse; diagnostics: Diagnostic[] } {
  let raw: unknown;
  const trimmed = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    return { diagnostics: [diag("error", "ai-invalid-json",
      `The model's reply is not valid JSON (${(e as Error).message}).`,
      "Retry. If it keeps happening, choose a more capable model in Assistant settings.")] };
  }
  const r = aiResponseSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { diagnostics: [diag("error", "ai-schema",
      `The model's reply does not match the proposal format: ${issues.join("; ")}.`,
      "Retry. Smaller local models often fail to follow the format; a larger model usually fixes this.")] };
  }
  return { response: r.data, diagnostics: [] };
}

/** "R1.2" -> { ref: "R1", pin: "2" }. Splits at the last dot (pin ids never contain dots). */
export function splitPinRef(s: string): { ref: string; pin: string } | null {
  const i = s.lastIndexOf(".");
  if (i <= 0 || i === s.length - 1) return null;
  return { ref: s.slice(0, i).trim(), pin: s.slice(i + 1).trim() };
}

/** Resolve a pin token by id, then by unique (case-insensitive) pin name. */
export function resolvePin(def: ComponentDef, token: string): string | undefined {
  if (def.pins.some((p) => p.id === token)) return token;
  const byName = def.pins.filter((p) => p.name.toLowerCase() === token.toLowerCase());
  if (byName.length === 1) return byName[0].id;
  const byIdCi = def.pins.filter((p) => p.id.toLowerCase() === token.toLowerCase());
  return byIdCi.length === 1 ? byIdCi[0].id : undefined;
}

export interface ResolvedNet { name: string; label: string; ground: boolean; pins: { ref: string; pinId: string }[] }

export interface ProposalCheck {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Nets with pins resolved to pin ids; only meaningful when ok. */
  nets: ResolvedNet[];
}

/**
 * Check a proposal against the library and the current project:
 * unknown part ids, pins and properties, invalid values, duplicate refs, pins in two nets,
 * net-name collisions, missing ground, and existing parts dropped without being listed in `remove`.
 */
export function checkProposal(p: Proposal, project: Project, lookup: (id: string) => ComponentDef | undefined = getPart): ProposalCheck {
  const out: Diagnostic[] = [];
  const existing = project.schematic.components.filter((c) => !lookup(c.type)?.role);
  const existingByRef = new Map(existing.map((c) => [c.ref, c]));
  const refs = new Map<string, ComponentDef>();

  for (const part of p.parts) {
    if (refs.has(part.ref)) { out.push(diag("error", "ai-duplicate-ref", `The proposal uses the reference ${part.ref} twice.`, "Ask the assistant to give every part a unique reference.")); continue; }
    const def = lookup(part.type);
    if (!def) {
      out.push(diag("error", "ai-unknown-part", `${part.ref} uses the part id "${part.type}", which is not in the SparkBench library.`,
        "The assistant may only use library parts. Retry, or ask it to substitute an available part."));
      continue;
    }
    if (def.role) { out.push(diag("error", "ai-role-part", `${part.ref} is a ${def.name} symbol; ground is expressed with a ground net, not a part.`, "Retry; the assistant should mark the net as ground instead.")); continue; }
    const prev = existingByRef.get(part.ref);
    if (prev && prev.type !== part.type) {
      out.push(diag("error", "ai-ref-type-change", `${part.ref} is a ${lookup(prev.type)?.name ?? prev.type} in your circuit, but the proposal makes it a ${def.name}.`,
        "Ask the assistant to remove the old part and add the new one under a new reference."));
    }
    refs.set(part.ref, def);
    for (const kv of part.values) {
      const pd = def.props.find((d) => d.key === kv.key);
      if (!pd) { out.push(diag("error", "ai-unknown-prop", `${part.ref} (${def.name}) has no property "${kv.key}". Available: ${def.props.map((d) => d.key).join(", ") || "none"}.`, "Retry; the assistant must use property keys from the catalog.")); continue; }
      if (pd.kind === "number" && kv.value.trim() !== "" && Number.isNaN(parseSI(kv.value))) {
        out.push(diag("error", "ai-invalid-value", `${part.ref}: "${kv.value}" is not a valid ${pd.label}.`, "Values must be numbers with an optional SI prefix, e.g. 4.7k, 100n, 1MEG."));
      }
      if (pd.kind === "select" && pd.options && !pd.options.includes(kv.value)) {
        out.push(diag("error", "ai-invalid-option", `${part.ref}: "${kv.value}" is not an option for ${pd.label} (${pd.options.join(", ")}).`, "Retry with one of the listed options."));
      }
    }
  }

  const removeSet = new Set(p.remove);
  for (const r of p.remove) {
    if (!existingByRef.has(r)) out.push(diag("warning", "ai-remove-unknown", `The proposal removes ${r}, which is not in your circuit.`));
    if (refs.has(r)) out.push(diag("error", "ai-remove-and-keep", `${r} is listed both as removed and as kept.`, "Retry; a part is either kept or removed."));
  }
  for (const c of existing) {
    if (!refs.has(c.ref) && !removeSet.has(c.ref)) {
      out.push(diag("error", "ai-dropped-part", `The proposal leaves out ${c.ref} without saying it should be removed.`,
        "Retry. The assistant must list every existing part, or name it under `remove`."));
    }
  }

  // Nets.
  const pinOwner = new Map<string, string>();
  const labels = new Map<string, string>();
  const nets: ResolvedNet[] = [];
  const grounds = p.nets.filter((n) => n.ground);
  if (grounds.length > 1) out.push(diag("error", "ai-multi-ground", `The proposal marks ${grounds.length} nets as ground (${grounds.map((n) => n.name).join(", ")}).`, "Ground is one net; retry so all ground pins are in one net."));
  if (p.parts.length && grounds.length === 0) out.push(diag("error", "ai-no-ground", "The proposal has no ground net.", "Every simulated circuit needs a 0 V reference; ask the assistant to mark one net as ground."));
  for (const n of p.nets) {
    const label = n.ground ? "0" : sanitizeNetName(n.name);
    if (!n.ground && label === "0") {
      out.push(diag("error", "ai-net-name-ground", `Net "${n.name}" would be treated as ground by its name but is not marked as ground.`, "Retry with a different net name or mark it as the ground net."));
    }
    const prev = labels.get(label);
    if (prev !== undefined && !n.ground) out.push(diag("error", "ai-net-name-clash", `Nets "${prev}" and "${n.name}" have the same name after cleanup (${label}).`, "Retry with distinct net names."));
    labels.set(label, n.name);
    const resolved: ResolvedNet = { name: n.name, label, ground: n.ground, pins: [] };
    for (const token of n.pins) {
      const sp = splitPinRef(token);
      if (!sp) { out.push(diag("error", "ai-bad-pin", `"${token}" in net ${n.name} is not of the form REF.PIN.`, "Retry; connections must be written like R1.1 or Q1.B.")); continue; }
      const def = refs.get(sp.ref);
      if (!def) { out.push(diag("error", "ai-unknown-ref", `Net ${n.name} connects ${token}, but there is no part ${sp.ref} in the proposal.`, "Retry; every connected part must be listed in `parts`.")); continue; }
      const pinId = resolvePin(def, sp.pin);
      if (!pinId) { out.push(diag("error", "ai-unknown-pin", `${sp.ref} (${def.name}) has no pin "${sp.pin}". Pins: ${def.pins.map((x) => `${x.id} (${x.name})`).join(", ")}.`, "Retry with pin ids from the catalog.")); continue; }
      const key = `${sp.ref}.${pinId}`;
      const owner = pinOwner.get(key);
      if (owner && owner !== n.name) { out.push(diag("error", "ai-pin-two-nets", `${key} is in both net ${owner} and net ${n.name}, which would short them together.`, "Retry; each pin belongs to exactly one net.")); continue; }
      if (owner === n.name) continue;
      pinOwner.set(key, n.name);
      resolved.pins.push({ ref: sp.ref, pinId });
    }
    nets.push(resolved);
  }
  for (const [ref, def] of refs) {
    for (const pin of def.pins) {
      if (!pinOwner.has(`${ref}.${pin.id}`)) {
        out.push(diag("warning", "ai-unconnected-pin", `${ref} pin ${pin.name} is not connected in the proposal.`, "The design checks will report it if it matters."));
      }
    }
  }
  // A malformed existing project (e.g. unknown parts) is not the proposal's fault but is worth surfacing.
  if (computeConnectivity(project, lookup).unknownParts.length) {
    out.push(diag("warning", "ai-existing-unknown", "Your circuit contains parts that are not in the library; the assistant cannot see their pins."));
  }
  return { ok: !out.some((d) => d.severity === "error"), diagnostics: out, nets };
}
