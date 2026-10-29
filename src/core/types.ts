// Shared contracts for every module. Owned by the hub; change only with care,
// since the editor, simulator, library, KiCad and AI modules all depend on them.

/** Schematic coordinates are integer grid units. 1 unit = 1.27 mm (50 mil), KiCad's default schematic grid. */
export interface Point { x: number; y: number }
export type Rotation = 0 | 90 | 180 | 270;
export type AnalysisKind = "op" | "tran" | "ac";
export type PropValue = string | number | boolean;

// ---------------------------------------------------------------- symbols

export type Shape =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "polyline"; points: Point[]; closed?: boolean; fill?: boolean }
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill?: boolean }
  | { kind: "circle"; cx: number; cy: number; r: number; fill?: boolean }
  /** SVG arc from (x1,y1) to (x2,y2) with radius r. */
  | { kind: "arc"; x1: number; y1: number; x2: number; y2: number; r: number; sweep?: boolean }
  | { kind: "text"; x: number; y: number; text: string; size?: number; anchor?: "start" | "middle" | "end" };

export interface PinDef {
  /** Stable id used in connectivity and KiCad pin maps, e.g. "1", "A", "K", "B". */
  id: string;
  name: string;
  /** Pin tip position in grid units, relative to the symbol origin at rotation 0. */
  x: number;
  y: number;
}

// ---------------------------------------------------------------- library

export type Provenance =
  /** Textbook ideal element (R, C, ideal source). Accurate within SPICE's ideal model. */
  | "ideal"
  /** Generic SPICE model with typical parameters; not tied to a real part number. */
  | "generic"
  /** Behavioral macromodel (e.g. logic or 555 built from B-sources/switches); approximates function, not device physics. */
  | "behavioral"
  /** Manufacturer-supplied SPICE model for a specific part number. */
  | "vendor"
  /** Schematic-only part (connector, label, mechanical); has no simulation model. */
  | "none";

export interface PropDef {
  key: string;
  label: string;
  kind: "number" | "text" | "select" | "bool";
  /** Display unit for numbers, e.g. "Ω", "F", "V", "Hz". Values are stored as SI strings like "4.7k". */
  unit?: string;
  default: PropValue;
  options?: string[];
  help?: string;
  /** Model parameter (shown under "Model" rather than "Value"). */
  model?: boolean;
  min?: number;
}

export interface KicadMapping {
  /** lib_id, e.g. "Device:R". */
  symbol: string;
  /** Default footprint, e.g. "Resistor_SMD:R_0805_2012Metric". Empty when the user must choose. */
  footprint: string;
  /** Our pin id -> KiCad symbol pin number. */
  pinMap: Record<string, string>;
  /** Symbol unit to place for multi-unit symbols (1 = A). Default 1. */
  unit?: number;
  /** Extra units that must also be placed (e.g. the power unit of an op-amp package); their pins are power pins with no schematic wires. */
  extraUnits?: number[];
  /** Extra KiCad fields to write (e.g. Sim.Device). */
  fields?: Record<string, string>;
}

export interface SpiceEmitContext {
  /** Net name for each of this instance's pins (SPICE node names; "0" is ground). */
  node(pinId: string): string;
  /** Numeric value of a prop (SI parsed). Records a diagnostic and returns NaN if invalid. */
  num(key: string): number;
  /** Raw prop value as string. */
  str(key: string): string;
  /** Register a .model or .subckt card once per netlist (deduplicated by key). */
  define(key: string, text: string): void;
  /** The instance being emitted (ref is already SPICE-safe). */
  inst: ComponentInstance;
  analysis: AnalysisKind;
  /** Look up a project-imported model by id. */
  model(id: string): SpiceModel | undefined;
  /**
   * Live-mode schedule for this instance's interactive prop: [time in s, value] pairs, sorted, starting at t=0
   * (booleans as 0/1). Undefined outside live mode; emitters then use the static prop value. Emit it as a PWL
   * control source (e.g. a voltage-controlled switch, or a behavioral resistor r='...' / B-source).
   */
  schedule?: [number, number][];
}

