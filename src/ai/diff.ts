// What a proposal changes: parts added/removed/changed and connectivity changes, computed from the
// actual before/after projects (not from what the model claims), so the review shows the truth.
import { computeConnectivity } from "../core/connectivity";
import { getPart } from "../core/library";
import type { ComponentDef, ComponentInstance, Project } from "../core/types";

type Lookup = (id: string) => ComponentDef | undefined;

export interface PropChange { key: string; label: string; from: string | null; to: string | null }
export interface PartChange {
  ref: string;
  type: string;
  name: string;
  kind: "added" | "removed" | "changed";
  props: PropChange[];
}
export interface NetChange {
  /** Display name: the proposal's net name when known, else the schematic's. */
  name: string;
  kind: "added" | "removed" | "changed";
  /** Pins (REF.PIN) that join this net / leave it. For "added", all pins; for "removed", all former pins. */
  joined: string[];
  left: string[];
}
export interface PinMove {
  pin: string;
  kind: "connected" | "disconnected" | "moved";
  from: string | null;
  to: string | null;
}
export interface ProposalDiff {
  parts: PartChange[];
  nets: NetChange[];
  /** Existing pins whose connections change. "disconnected" ones are highlighted in the review. */
  pinMoves: PinMove[];
  empty: boolean;
}

const fmt = (v: unknown) => (v === undefined || v === null ? null : String(v));

interface Side { netOf: Map<string, string>; members: Map<string, Set<string>>; ground: Set<string>; byRef: Map<string, ComponentInstance> }

function side(project: Project, lookup: Lookup): Side {
  const conn = computeConnectivity(project, lookup);
  const netOf = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  const byRef = new Map<string, ComponentInstance>();
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    if (!def || def.role) continue;
    byRef.set(c.ref, c);
    for (const pin of def.pins) {
      const pr = `${c.ref}.${pin.id}`;
      const net = conn.pinNet.get(`${c.id}:${pin.id}`) ?? `(unconnected ${pr})`;
      netOf.set(pr, net);
      (members.get(net) ?? members.set(net, new Set()).get(net)!).add(pr);
    }
  }
  return { netOf, members, ground: new Set(conn.nets.filter((n) => n.isGround).map((n) => n.name)), byRef };
}

/**
 * @param displayNames optional map from the proposed project's net names to friendlier names
 *                     (the proposal's net names; see LayoutResult.netNames, inverted).
 */
export function computeDiff(before: Project, after: Project, lookup: Lookup = getPart, displayNames?: Map<string, string>): ProposalDiff {
  const A = side(before, lookup), B = side(after, lookup);
  const show = (n: string) => displayNames?.get(n) ?? n;

  const parts: PartChange[] = [];
  for (const [ref, c] of B.byRef) {
    const def = lookup(c.type)!;
    const old = A.byRef.get(ref);
    if (!old) {
      parts.push({ ref, type: c.type, name: def.name, kind: "added",
        props: def.props.map((p) => ({ key: p.key, label: p.label, from: null, to: fmt(c.props[p.key] ?? p.default) })) });
      continue;
    }
    const props: PropChange[] = [];
    for (const p of def.props) {
      const from = fmt(old.props[p.key] ?? p.default), to = fmt(c.props[p.key] ?? p.default);
      if (from !== to) props.push({ key: p.key, label: p.label, from, to });
    }
    for (const k of ["footprint", "symbol"] as const) {
      const from = fmt(old.kicad?.[k]), to = fmt(c.kicad?.[k]);
      if (from !== to) props.push({ key: `kicad.${k}`, label: `KiCad ${k}`, from, to });
    }
    if (props.length) parts.push({ ref, type: c.type, name: def.name, kind: "changed", props });
  }
  for (const [ref, c] of A.byRef) {
    if (B.byRef.has(ref)) continue;
    parts.push({ ref, type: c.type, name: lookup(c.type)?.name ?? c.type, kind: "removed", props: [] });
  }

  // Pins of parts that exist on both sides.
  const shared = [...A.netOf.keys()].filter((p) => B.netOf.has(p));
  const sharedSet = new Set(shared);
  const mates = (s: Side, pin: string) => {
    const net = s.netOf.get(pin)!;
    const m = [...s.members.get(net)!].filter((x) => x !== pin && sharedSet.has(x)).sort();
    return { key: `${s.ground.has(net) ? "G|" : ""}${m.join(",")}`, alone: m.length === 0 && !s.ground.has(net) && s.members.get(net)!.size === 1, net };
  };
  const pinMoves: PinMove[] = [];
  for (const pin of shared) {
    const a = mates(A, pin), b = mates(B, pin);
    if (a.key === b.key) continue;
    if (!a.alone && b.alone) pinMoves.push({ pin, kind: "disconnected", from: a.net, to: null });
    else if (a.alone && !b.alone) pinMoves.push({ pin, kind: "connected", from: null, to: show(b.net) });
    else pinMoves.push({ pin, kind: "moved", from: a.net, to: show(b.net) });
  }

  // Net-level changes: match each new net to the old net it overlaps most.
  const nets: NetChange[] = [];
  const matchedOld = new Set<string>();
  for (const [bn, bPins] of B.members) {
    if (bPins.size < 2 && !B.ground.has(bn)) continue;
    let best: string | null = null, bestN = 0;
    for (const p of bPins) {
      const an = A.netOf.get(p);
      if (!an) continue;
      const n = [...A.members.get(an)!].filter((x) => bPins.has(x)).length;
      if (n > bestN) { best = an; bestN = n; }
    }
    if (!best || (A.members.get(best)!.size < 2 && !A.ground.has(best))) {
      nets.push({ name: show(bn), kind: "added", joined: [...bPins].sort(), left: [] });
      if (best) matchedOld.add(best);
      continue;
    }
    matchedOld.add(best);
    const aPins = A.members.get(best)!;
    const joined = [...bPins].filter((p) => !aPins.has(p)).sort();
    const left = [...aPins].filter((p) => !bPins.has(p)).sort();
    if (joined.length || left.length) nets.push({ name: show(bn), kind: "changed", joined, left });
  }
  for (const [an, aPins] of A.members) {
    if (matchedOld.has(an) || aPins.size < 2) continue;
    nets.push({ name: an, kind: "removed", joined: [], left: [...aPins].sort() });
  }

  return { parts, nets, pinMoves, empty: !parts.length && !nets.length && !pinMoves.length };
}
