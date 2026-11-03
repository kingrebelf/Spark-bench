// Chunked continuation for live simulation.
//
// Live mode computes the run in short chunks ahead of the playhead. Each chunk is a real ngspice transient that
// starts from the previous chunk's state at one of its REAL solver timepoints (never an interpolated one: a fast
// edge would give a half-switched latch): every node voltage goes in as `.ic v(node)=…` and every inductor's
// branch current as `ic=` on the inductor, with `uic`, so ngspice continues exactly where it stopped. Sources
// are shifted by the chunk's start time (SpiceEmitContext.timeOffset). Interactive parts hold one value per chunk;
// a change starts a new chunk at the last real timepoint at or before the change.
import { getPart } from "../core/library";
import type { SpiceEngine } from "../core/simulate";
import { toSpiceNumber } from "../core/units";
import type { Project, SimResult, Vector } from "../core/types";
import { edgeFor } from "./live";
import { runSimulation } from "./run";
import { siText } from "./setup";
import type { Damage } from "./stress";

/** Solver state at one real timepoint: node voltages and inductor branch currents. */
export interface ChunkState {
  /** Absolute circuit time of the timepoint. */
  t: number;
  /** Node name (as ngspice reports it, lowercase, subcircuit nodes like "xu1.q") -> volts. */
  nodes: Record<string, number>;
  /** Inductor element name (lowercase) -> branch current in amps. */
  inductors: Record<string, number>;
}

const isHelper = (name: string) => /sb[lfc]{1,2}_/i.test(name);

