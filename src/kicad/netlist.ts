// Reads netlists written by `kicad-cli sch export netlist` (kicadsexpr format) and compares
// KiCad's connectivity with SparkBench's, ignoring net names.
import { arg, child, children, parse } from "./sexpr";

export interface KicadNetNode { ref: string; pin: string; pinType?: string; pinFunction?: string }
export interface KicadNet { code: string; name: string; nodes: KicadNetNode[] }
export interface KicadComp { ref: string; value: string; footprint: string; libId: string; sheetPath: string; tstamps: string[]; fields: Record<string, string> }
export interface KicadNetlist { nets: KicadNet[]; components: KicadComp[] }

export function parseKicadNetlist(text: string): KicadNetlist {
  const root = parse(text);
  const comps = children(child(root, "components"), "comp").map((c) => {
    const ls = child(c, "libsource");
    const fields: Record<string, string> = {};
    for (const f of children(child(c, "fields"), "field")) fields[arg(child(f, "name")) ?? ""] = arg(f, 2) ?? "";
    for (const p of children(c, "property")) fields[arg(child(p, "name")) ?? ""] = arg(child(p, "value")) ?? "";
    return {
      ref: arg(child(c, "ref")) ?? "",
      value: arg(child(c, "value")) ?? "",
      footprint: arg(child(c, "footprint")) ?? "",
      libId: ls ? `${arg(child(ls, "lib")) ?? ""}:${arg(child(ls, "part")) ?? ""}` : "",
      sheetPath: arg(child(child(c, "sheetpath"), "tstamps")) ?? "",
      tstamps: children(c, "tstamps").flatMap((t) => t.items.slice(1).map((a) => (a.t === "atom" ? a.raw.replace(/"/g, "") : ""))),
      fields,
    };
  });
  const nets = children(child(root, "nets"), "net").map((n) => ({
    code: arg(child(n, "code")) ?? "",
    name: arg(child(n, "name")) ?? "",
    nodes: children(n, "node").map((d) => ({
      ref: arg(child(d, "ref")) ?? "", pin: arg(child(d, "pin")) ?? "",
      pinType: arg(child(d, "pintype")), pinFunction: arg(child(d, "pinfunction")),
    })),
  }));
  return { nets, components: comps };
}

/** KiCad connectivity as sorted "REF:pin" groups, power/flag symbols (#…) dropped. */
export function kicadPartition(nl: KicadNetlist): string[][] {
  const out: string[][] = [];
  for (const n of nl.nets) {
    const nodes = [...new Set(n.nodes.filter((d) => !d.ref.startsWith("#")).map((d) => `${d.ref}:${d.pin}`))].sort();
    if (nodes.length) out.push(nodes);
  }
  return out;
}

// ------------------------------------------------------------------ SPICE netlist (kicad-cli --format spice)

export interface SpiceElement { name: string; nodes: string[] }

/** Element lines of a KiCad-written SPICE netlist (continuation lines joined, directives skipped). */
export function parseSpiceNetlist(text: string): SpiceElement[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("+") && lines.length) lines[lines.length - 1] += " " + raw.slice(1);
    else lines.push(raw);
  }
  const out: SpiceElement[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith("*") || t.startsWith(".")) continue;
    const tok = t.split(/\s+/);
    const kind = tok[0][0].toUpperCase();
    const count = kind === "Q" ? 3 : kind === "M" ? 4 : kind === "J" ? 3 : kind === "E" || kind === "G" ? 4 : kind === "X" ? -1 : 2;
    if (count < 0) {
      // Subcircuit: nodes run until the subcircuit name (last bare token before params).
      const params = tok.findIndex((x, i) => i > 0 && x.includes("="));
      const end = params < 0 ? tok.length - 1 : params - 1;
      out.push({ name: tok[0], nodes: tok.slice(1, end) });
    } else out.push({ name: tok[0], nodes: tok.slice(1, 1 + count) });
  }
  return out;
}

/** SPICE node order for a device, in model pin names (KiCad's Sim.Pins maps symbol pins to these). */
const MODEL_PIN_ORDER: Record<string, string[]> = {
  V: ["+", "-"], I: ["+", "-"], D: ["A", "K"], NPN: ["C", "B", "E"], PNP: ["C", "B", "E"],
  NMOS: ["D", "G", "S", "B"], PMOS: ["D", "G", "S", "B"], NJFET: ["D", "G", "S"], PJFET: ["D", "G", "S"],
};

export interface SimOnlyPart { ref: string; device: string; simPins: string }

/**
 * KiCad's connectivity from both of its netlists: the board netlist leaves out symbols with
 * on_board=no (simulation sources), the SPICE netlist covers those. Both come from the same
 * KiCad connectivity, so merging groups that share a pin is exact.
 */
export function mergedKicadPartition(board: KicadNetlist, spice: SpiceElement[] | null, simOnly: SimOnlyPart[]): string[][] {
  const parent = new Map<string, string>();
  const find = (a: string): string => { let r = a; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(a, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const nodes = new Set<string>();
  for (const n of board.nets) for (const d of n.nodes) {
    if (d.ref.startsWith("#")) continue;
    const k = `${d.ref}:${d.pin}`;
    nodes.add(k); find(k); union(k, `board:${n.name}`);
  }
  for (const p of simOnly) {
    const el = spice?.find((e) => e.name === p.ref || e.name.toUpperCase() === p.ref.toUpperCase());
    if (!el) continue;
    const pairs = p.simPins.trim().split(/\s+/).map((s) => s.split("=")).filter((x) => x.length === 2);
    const order = MODEL_PIN_ORDER[p.device.toUpperCase()] ?? pairs.map(([, m]) => m);
    order.forEach((modelPin, i) => {
      const symPin = pairs.find(([, m]) => m === modelPin)?.[0];
      if (!symPin || el.nodes[i] === undefined) return;
      const k = `${p.ref}:${symPin}`;
      nodes.add(k); find(k); union(k, `spice:${el.nodes[i]}`);
    });
  }
  // KiCad writes board net names into SPICE with characters outside [A-Za-z0-9_/+.-] replaced by "_"
  // ("Net-(R1-Pad1)" → "Net-_R1-Pad1_"). A name mismatch can only split groups (reported), never merge them.
  for (const n of board.nets) union(`board:${n.name}`, `spice:${spiceNetName(n.name)}`);
  const groups = new Map<string, string[]>();
  for (const k of nodes) { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(k); }
  return [...groups.values()].map((g) => g.sort());
}

export const spiceNetName = (n: string) => n.replace(/[^A-Za-z0-9_/+.-]/g, "_");

export interface NetCompare {
  equal: boolean;
  /** Groups present in SparkBench but split or merged differently in KiCad. */
  onlyInSparkbench: string[][];
  onlyInKicad: string[][];
}

const canon = (p: string[][]) => p.map((g) => [...g].sort()).map((g) => g.join(" ")).sort();

export function comparePartitions(expected: string[][], actual: string[][]): NetCompare {
  const e = canon(expected), a = canon(actual);
  const es = new Set(e), as = new Set(a);
  const onlyInSparkbench = e.filter((g) => !as.has(g)).map((g) => g.split(" "));
  const onlyInKicad = a.filter((g) => !es.has(g)).map((g) => g.split(" "));
  return { equal: !onlyInSparkbench.length && !onlyInKicad.length, onlyInSparkbench, onlyInKicad };
}
