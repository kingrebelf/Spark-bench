// SPICE model import: parses `.model` and `.subckt` text (vendor model files, LTspice/ngspice
// libraries) into SpiceModel objects that travel with the project, and turns subcircuits
// into library parts whose pins come from the .subckt line.
//
// UI flow (see docs/library.md):
//   1. importSpiceText(fileText, { source: fileName }) -> { models, diagnostics }
//   2. add the chosen models to project.models (undoable update)
//   3. registerImportedModels(project.models) so subcircuit parts ("subckt:<id>") exist
//   4. for diodes/BJTs/MOSFETs: compatibleModels(part, project.models) lists models the
//      part accepts; set instance.modelId. checkModelAssignment() explains mismatches.
import { allParts, getPart, registerParts } from "../core/library";
import { newId } from "../core/project";
import type { ComponentDef, Diagnostic, PinDef, Provenance, Shape, SpiceModel } from "../core/types";

export interface ParsedModel {
  kind: "model" | "subckt";
  /** Model or subcircuit name as written (case preserved). */
  name: string;
  /** .model device type, upper case: D, NPN, PNP, NMOS, PMOS, NJF, PJF, VDMOS, SW, ... */
  type?: string;
  /** Polarity for MOSFET-like types (VDMOS uses the pchan flag). */
  polarity?: "N" | "P";
  /** Subcircuit pin names in order. */
  pins?: string[];
  /** Default parameters from "params:" on the .subckt line, or the .model parameters. */
  params?: Record<string, string>;
  /** Full card text, continuation lines joined, comments removed. */
  text: string;
  /** 1-based source line of the card. */
  line: number;
}

export interface ParseResult { models: ParsedModel[]; diagnostics: Diagnostic[] }

const diag = (severity: Diagnostic["severity"], code: string, message: string, fix?: string): Diagnostic =>
  ({ severity, code, message, fix, source: "project" });

/** Strip comments and join "+" continuation lines. Returns logical lines with their first source line. */
export function logicalLines(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  raw.forEach((l, i) => {
    let s = l;
    if (/^\s*\*/.test(s)) return; // full-line comment
    s = s.replace(/(^|\s)[;$].*$/, "$1"); // inline comments ("; ..." or " $ ...")
    if (!s.trim()) return;
    if (/^\s*\+/.test(s)) {
      if (out.length) out[out.length - 1].text += " " + s.replace(/^\s*\+/, "").trim();
      return;
    }
    out.push({ text: s.trim(), line: i + 1 });
  });
  return out;
}

function parseParams(s: string): Record<string, string> {
  const params: Record<string, string> = {};
  const norm = s.replace(/[()]/g, " ").replace(/\s*=\s*/g, "=");
  for (const tok of norm.split(/[\s,]+/)) {
    const m = /^([A-Za-z_][\w.]*)=(.+)$/.exec(tok);
    if (m) params[m[1].toLowerCase()] = m[2];
    else if (tok) params[tok.toLowerCase()] = "";
  }
  return params;
}

