// Schematic edits during a live run: value edits apply at once (continuing from the circuit's state), topology
// edits continue from the mapped state when every node still exists, otherwise the run restarts from 0 s.
import { computeConnectivity } from "../core/connectivity";
import { getPart } from "../core/library";
import { generateNetlist } from "../core/netlist";
import { formatSI, parseSI } from "../core/units";
import type { Diagnostic, Project } from "../core/types";
import type { ChunkState } from "./chunk";

/**
 * "props": only part values or model choices changed (same parts, positions, wires and labels), so the running
 * state carries over as is. "topology": parts, wires, labels, refs or placements changed. "none": nothing a
 * simulation sees changed (e.g. probes or analysis settings).
 */
export function classifyEdit(a: Project, b: Project): "none" | "props" | "topology" {
  const sa = a.schematic, sb = b.schematic;
  if (sa === sb && a.models === b.models) return "none";
  if (sa.wires !== sb.wires && JSON.stringify(sa.wires) !== JSON.stringify(sb.wires)) return "topology";
  if (sa.labels !== sb.labels && JSON.stringify(sa.labels) !== JSON.stringify(sb.labels)) return "topology";
  if (sa.components.length !== sb.components.length) return "topology";
  let props = a.models !== b.models;
  for (let i = 0; i < sa.components.length; i++) {
    const x = sa.components[i], y = sb.components[i];
    if (x === y) continue;
    if (x.id !== y.id || x.type !== y.type || x.ref !== y.ref || x.rotation !== y.rotation || !!x.mirror !== !!y.mirror
      || x.position.x !== y.position.x || x.position.y !== y.position.y) return "topology";
    if (x.modelId !== y.modelId || JSON.stringify(x.props) !== JSON.stringify(y.props)) props = true;
  }
  return props ? "props" : "none";
}

/** Short description of a value edit, e.g. "C1 → 22 µF" (several: "C1 → 22 µF, R2 → 4.7 kΩ"). */
export function describeEdit(a: Project, b: Project): string {
  const out: string[] = [];
  for (const y of b.schematic.components) {
    const x = a.schematic.components.find((c) => c.id === y.id);
    if (!x || x === y) continue;
    const def = getPart(y.type);
    for (const key of new Set([...Object.keys(x.props), ...Object.keys(y.props)])) {
      if (String(x.props[key] ?? "") === String(y.props[key] ?? "")) continue;
      const pd = def?.props.find((p) => p.key === key);
      const raw = y.props[key] ?? pd?.default ?? "";
      const v = pd?.kind === "number" ? parseSI(raw as string | number) : NaN;
      const shown = Number.isFinite(v) ? formatSI(v, pd?.unit ?? "", 3) : String(raw);
      out.push(`${y.ref}${pd && !["value", "position", "closed", "pressed"].includes(key) ? ` ${pd.label.toLowerCase()}` : ""} → ${shown}`);
    }
    if (x.modelId !== y.modelId) out.push(`${y.ref} → another model`);
  }
  return out.slice(0, 3).join(", ") + (out.length > 3 ? ", …" : "") || "circuit edited";
}

/** Values ngspice would not understand (they are never sent; the run keeps the last valid values). */
export function invalidValues(p: Project): Diagnostic[] {
  return generateNetlist(p, "tran").diagnostics.filter((d) => d.severity === "error");
}

/**
 * The running state of `old` expressed for `cur` after a topology edit, or null when some node of the old
 * state has no counterpart (the run then restarts from 0 s). Nets are matched through the part pins they
 * touch (auto names like N003 can change); nodes inside parts (subcircuit nodes "xu1.q", "vm_…", "…_int")
 * and inductor currents are kept when the new netlist still has them. New nodes start at 0 V.
 */
export function mapState(old: Project, cur: Project, state: ChunkState): ChunkState | null {
  const oc = computeConnectivity(old), nc = computeConnectivity(cur);
  const text = generateNetlist(cur, "tran").text.toLowerCase();
  const tokens = new Set(text.split(/[\s(),=]+/));
  const elements = new Set(text.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const nodes: Record<string, number> = {};
  for (const [name, v] of Object.entries(state.nodes)) {
    const net = oc.nets.find((n) => n.name.toLowerCase() === name);
    if (net) {
      let to: string | undefined;
      for (const p of net.pins) { to = nc.pinNet.get(`${p.componentId}:${p.pinId}`); if (to) break; }
      if (!to) for (const l of net.labelNames) { to = nc.nets.find((n) => n.labelNames.includes(l))?.name; if (to) break; }
      if (!to) return null;
      if (to !== "0") nodes[to.toLowerCase()] = v;
      continue;
    }
    // subcircuit node "xu1.q": its instance must still exist; other part-internal nodes by name
    if (name.includes(".") ? elements.has(name.split(".")[0]) : tokens.has(name)) {
      nodes[name] = v;
      continue;
    }
    // a node that belonged to a removed part
    return null;
  }
  const inductors: Record<string, number> = {};
  for (const [el, i] of Object.entries(state.inductors)) { if (!elements.has(el)) return null; inductors[el] = i; }
  return { t: state.t, nodes, inductors };
}