export interface ComponentDef {
  id: string;
  name: string;
  category: string;
  description: string;
  keywords?: string[];
  /** Reference prefix: R, C, Q, U, ... */
  refPrefix: string;
  pins: PinDef[];
  symbol: Shape[];
  props: PropDef[];
  provenance: Provenance;
  /** Plain-language statement of model limits shown to the user. */
  accuracyNote?: string;
  /** Analyses this part can take part in. Missing key = supported. */
  analyses?: Partial<Record<AnalysisKind, boolean>>;
  /** Pin pairs that conduct at DC (for the "no DC path to ground" check). Omit = all pins mutually conduct. */
  dcPaths?: [string, string][];
  /** Emit SPICE lines (may be empty for schematic-only parts). Return null when unsupported. */
  spice?: (ctx: SpiceEmitContext) => string[] | null;
  kicad?: KicadMapping;
  /** Special roles handled by connectivity rather than SPICE. */
  role?: "ground" | "netlabel" | "probe-voltage" | "probe-current";
  /**
   * Operable on the canvas during simulation. "toggle" flips a boolean prop on click (switch);
   * "momentary" holds it true while the pointer is down (push button); "slider" sets a numeric prop
   * between min and max by dragging (potentiometer wiper). Live mode records each change with its
   * simulation time and re-simulates from t = 0 with the recorded schedule.
   */
  interactive?: { kind: "toggle" | "momentary" | "slider"; prop: string; min?: number; max?: number };
  /** Visual indicator driven by simulation results (e.g. LED glow from its forward current). */
  indicator?: { kind: "led"; currentPin: string; colorProp?: string; ratedCurrent?: number };
  /**
   * Stress limits checked against transient/op results (component damage). "current" = |current| through the
   * part, "power" = |V(pins) · I|, "voltage" = |V(pins[0]) − V(pins[1])|, "reverse-voltage" = V(pins[1]) − V(pins[0]).
   * The limit is the SI value of `prop` (falling back to `default`); `pins` default to the first two pins.
   */
  ratings?: { kind: "current" | "power" | "voltage" | "reverse-voltage"; prop?: string; default: number; pins?: [string, string] }[];
  /** Text shown on the canvas next to the symbol: prop keys to display. */
  displayProps?: string[];
}

// ---------------------------------------------------------------- project

export interface ComponentInstance {
  id: string;
  type: string;
  ref: string;
  position: Point;
  rotation: Rotation;
  mirror?: boolean;
  props: Record<string, PropValue>;
  /** Optional project model (SpiceModel.id) overriding the def's built-in model. */
  modelId?: string;
  /** Per-instance KiCad overrides. */
  kicad?: { symbol?: string; footprint?: string; fields?: Record<string, string> };
}

export interface Wire { id: string; points: Point[] }
export interface NetLabel { id: string; name: string; position: Point; rotation: Rotation }

export interface Probe {
  id: string;
  kind: "voltage" | "current";
  /** voltage: a net name or a point on a wire/pin; current: a component id (current into its first pin). */
  target: { point?: Point; netName?: string; componentId?: string };
  label: string;
  color?: string;
}

export interface SpiceModel {
  id: string;
  name: string;
  kind: "model" | "subckt";
  /** Full .model or .subckt text. */
  text: string;
  provenance: Provenance;
  /** Part number / manufacturer when vendor. */
  manufacturer?: string;
  partNumber?: string;
  source?: string;
  /** Pin order for subcircuits (names from the .subckt line). */
  pins?: string[];
}

export interface SimConfig {
  analysis: AnalysisKind;
  tran: { stop: string; step: string; start?: string; uic?: boolean };
  ac: { sweep: "dec" | "oct" | "lin"; points: number; start: string; stop: string };
  probes: Probe[];
}

export interface Project {
  format: "sparkbench-project";
  version: 1;
  meta: { name: string; created: string; modified: string; appVersion: string; description?: string };
  schematic: { components: ComponentInstance[]; wires: Wire[]; labels: NetLabel[] };
  simulation: SimConfig;
  models: SpiceModel[];
  kicad: {
    /** Last export target and notes; per-part mapping lives on instances. */
    projectPath?: string;
    lastExport?: string;
    notes?: string[];
  };
}

// ---------------------------------------------------------------- diagnostics & results

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  /** Stable machine code, e.g. "no-ground", "floating-pin", "spice-singular". */
  code: string;
  message: string;
  /** How to fix it, in plain language. */
  fix?: string;
  componentIds?: string[];
  wireIds?: string[];
  netNames?: string[];
  source: "check" | "spice" | "kicad" | "ai" | "project";
}

export interface Vector {
  name: string;
  kind: "voltage" | "current" | "time" | "frequency" | "other";
  unit: string;
  /** Net name (voltage) or component id (current) this vector belongs to. */
  netName?: string;
  componentId?: string;
  real: number[];
  /** Present for AC analysis. */
  imag?: number[];
}

export interface SimResult {
  ok: boolean;
  analysis: AnalysisKind;
  /** Sweep variable (time or frequency); absent for op. */
  x?: Vector;
  vectors: Vector[];
  diagnostics: Diagnostic[];
  netlist: string;
  log: string[];
  /** Wall-clock run time in ms. */
  elapsedMs: number;
}