/** Parse every .model and .subckt in a file. Never throws. */
export function parseSpiceModels(text: string): ParseResult {
  const lines = logicalLines(text);
  const models: ParsedModel[] = [];
  const diagnostics: Diagnostic[] = [];
  let sub: { model: ParsedModel; body: string[]; depth: number } | null = null;

  for (const { text: l, line } of lines) {
    const lower = l.toLowerCase();
    if (sub) {
      sub.body.push(l);
      if (/^\.subckt\b/.test(lower)) sub.depth++;
      else if (/^\.ends\b/.test(lower)) {
        sub.depth--;
        if (sub.depth === 0) { sub.model.text = sub.body.join("\n"); models.push(sub.model); sub = null; }
      }
      continue;
    }
    if (/^\.model\b/.test(lower)) {
      const m = /^\.model\s+(\S+)\s+([A-Za-z]+)\s*(.*)$/i.exec(l);
      if (!m) { diagnostics.push(diag("warning", "spice-import-model", `Line ${line}: could not read this .model card.`, "Expected `.model NAME TYPE(param=value ...)`.")); continue; }
      const type = m[2].toUpperCase();
      const params = parseParams(m[3]);
      const pm: ParsedModel = { kind: "model", name: m[1], type, params, text: l, line };
      if (type === "NMOS" || type === "PMOS") pm.polarity = type[0] as "N" | "P";
      if (type === "VDMOS") pm.polarity = "pchan" in params ? "P" : "N";
      models.push(pm);
    } else if (/^\.subckt\b/.test(lower)) {
      const head = l.split(/\s+/);
      const name = head[1];
      if (!name) { diagnostics.push(diag("warning", "spice-import-subckt", `Line ${line}: .subckt without a name.`)); continue; }
      const pins: string[] = [];
      let params: Record<string, string> = {};
      for (let i = 2; i < head.length; i++) {
        const t = head[i];
        if (/^params:?$/i.test(t)) { params = parseParams(head.slice(i + 1).join(" ")); break; }
        if (t.includes("=")) { params = parseParams(head.slice(i).join(" ")); break; }
        pins.push(t);
      }
      sub = { model: { kind: "subckt", name, pins, params, text: "", line }, body: [l], depth: 1 };
    }
  }
  if (sub) diagnostics.push(diag("error", "spice-import-unterminated", `Subcircuit ${sub.model.name} (line ${sub.model.line}) has no matching .ends.`, "The file may be truncated. Re-download it or add the missing .ends line."));
  if (models.length === 0 && diagnostics.length === 0) {
    diagnostics.push(diag("warning", "spice-import-empty", "No .model or .subckt definitions were found in this text.", "Check that you selected a SPICE model file (.lib, .mod, .cir, .sub, .txt)."));
  }
  const seen = new Map<string, number>();
  for (const m of models) {
    const k = m.name.toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, c] of seen) if (c > 1) diagnostics.push(diag("warning", "spice-import-duplicate", `"${k}" is defined ${c} times; only one definition can be used per netlist.`, "Import just the variant you need."));
  return { models, diagnostics };
}

export interface ImportMeta { source?: string; provenance?: Provenance; manufacturer?: string }

/**
 * UI entry point: parse a file's text and return SpiceModel objects ready for project.models.
 * Provenance defaults to "vendor" only when a manufacturer is given; otherwise "generic",
 * since we cannot tell who authored an arbitrary model file.
 */
export function importSpiceText(text: string, meta: ImportMeta = {}): { models: SpiceModel[]; diagnostics: Diagnostic[] } {
  const { models, diagnostics } = parseSpiceModels(text);
  const provenance = meta.provenance ?? (meta.manufacturer ? "vendor" : "generic");
  return {
    diagnostics,
    models: models.map((m) => ({
      id: newId("m"),
      name: m.name,
      kind: m.kind,
      text: m.text,
      provenance,
      manufacturer: meta.manufacturer,
      partNumber: m.name,
      source: meta.source,
      pins: m.pins,
    })),
  };
}

// ---------------------------------------------------------------- model slots on library parts

/** Part id -> .model types it accepts through instance.modelId. Filled by the part files. */
export const MODEL_SLOTS: Record<string, string[]> = {};
export function modelSlot(partId: string, types: string[]): void { MODEL_SLOTS[partId] = types; }

/** Effective device type of a model for slot matching (VDMOS counts as NMOS/PMOS). */
export function modelDeviceType(model: SpiceModel): string | undefined {
  const p = parseSpiceModels(model.text).models[0];
  if (!p || p.kind !== "model") return undefined;
  if (p.type === "VDMOS") return p.polarity === "P" ? "PMOS" : "NMOS";
  return p.type;
}

