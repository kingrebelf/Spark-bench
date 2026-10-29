// JSON Schema for the assistant's reply. One schema is sent to every provider (Anthropic
// structured outputs, OpenAI strict json_schema, OpenAI-compatible servers, Codex --output-schema),
// so it follows the strictest common subset:
//  - every object has `additionalProperties: false` and lists every property in `required`
//  - optional values are nullable (`anyOf` with null) instead of omitted
//  - no free-form maps (props are [{key, value}] arrays), no recursion, no min/max/length keywords
// `src/ai/proposal.ts` holds the matching zod schema used to validate what comes back.
// This file has no imports so the Electron main process can bundle it cheaply.

type Json = Record<string, unknown>;

const str = (description?: string): Json => (description ? { type: "string", description } : { type: "string" });
const bool = (description?: string): Json => (description ? { type: "boolean", description } : { type: "boolean" });
const nullable = (s: Json): Json => ({ anyOf: [s, { type: "null" }] });
const arr = (items: Json, description?: string): Json => (description ? { type: "array", items, description } : { type: "array", items });
const obj = (properties: Record<string, Json>, description?: string): Json => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const MEASURES = ["op", "final", "max", "min", "avg", "pp", "rms", "gain_db_at", "f_3db"] as const;

const keyValue = obj({ key: str("Property key from the catalog, e.g. value, frequency."), value: str("SI string, e.g. 4.7k, 100n, 1MEG, 5.") });

const part = obj({
  ref: str("Reference designator, unique, e.g. R1, C2, V1."),
  type: str("Library part id from the catalog. Never invent ids."),
  values: arr(keyValue, "Only the properties you set; others keep their current or default values."),
  role: str("Plain-language role of this part in the circuit."),
  uncertain: bool("True when the value is a guess that the user should confirm."),
  uncertaintyNote: str("Why the value is uncertain and what it depends on; empty string when certain."),
  kicadFootprint: nullable(str("KiCad footprint lib_id, e.g. Resistor_SMD:R_0805_2012Metric; null to keep the default.")),
  kicadSymbol: nullable(str("KiCad symbol lib_id override; null to keep the default.")),
});

const net = obj({
  name: str("Net name, e.g. VIN, OUT, GND. Letters, digits and _ only."),
  ground: bool("True for the 0 V reference net (exactly one net may be ground)."),
  pins: arr(str("REF.PIN using the pin id from the catalog, e.g. R1.1, Q1.B, V1.2.")),
});

const expectation = obj({
  description: str("What should happen and why, in plain language."),
  net: str("Name of a net from `nets` whose voltage (to ground) is measured."),
  measure: { type: "string", enum: [...MEASURES], description: "op: DC operating point; final/max/min/avg/pp/rms: over a transient run; gain_db_at: AC magnitude in dB at `frequency`; f_3db: AC -3 dB frequency in Hz." },
  min: nullable({ type: "number", description: "Lowest acceptable value (V, dB or Hz). null = no lower bound." }),
  max: nullable({ type: "number", description: "Highest acceptable value. null = no upper bound." }),
  frequency: nullable({ type: "number", description: "Hz, only for gain_db_at." }),
});

const simulation = obj({
  description: str("What this run checks."),
  analysis: { type: "string", enum: ["op", "tran", "ac"] },
  tran: nullable(obj({ stop: str("e.g. 10m"), step: str("e.g. 10u") })),
  ac: nullable(obj({ start: str("Hz, e.g. 10"), stop: str("Hz, e.g. 1MEG"), pointsPerDecade: { type: "integer" } })),
  expectations: arr(expectation),
});

const proposal = obj({
  title: str("Short name for the change, e.g. 'LED with current-limiting resistor'."),
  summary: str("What the circuit does, in two or three sentences."),
  assumptions: arr(str(), "Every requirement you assumed instead of being told."),
  parts: arr(part, "The complete list of non-ground parts after the change, including unchanged existing parts."),
  remove: arr(str(), "Refs of existing parts to delete. Every existing part missing from `parts` must be listed here."),
  nets: arr(net, "The complete connectivity after the change. Every pin of every part appears in exactly one net."),
  simulations: arr(simulation, "Suggested simulations with expected results."),
  kicadNotes: arr(str(), "Notes for building this on a PCB in KiCad (footprints, ratings, layout)."),
});

const question = obj({
  question: str(),
  why: str("Why the answer changes the design."),
  options: arr(str(), "Typical answers the user can click; may be empty."),
});

export const AI_RESPONSE_JSON_SCHEMA: Json = obj({
  message: str("Your reply to the user in plain language."),
  questions: arr(question, "Clarifying questions. Ask before proposing when a missing requirement matters."),
  proposal: nullable(proposal),
});
