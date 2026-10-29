// Component damage ("burnout") from simulation results.
//
// Rule: every rated quantity (ComponentDef.ratings) is passed through an exponential moving average with a
// time constant per kind (a crude thermal / dielectric memory), so a brief spike survives and a sustained
// overload fails. A part fails at the first time its average exceeds the limit; from then on it is
// modeled as an OPEN CIRCUIT (its first rated pin is disconnected through a switch), by re-simulating from 0 s.
// Real failures vary (parts can also short, degrade or survive); this is a teaching approximation.
import { computeConnectivity, type Connectivity } from "../core/connectivity";
import { getPart } from "../core/library";
import type { NetlistResult } from "../core/netlist";
import { formatSI, parseSI } from "../core/units";
import type { ComponentDef, ComponentInstance, Project, SimResult, Vector } from "../core/types";
import { elementsByComponent } from "./probes";

export type RatingKind = NonNullable<ComponentDef["ratings"]>[number]["kind"];

/** Averaging time constants in seconds, per kind. */
export const STRESS_TAU: Record<RatingKind, number> = {
  current: 0.01,           // semiconductor junctions heat in milliseconds
  power: 0.5,              // a resistor body takes a while to overheat
  voltage: 0.001,          // dielectric breakdown is fast, but nanosecond spikes don't count
  "reverse-voltage": 0.05, // electrolytic reverse polarity damages over tens of ms
};
/** Above this fraction of the limit the part shows a warning glow. */
export const WARN_FRACTION = 0.7;

const UNIT: Record<RatingKind, string> = { current: "A", power: "W", voltage: "V", "reverse-voltage": "V" };
const VERB: Record<RatingKind, string> = { current: "carried", power: "dissipated", voltage: "had", "reverse-voltage": "was reverse-biased by" };

/** A recorded failure: open from `t`, until `repairedAt` (if the user repaired it). */
export interface Damage { t: number; repairedAt?: number; message: string; fix: string }

/** Exponential moving average on a non-uniform time grid (y starts at the first value, or at 0 after `resetAt`). */
export function ema(x: ArrayLike<number>, v: ArrayLike<number>, tau: number, resetAt: number[] = []): Float64Array {
  const out = new Float64Array(x.length);
  let y = 0, r = 0;
  const resets = [...resetAt].sort((a, b) => a - b);
  for (let i = 0; i < x.length; i++) {
    if (i === 0) y = 0;
    else {
      const a = 1 - Math.exp(-Math.max(0, x[i] - x[i - 1]) / tau);
      y += a * (v[i] - y);
    }
    while (r < resets.length && resets[r] <= x[i]) { y = 0; r++; }
    out[i] = y;
  }
  return out;
}

/** First time the average exceeds the limit at or after `from` (null if never). Interpolated between samples. */
export function firstExceed(x: ArrayLike<number>, avg: ArrayLike<number>, limit: number, from = -Infinity): number | null {
  for (let i = 0; i < x.length; i++) {
    if (x[i] < from || avg[i] <= limit) continue;
    if (i === 0 || x[i - 1] < from || avg[i - 1] > limit) return x[i];
    const f = (limit - avg[i - 1]) / (avg[i] - avg[i - 1]);
    return x[i - 1] + f * (x[i] - x[i - 1]);
  }
  return null;
}

export interface StressTrack {
  componentId: string;
  ref: string;
  kind: RatingKind;
  limit: number;
  tau: number;
  /** Averaged stress / limit per sample (op: a single sample, not averaged). */
  ratio: Float64Array;
  /** Averaged stress in its unit per sample. */
  avg: Float64Array;
}

function limitOf(c: ComponentInstance, def: ComponentDef, r: NonNullable<ComponentDef["ratings"]>[number]): number {
  const raw = r.prop ? c.props[r.prop] ?? def.props.find((p) => p.key === r.prop)?.default : undefined;
  const v = raw == null || raw === "" ? NaN : parseSI(raw as string | number);
  return Number.isFinite(v) && v > 0 ? v : r.default;
}