/** State at sample k of a transient result (k must be a real timepoint of that result). */
export function stateAt(r: SimResult, k: number): ChunkState {
  const nodes: Record<string, number> = {}, inductors: Record<string, number> = {};
  for (const v of r.vectors) {
    const m = /^v\((.+)\)$/i.exec(v.name);
    if (m && !isHelper(m[1])) { nodes[m[1].toLowerCase()] = v.real[k]; continue; }
    const l = /^i\((l[^@)]*)\)$/i.exec(v.name) ?? /^(l[^#]*)#branch$/i.exec(v.name);
    if (l) inductors[l[1].toLowerCase()] = v.real[k];
  }
  return { t: r.x!.real[k], nodes, inductors };
}

/**
 * Netlist rewrite that starts the run from `state`: `.ic` for every node, `ic=` on every inductor (replacing any
 * initial-current prop), capacitor `ic=` props removed (the node voltages already carry them), `uic` on `.tran`,
 * and `.save all` so every node voltage comes back for the next chunk.
 */
export function applyInitialState(netlist: string, state: ChunkState | null): string {
  let lines = netlist.split("\n");
  if (!lines.some((l) => /^\s*\.save\b/i.test(l))) {
    const at = lines.findIndex((l) => /^\s*\.(op|tran|ac|dc|end)\b/i.test(l));
    lines.splice(at < 0 ? lines.length : at, 0, ".save all");
  }
  if (!state) return lines.join("\n");
  lines = lines.map((l) => {
    const tok = l.trim().split(/\s+/);
    const name = tok[0]?.toLowerCase() ?? "";
    if (/^\.tran\b/i.test(l)) return /\buic\b/i.test(l) ? l : `${l.trimEnd()} uic`;
    if (name.startsWith("c")) return tok.filter((x) => !/^ic=/i.test(x)).join(" ");
    if (name.startsWith("l") && name in state.inductors) return [...tok.filter((x) => !/^ic=/i.test(x)), `ic=${toSpiceNumber(state.inductors[name])}`].join(" ");
    return l;
  });
  const ics = Object.entries(state.nodes).filter(([n]) => n !== "0").map(([n, v]) => `v(${n})=${toSpiceNumber(v)}`);
  const rows: string[] = [];
  for (let i = 0; i < ics.length; i += 8) rows.push((i ? "+ " : ".ic ") + ics.slice(i, i + 8).join(" "));
  const at = lines.findIndex((l) => /^\s*\.(tran|end)\b/i.test(l));
  lines.splice(at < 0 ? lines.length : at, 0, ...rows);
  return lines.join("\n");
}

export interface ChunkOptions {
  /** Absolute circuit time the chunk starts at (0 for the first chunk). */
  t0: number;
  /** Chunk length in seconds of circuit time. */
  length: number;
  /** Max time step. */
  step: number;
  /** Interactive part values for this chunk (component id -> value; booleans as 0/1, sliders in prop units). */
  params?: Record<string, number>;
  /** Parts that are open (failed) for the whole chunk. */
  open?: string[];
  /**
   * Values in effect just before this chunk, for parts whose value changes at its start. The change is made
   * inside the chunk over a short edge (the parts' schedule hook) instead of as an abrupt initial condition,
   * so ngspice's time-step control handles it like any other fast edge.
   */
  from?: Record<string, number>;
  /** Repaired parts: open at the chunk start, reconnected over a short edge. */
  reconnect?: string[];
  /** Solver state to start from (null: a normal run from the DC operating point). */
  state?: ChunkState | null;
}

/** The project as one chunk sees it: interactive props set to this chunk's values, tran settings for the chunk. */
export function chunkProject(project: Project, o: ChunkOptions): Project {
  const comps = project.schematic.components.map((c) => {
    const it = getPart(c.type)?.interactive;
    if (!it || o.params?.[c.id] == null) return c;
    const v = o.params[c.id];
    return { ...c, props: { ...c.props, [it.prop]: it.kind === "slider" ? String(v) : v >= 0.5 } };
  });
  const tran = { ...project.simulation.tran, stop: siText(o.length), step: siText(o.step), start: undefined, uic: o.state ? true : project.simulation.tran.uic };
  return { ...project, schematic: { ...project.schematic, components: comps }, simulation: { ...project.simulation, analysis: "tran", tran } };
}

/** Run one chunk. The result's time axis is absolute circuit time (t0 + SPICE time). */
export async function runChunk(project: Project, engine: SpiceEngine, o: ChunkOptions): Promise<SimResult> {
  const p = chunkProject(project, o);
  const edge = edgeFor(o.step);
  const damage: Record<string, Damage[]> = {};
  for (const id of o.open ?? []) damage[id] = [{ t: 0, message: "", fix: "" }];
  for (const id of o.reconnect ?? []) damage[id] = [{ t: -1, repairedAt: edge, message: "", fix: "" }];
  const schedules = new Map<string, [number, number][]>();
  for (const [id, v] of Object.entries(o.params ?? {})) {
    const before = o.from?.[id];
    if (before != null && before !== v && o.state) schedules.set(id, [[o.t0, before], [o.t0 + edge, v]]); // absolute circuit time
  }
  const state = o.state ?? null;
  const r = await runSimulation(p, engine, "tran", { timeOffset: o.t0, schedules, damage, staticOpen: true, transform: (t) => applyInitialState(t, state) });
  if (r.ok && r.x && o.t0) r.x = { ...r.x, real: r.x.real.map((t) => t + o.t0) };
  return r;
}

/** Keep samples 0..k (inclusive) of a transient result. */
export function truncate(r: SimResult, k: number): SimResult {
  const cut = (v: Vector): Vector => ({ ...v, real: v.real.slice(0, k + 1), imag: v.imag?.slice(0, k + 1) });
  return { ...r, x: r.x && cut(r.x), vectors: r.vectors.map(cut) };
}

/** Drop samples before index k. */
export function dropBefore(r: SimResult, k: number): SimResult {
  if (k <= 0) return r;
  const cut = (v: Vector): Vector => ({ ...v, real: v.real.slice(k), imag: v.imag?.slice(k) });
  return { ...r, x: r.x && cut(r.x), vectors: r.vectors.map(cut) };
}

/**
 * Append chunk b to timeline a. b's first sample is the state a ended on (same time), so it is skipped.
 * Vectors are matched by name; a vector missing from one side is padded with NaN.
 */
export function splice(a: SimResult | null, b: SimResult): SimResult {
  if (!a?.x || !b.x) return b;
  const skip = b.x.real.length && a.x.real.length && b.x.real[0] <= a.x.real[a.x.real.length - 1] + 1e-15 ? 1 : 0;
  const na = a.x.real.length, nb = b.x.real.length - skip;
  const byName = new Map(b.vectors.map((v) => [v.name, v]));
  const seen = new Set<string>();
  const join = (va: Vector | undefined, vb: Vector | undefined, proto: Vector): Vector => ({
    ...proto,
    real: [...(va?.real ?? new Array(na).fill(NaN)), ...(vb ? vb.real.slice(skip) : new Array(nb).fill(NaN))],
  });
  const vectors = a.vectors.map((va) => { seen.add(va.name); return join(va, byName.get(va.name), { ...byName.get(va.name), ...va }); });
  for (const vb of b.vectors) if (!seen.has(vb.name)) vectors.push(join(undefined, vb, vb));
  return {
    ...b,
    x: { ...a.x, real: [...a.x.real, ...b.x.real.slice(skip)] },
    vectors,
    diagnostics: a.diagnostics, // the run's diagnostics stay put (a list that changed per chunk would make the panel jump)
    log: b.log,
    netlist: b.netlist,
  };
}

/** Last sample index with x ≤ t (a real solver timepoint); 0 when t is before the data. */
export function lastIndexAtOrBefore(x: ArrayLike<number>, t: number): number {
  let lo = 0, hi = x.length - 1;
  if (hi < 0) return -1;
  if (x[hi] <= t) return hi;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (x[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

/**
 * The restart point to use at or before sample k: the last sample where no node is in the middle of a fast edge
 * (no node moves by more than 25 % of its swing to, from or across a neighbouring sample). Some device state is not a node
 * (e.g. a switch model's hysteresis memory, used by the 555 latch); restarting inside an edge would reset it.
 * Edges last a few samples, so this steps back only slightly. Returns k when no quiet sample is found nearby.
 */
export function safeIndex(r: SimResult, k: number, lookBack = 400): number {
  const vs = r.vectors.filter((v) => v.kind === "voltage" && /^v\(/i.test(v.name) && !isHelper(v.name));
  const swing = vs.map((v) => { let lo = Infinity, hi = -Infinity; for (const y of v.real) { if (y < lo) lo = y; if (y > hi) hi = y; } return hi - lo; });
  const n = r.x!.real.length;
  const jumps = (a: number, b: number) => a >= 0 && b < n && vs.some((v, i) => swing[i] > 1e-6 && Math.abs(v.real[b] - v.real[a]) > 0.25 * swing[i]);
  for (let j = k; j > 1 && j >= k - lookBack; j--) {
    // inside an edge: a big step into or out of j, or across it (an edge spread over two steps)
    if (jumps(j - 1, j) || jumps(j, j + 1) || jumps(j - 1, j + 1) || (j + 1 >= n && jumps(j - 2, j))) continue;
    return j;
  }
  return k;
}

/** Simulate [0, total] in chunks of `length` (tests and tools; live mode drives chunks from the store). */
export async function simulateChunked(project: Project, engine: SpiceEngine, total: number, length: number, step: number): Promise<SimResult> {
  let acc: SimResult | null = null, state: ChunkState | null = null, t0 = 0;
  while (t0 < total - 1e-12) {
    const len = Math.min(length, total - t0);
    const r = await runChunk(project, engine, { t0, length: len, step, state });
    if (!r.ok || !r.x) return r;
    const last = r.x.real.length - 1;
    const k = t0 + len >= total - 1e-12 ? last : safeIndex(r, last);
    const piece = k < last ? truncate(r, k) : r;
    acc = splice(acc, piece);
    state = stateAt(r, k);
    t0 = state.t;
  }
  return acc!;
}
