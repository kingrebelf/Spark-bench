// Turns placed parts, wires and labels into nets.
// Rules (documented in docs/project-format.md):
//  - Wire vertices and pin tips are connection points.
//  - A point lying on a wire segment joins that wire (T-junction). Crossing wires
//    without a shared point do NOT connect.
//  - Labels join the point they sit on; labels with the same name join each other.
//  - Every ground symbol's pin is net "0".
import { getPart } from "./library";
import { keyOf, onSegment, pinWorldPosition } from "./geometry";
import type { ComponentDef, ComponentInstance, Point, Project } from "./types";

export interface PinRef { componentId: string; pinId: string }
export interface Net {
  /** SPICE node name: "0" for ground, sanitized label name, or N### auto name. */
  name: string;
  pins: PinRef[];
  wireIds: string[];
  labelNames: string[];
  points: Point[];
  isGround: boolean;
}
export interface Connectivity {
  nets: Net[];
  /** "componentId:pinId" -> net name */
  pinNet: Map<string, string>;
  /** point key -> net name, for probing a wire/pin location */
  pointNet: Map<string, string>;
  /** Points where 3+ connections meet (junction dots). */
  junctions: Point[];
  unknownParts: ComponentInstance[];
}

class DSU {
  parent = new Map<string, string>();
  find(a: string): string {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let r = a;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = a;
    while (c !== r) { const n = this.parent.get(c)!; this.parent.set(c, r); c = n; }
    return r;
  }
  union(a: string, b: string) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

export function sanitizeNetName(name: string): string {
  const s = name.trim().replace(/[^A-Za-z0-9_+\-.]/g, "_");
  if (!s || s === "0" || /^gnd$/i.test(s)) return s ? "0" : "_";
  return s;
}

export function computeConnectivity(project: Project, lookup: (id: string) => ComponentDef | undefined = getPart): Connectivity {
  const { components, wires, labels } = project.schematic;
  const dsu = new DSU();
  const degree = new Map<string, number>();
  const bump = (k: string, n = 1) => degree.set(k, (degree.get(k) ?? 0) + n);
  const unknownParts: ComponentInstance[] = [];

  // Collect all candidate points (pins, wire vertices, labels) for T-junction tests.
  const pinPoints: { key: string; p: Point; ref: PinRef; ground: boolean }[] = [];
  for (const c of components) {
    const def = lookup(c.type);
    if (!def) { unknownParts.push(c); continue; }
    if (def.role === "netlabel") continue;
    for (const pin of def.pins) {
      const p = pinWorldPosition(c, def, pin.id)!;
      pinPoints.push({ key: keyOf(p), p, ref: { componentId: c.id, pinId: pin.id }, ground: def.role === "ground" });
    }
  }
  const allPoints: Point[] = [...pinPoints.map((x) => x.p), ...labels.map((l) => l.position)];
  for (const w of wires) allPoints.push(...w.points);

  for (const w of wires) {
    for (let i = 0; i < w.points.length; i++) {
      const k = keyOf(w.points[i]);
      dsu.find(k);
      if (i > 0) dsu.union(k, keyOf(w.points[i - 1]));
      // endpoints count as one connection; interior bends count as two (pass-through)
      bump(k, i === 0 || i === w.points.length - 1 ? 1 : 2);
    }
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1], b = w.points[i];
      for (const p of allPoints) {
        const k = keyOf(p);
        if (k === keyOf(a) || k === keyOf(b)) continue;
        if (onSegment(p, a, b)) { dsu.union(k, keyOf(a)); bump(k, 2); }
      }
    }
  }
  for (const pp of pinPoints) { dsu.find(pp.key); bump(pp.key); }
  const GROUND = "__ground__";
  for (const pp of pinPoints) if (pp.ground) dsu.union(pp.key, GROUND);
  const labelRoot = new Map<string, string>();
  for (const l of labels) {
    const k = keyOf(l.position);
    dsu.find(k);
    const nm = sanitizeNetName(l.name);
    if (nm === "0") { dsu.union(k, GROUND); continue; }
    const prev = labelRoot.get(nm);
    if (prev) dsu.union(k, prev); else labelRoot.set(nm, k);
  }

  // Group by root.
  const groups = new Map<string, { keys: Set<string>; pins: PinRef[]; wireIds: Set<string>; labels: Set<string>; ground: boolean }>();
  const g = (root: string) => {
    let e = groups.get(root);
    if (!e) { e = { keys: new Set(), pins: [], wireIds: new Set(), labels: new Set(), ground: false }; groups.set(root, e); }
    return e;
  };
  const groundRoot = dsu.parent.has(GROUND) ? dsu.find(GROUND) : undefined;
  for (const pp of pinPoints) { const e = g(dsu.find(pp.key)); e.pins.push(pp.ref); e.keys.add(pp.key); }
  for (const w of wires) { const e = g(dsu.find(keyOf(w.points[0]))); e.wireIds.add(w.id); for (const p of w.points) e.keys.add(keyOf(p)); }
  for (const l of labels) { const e = g(dsu.find(keyOf(l.position))); e.labels.add(l.name); e.keys.add(keyOf(l.position)); }
  if (groundRoot && groups.has(groundRoot)) groups.get(groundRoot)!.ground = true;

  // Name nets deterministically: ground, labels, then N001.. ordered by first pin.
  const nets: Net[] = [];
  const used = new Set<string>(["0"]);
  let auto = 1;
  const ordered = [...groups.values()].sort((a, b) => [...a.keys][0].localeCompare([...b.keys][0]));
  for (const e of ordered) {
    let name: string;
    if (e.ground) name = "0";
    else {
      const lbl = [...e.labels].map(sanitizeNetName).filter((n) => n !== "0").sort()[0];
      if (lbl && !used.has(lbl)) name = lbl;
      else { do { name = `N${String(auto++).padStart(3, "0")}`; } while (used.has(name)); }
    }
    used.add(name);
    nets.push({
      name, pins: e.pins, wireIds: [...e.wireIds], labelNames: [...e.labels], isGround: e.ground,
      points: [...e.keys].map((k) => { const [x, y] = k.split(",").map(Number); return { x, y }; }),
    });
  }
  const pinNet = new Map<string, string>();
  const pointNet = new Map<string, string>();
  for (const n of nets) {
    for (const p of n.pins) pinNet.set(`${p.componentId}:${p.pinId}`, n.name);
    for (const p of n.points) pointNet.set(keyOf(p), n.name);
  }
  const junctions: Point[] = [];
  for (const [k, d] of degree) if (d >= 3) { const [x, y] = k.split(",").map(Number); junctions.push({ x, y }); }
  return { nets, pinNet, pointNet, junctions, unknownParts };
}