/** Stress for every rated part in a result (transient: averaged series; op: the static value). */
export function stressTracks(project: Project, result: SimResult, damage: Record<string, Damage[]> = {}, conn: Connectivity = computeConnectivity(project)): StressTrack[] {
  if (!result.ok || (result.analysis !== "tran" && result.analysis !== "op")) return [];
  const n = result.analysis === "op" ? 1 : result.x?.real.length ?? 0;
  if (!n) return [];
  const x = result.analysis === "op" ? [0] : result.x!.real;
  const byNet = new Map<string, Vector>();
  for (const v of result.vectors) if (v.kind === "voltage" && v.netName) byNet.set(v.netName.toLowerCase(), v);
  const volt = (net: string | undefined): ArrayLike<number> | null => {
    if (!net) return null;
    if (net === "0") return new Float64Array(n);
    return byNet.get(net.toLowerCase())?.real ?? null;
  };
  const out: StressTrack[] = [];
  for (const c of project.schematic.components) {
    const def = getPart(c.type);
    if (!def?.ratings) continue;
    const cur = result.vectors.find((v) => v.kind === "current" && v.componentId === c.id)?.real;
    for (const r of def.ratings) {
      const [pa, pb] = r.pins ?? [def.pins[0]?.id, def.pins[1]?.id];
      const va = volt(conn.pinNet.get(`${c.id}:${pa}`)), vb = volt(conn.pinNet.get(`${c.id}:${pb}`));
      const raw = new Float64Array(n);
      let ok = true;
      for (let i = 0; i < n; i++) {
        const vd = va && vb ? va[i] - vb[i] : NaN;
        switch (r.kind) {
          case "current": if (!cur) ok = false; else raw[i] = Math.abs(cur[i]); break;
          case "power": if (!cur || !va || !vb) ok = false; else raw[i] = Math.abs(vd * cur[i]); break;
          case "voltage": if (!va || !vb) ok = false; else raw[i] = Math.abs(vd); break;
          case "reverse-voltage": if (!va || !vb) ok = false; else raw[i] = Math.max(0, -vd); break;
        }
        if (!ok) break;
      }
      if (!ok) continue;
      const tau = STRESS_TAU[r.kind];
      const limit = limitOf(c, def, r);
      const avg = result.analysis === "op" ? raw : ema(x, raw, tau, (damage[c.id] ?? []).flatMap((d) => (d.repairedAt != null ? [d.repairedAt] : [])));
      const ratio = new Float64Array(n);
      for (let i = 0; i < n; i++) ratio[i] = avg[i] / limit;
      out.push({ componentId: c.id, ref: c.ref, kind: r.kind, limit, tau, ratio, avg });
    }
  }
  return out;
}

/** Is the part failed (open) at time t according to its recorded damage? */
export function failedAt(d: Damage[] | undefined, t: number): Damage | undefined {
  return d?.find((x) => x.t <= t && (x.repairedAt == null || t < x.repairedAt));
}

/**
 * The earliest NEW failure in a transient result: a part whose average exceeds its limit after its last
 * recorded event (failure or repair). Parts already open at that time are skipped.
 */
export function detectFailure(project: Project, result: SimResult, damage: Record<string, Damage[]>, tracks = stressTracks(project, result, damage)):
  { componentId: string; t: number; damage: Damage } | null {
  if (result.analysis !== "tran" || !result.x) return null;
  const x = result.x.real;
  let best: { componentId: string; t: number; damage: Damage } | null = null;
  for (const tr of tracks) {
    const events = (damage[tr.componentId] ?? []).flatMap((d) => [d.t, d.repairedAt ?? -Infinity]);
    const from = events.length ? Math.max(...events) : -Infinity;
    const last = damage[tr.componentId]?.[damage[tr.componentId]!.length - 1];
    if (last && last.repairedAt == null) continue; // still open
    const t = firstExceed(x, tr.avg, tr.limit, from > -Infinity ? from + 1e-12 : -Infinity);
    if (t == null || (best && best.t <= t)) continue;
    best = { componentId: tr.componentId, t, damage: { t, ...damageText(project, tr, t) } };
  }
  return best;
}