/** Explain why a model can't be used on a part, or undefined when it can. */
export function checkModelAssignment(partId: string, model: SpiceModel): Diagnostic | undefined {
  const def = getPart(partId);
  const slots = MODEL_SLOTS[partId];
  if (!def || !slots) return diag("error", "model-not-assignable", `${def?.name ?? partId} does not take an imported model.`, "Use a Diode, BJT or MOSFET part, or place the subcircuit as its own part.");
  if (model.kind === "subckt") return diag("error", "model-is-subckt", `${model.name} is a subcircuit, not a .model card.`, `Place it as its own part ("${model.name}" in the Imported category) instead of assigning it to ${def.name}.`);
  const t = modelDeviceType(model);
  if (!t || !slots.includes(t)) return diag("error", "model-type-mismatch", `${model.name} is a ${t ?? "unknown"} model, but ${def.name} needs ${slots.join(" or ")}.`, `Choose a ${slots.join("/")} model or a different part.`);
  return undefined;
}

/** Project models that a part accepts. */
export function compatibleModels(partId: string, models: SpiceModel[]): SpiceModel[] {
  return models.filter((m) => !checkModelAssignment(partId, m));
}

/** Library parts that can take this model (for "use this model on..." menus). */
export function partsForModel(model: SpiceModel): string[] {
  if (model.kind === "subckt") return [subcktPartId(model)];
  return allParts().filter((d) => !checkModelAssignment(d.id, model)).map((d) => d.id);
}

// ---------------------------------------------------------------- subcircuit parts

export const subcktPartId = (m: SpiceModel) => `subckt:${m.id}`;

/** Build a box symbol with pins split left/right, 2 grid units apart. */
export function subcktPart(model: SpiceModel): ComponentDef {
  const names = model.pins ?? parseSpiceModels(model.text).models[0]?.pins ?? [];
  const left = Math.ceil(names.length / 2);
  const rows = Math.max(left, names.length - left);
  const h = rows * 2;
  const top = -Math.floor(h / 2) + 1;
  const pins: PinDef[] = names.map((nm, i) => {
    const onLeft = i < left;
    const row = onLeft ? i : i - left;
    return { id: String(i + 1), name: nm, x: onLeft ? -8 : 8, y: top + row * 2 };
  });
  const symbol: Shape[] = [
    { kind: "rect", x: -5, y: top - 2, w: 10, h: h + 1 },
    { kind: "text", x: 0, y: top - 3, text: model.name, size: 1.2, anchor: "middle" },
    ...pins.flatMap((p): Shape[] => [
      { kind: "line", x1: p.x, y1: p.y, x2: p.x < 0 ? -5 : 5, y2: p.y },
      { kind: "text", x: p.x < 0 ? -4.6 : 4.6, y: p.y, text: p.name, size: 0.9, anchor: p.x < 0 ? "start" : "end" },
    ]),
  ];
  return {
    id: subcktPartId(model),
    name: model.name,
    category: "Imported",
    description: `Imported subcircuit ${model.name}${model.manufacturer ? ` (${model.manufacturer})` : ""}${model.source ? ` from ${model.source}` : ""}. Pins follow the .subckt line: ${names.join(", ")}.`,
    refPrefix: "X",
    pins,
    symbol,
    props: [],
    provenance: model.provenance,
    accuracyNote: model.provenance === "vendor"
      ? `Uses the imported model text as supplied${model.manufacturer ? ` by ${model.manufacturer}` : ""}; accuracy is that model's.`
      : "Uses the imported model text as supplied; its author and accuracy are unknown to SparkBench.",
    spice: (ctx) => {
      ctx.define(`project-model:${model.id}`, model.text);
      const ref = ctx.inst.ref.replace(/[^A-Za-z0-9_]/g, "_");
      const name = ref.toUpperCase().startsWith("X") ? ref : `X${ref}`;
      return [`${name} ${pins.map((p) => ctx.node(p.id)).join(" ")} ${model.name}`];
    },
  };
}

/** Register a part for every subcircuit in the project (call after loading a project, before checks). */
export function registerImportedModels(models: SpiceModel[]): ComponentDef[] {
  const defs = models.filter((m) => m.kind === "subckt").map(subcktPart);
  registerParts(defs);
  return defs;
}
