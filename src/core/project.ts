// Project file format (.sbproj, JSON). See docs/project-format.md.
import { z } from "zod";
import type { Diagnostic, Project } from "./types";

export const APP_VERSION = "0.1.0";
export const PROJECT_EXT = ".sbproj";

const point = z.object({ x: z.number(), y: z.number() });
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const propValue = z.union([z.string(), z.number(), z.boolean()]);
const provenance = z.enum(["ideal", "generic", "behavioral", "vendor", "none"]);

export const projectSchema = z.object({
  format: z.literal("sparkbench-project"),
  version: z.literal(1),
  meta: z.object({
    name: z.string(),
    created: z.string(),
    modified: z.string(),
    appVersion: z.string(),
    description: z.string().optional(),
  }),
  schematic: z.object({
    components: z.array(z.object({
      id: z.string(),
      type: z.string(),
      ref: z.string(),
      position: point,
      rotation,
      mirror: z.boolean().optional(),
      props: z.record(z.string(), propValue),
      modelId: z.string().optional(),
      kicad: z.object({
        symbol: z.string().optional(),
        footprint: z.string().optional(),
        fields: z.record(z.string(), z.string()).optional(),
      }).optional(),
    })),
    wires: z.array(z.object({ id: z.string(), points: z.array(point).min(2) })),
    labels: z.array(z.object({ id: z.string(), name: z.string(), position: point, rotation })),
  }),
  simulation: z.object({
    analysis: z.enum(["op", "tran", "ac"]),
    tran: z.object({ stop: z.string(), step: z.string(), start: z.string().optional(), uic: z.boolean().optional() }),
    ac: z.object({ sweep: z.enum(["dec", "oct", "lin"]), points: z.number(), start: z.string(), stop: z.string() }),
    probes: z.array(z.object({
      id: z.string(),
      kind: z.enum(["voltage", "current"]),
      target: z.object({ point: point.optional(), netName: z.string().optional(), componentId: z.string().optional() }),
      label: z.string(),
      color: z.string().optional(),
    })),
  }),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["model", "subckt"]),
    text: z.string(),
    provenance,
    manufacturer: z.string().optional(),
    partNumber: z.string().optional(),
    source: z.string().optional(),
    pins: z.array(z.string()).optional(),
  })),
  kicad: z.object({
    projectPath: z.string().optional(),
    lastExport: z.string().optional(),
    notes: z.array(z.string()).optional(),
  }),
});

let idCounter = 0;
/** Short unique id; stable across save/load because it is stored. */
export function newId(prefix = "id"): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createProject(name = "Untitled"): Project {
  const now = new Date().toISOString();
  return {
    format: "sparkbench-project",
    version: 1,
    meta: { name, created: now, modified: now, appVersion: APP_VERSION },
    schematic: { components: [], wires: [], labels: [] },
    simulation: {
      analysis: "op",
      tran: { stop: "10m", step: "10u" },
      ac: { sweep: "dec", points: 20, start: "1", stop: "1MEG" },
      probes: [],
    },
    models: [],
    kicad: {},
  };
}

export function serializeProject(p: Project): string {
  const out: Project = { ...p, meta: { ...p.meta, modified: new Date().toISOString(), appVersion: APP_VERSION } };
  return JSON.stringify(out, null, 2);
}

export interface LoadResult { project?: Project; diagnostics: Diagnostic[] }

/** Parse and validate a project file. Never throws; problems are returned as diagnostics. */
export function parseProject(text: string, knownTypes?: Set<string>): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { diagnostics: [{ severity: "error", code: "project-json", source: "project",
      message: `The file is not valid JSON: ${(e as Error).message}`,
      fix: "Open the autosave/recovery copy, or check that this is a SparkBench .sbproj file." }] };
  }
  const r = projectSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { diagnostics: [{ severity: "error", code: "project-schema", source: "project",
      message: `The project file does not match the SparkBench format: ${issues.join("; ")}`,
      fix: "The file may be from a newer version or damaged. See docs/project-format.md." }] };
  }
  const project = r.data as Project;
  const diagnostics: Diagnostic[] = [];
  if (knownTypes) {
    const missing = project.schematic.components.filter((c) => !knownTypes.has(c.type));
    if (missing.length) {
      diagnostics.push({ severity: "error", code: "project-missing-part", source: "project",
        message: `${missing.length} component(s) use part types this installation does not have: ${[...new Set(missing.map((c) => c.type))].join(", ")}.`,
        fix: "They are kept in the file but cannot be simulated. Install a newer SparkBench or replace them.",
        componentIds: missing.map((c) => c.id) });
    }
  }
  const modelIds = new Set(project.models.map((m) => m.id));
  const badModel = project.schematic.components.filter((c) => c.modelId && !modelIds.has(c.modelId));
  if (badModel.length) {
    diagnostics.push({ severity: "error", code: "project-missing-model", source: "project",
      message: `${badModel.map((c) => c.ref).join(", ")} reference SPICE models that are not in this project.`,
      fix: "Re-import the model file (Library → Import SPICE model) or switch these parts back to the built-in model.",
      componentIds: badModel.map((c) => c.id) });
  }
  return { project, diagnostics };
}