export function damageText(project: Project, tr: Pick<StressTrack, "componentId" | "ref" | "kind" | "limit" | "tau">, t: number): { message: string; fix: string } {
  const c = project.schematic.components.find((x) => x.id === tr.componentId);
  const def = c && getPart(c.type);
  const u = UNIT[tr.kind];
  const over = `${formatSI(tr.limit * 1, u, 3)}`;
  const avgNote = `averaged over ${formatSI(tr.tau, "s")}`;
  const message = `${tr.ref} ${VERB[tr.kind]} more than its ${tr.kind === "reverse-voltage" ? "reverse-voltage limit" : "rating"} of ${over} (${avgNote}) and failed at ${formatSI(t, "s", 4)}. It is modeled as an open circuit after the failure; real failures vary (parts can also short or degrade).`;
  let fix: string;
  if (def?.id === "resistor") fix = `Use a resistor with a higher power rating, or a larger resistance so less power is dissipated (P = V²/R).`;
  else if (def?.id === "led") fix = `Add a series resistor: R ≈ (supply − Vf) / 15 mA, e.g. about 470 Ω on 9 V.`;
  else if (tr.kind === "current") fix = `Limit the current with a series resistor, or use a part rated for more current.`;
  else if (tr.kind === "reverse-voltage") fix = `Turn the electrolytic capacitor around (+ to the higher voltage) or use a non-polarized capacitor.`;
  else if (tr.kind === "voltage") fix = `Use a capacitor with a higher voltage rating (at least 1.5× the highest voltage it sees).`;
  else fix = `Use a part with a higher rating, or reduce the voltage or current.`;
  return { message, fix };
}

/**
 * Netlist rewrite that opens failed parts: the part's first rated pin is moved to an internal node joined
 * to its net by a switch that opens at each failure time (and closes again at a repair).
 */
export function applyFailures(netlist: string, nl: NetlistResult, project: Project, damage: Record<string, Damage[]>, edge = 1e-6): string {
  const ids = Object.keys(damage).filter((id) => damage[id]?.length);
  if (!ids.length) return netlist;
  const els = elementsByComponent(nl);
  const lines = netlist.split("\n");
  const extra: string[] = [];
  for (const id of ids) {
    const c = project.schematic.components.find((x) => x.id === id);
    const def = c && getPart(c.type);
    if (!c || !def) continue;
    const pins = def.ratings?.[0]?.pins ?? def.pins.map((p) => p.id);
    const net = pins.map((p) => nl.connectivity.pinNet.get(`${id}:${p}`)).find((x) => x && x !== "0");
    const names = new Set(els.get(id) ?? []);
    if (!net || !names.size) continue;
    const u = c.ref.replace(/[^A-Za-z0-9_]/g, "_");
    const inner = `sbf_${u}`;
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const tok = lines[i].trim().split(/\s+/);
      if (!names.has(tok[0]?.toLowerCase())) continue;
      for (const k of [1, 2]) if (tok[k] === net) { tok[k] = inner; touched = true; }
      lines[i] = tok.join(" ");
    }
    if (!touched) continue;
    const pts: [number, number][] = [[0, 1]];
    let last = 0;
    for (const d of [...damage[id]].sort((a, b) => a.t - b.t)) {
      const tf = Math.max(d.t, last + edge);
      pts.push([tf, 1], [tf + edge, 0]);
      last = tf + edge;
      if (d.repairedAt != null) { const tr = Math.max(d.repairedAt, last + edge); pts.push([tr, 0], [tr + edge, 1]); last = tr + edge; }
    }
    extra.push(`Ssbf_${u} ${net} ${inner} sbfc_${u} 0 SBF_SW`, `Vsbfc_${u} sbfc_${u} 0 PWL(${pts.map(([t, v]) => `${t.toExponential(9)} ${v}`).join(" ")})`);
  }
  if (!extra.length) return lines.join("\n");
  extra.push(".model SBF_SW SW(Ron=1m Roff=1e9 Vt=0.5 Vh=0)");
  const at = lines.findIndex((l) => /^\s*\.(op|tran|ac|dc|end)\b/i.test(l));
  lines.splice(at < 0 ? lines.length : at, 0, "* SparkBench: failed parts modeled as open circuits", ...extra);
  return lines.join("\n");
}

/** Rated parts whose current must be saved for stress (current and power ratings). */
export const needsCurrent = (def: ComponentDef | undefined) => !!def?.ratings?.some((r) => r.kind === "current" || r.kind === "power");
