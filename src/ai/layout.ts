// Turns a validated, net-based proposal into a placed and wired schematic.
//
// Strategy (correctness first, then readability):
//  1. Existing parts keep their ids and positions. Existing wiring is kept wherever the proposal
//     keeps that net intact; nets that must be split are unwired and rebuilt.
//  2. New parts are placed left-to-right in "signal flow" columns (breadth-first from the sources).
//  3. Every pin that needs a connection gets a short stub. Nets made only of new pins are drawn as
//     orthogonal wires when a collision-free route exists; otherwise every member gets a net label.
//     Ground pins get ground symbols.
//  4. Connectivity is recomputed and compared with the proposal's nets (as pin partitions). If the
//     pretty layout is wrong in any way, a labels-only layout (labels placed exactly on pin tips) is
//     tried; if that is also wrong the result is an error, never a silently different circuit.
import { computeConnectivity } from "../core/connectivity";
import { keyOf, onSegment, pinWorldPosition, transformPoint } from "../core/geometry";
import { getPart } from "../core/library";
import { newId } from "../core/project";
import type { ComponentDef, ComponentInstance, Diagnostic, Point, Project, Rotation, Shape } from "../core/types";
import type { Proposal, ResolvedNet } from "./proposal";

type Lookup = (id: string) => ComponentDef | undefined;

export interface LayoutResult {
  ok: boolean;
  project: Project;
  /** proposal ref -> component id in `project` */
  refToId: Map<string, string>;
  /** proposal net name -> net name ngspice will use in `project` */
  netNames: Map<string, string>;
  /** "wired": stubs, wires and labels; "labels": fallback with labels on pin tips. */
  style: "wired" | "labels";
  diagnostics: Diagnostic[];
}

interface Box { x0: number; y0: number; x1: number; y1: number }

export function shapeBounds(shapes: Shape[], pins: Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of pins) add(p.x, p.y);
  for (const s of shapes) {
    if (s.kind === "line") { add(s.x1, s.y1); add(s.x2, s.y2); }
    else if (s.kind === "rect") { add(s.x, s.y); add(s.x + s.w, s.y + s.h); }
    else if (s.kind === "circle") { add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r); }
    else if (s.kind === "polyline") s.points.forEach((p) => add(p.x, p.y));
    else if (s.kind === "arc") { add(Math.min(s.x1, s.x2) - s.r, Math.min(s.y1, s.y2) - s.r); add(Math.max(s.x1, s.x2) + s.r, Math.max(s.y1, s.y2) + s.r); }
    else if (s.kind === "text") add(s.x, s.y);
  }
  if (!Number.isFinite(x0)) return { x0: -1, y0: -1, x1: 1, y1: 1 };
  return { x0, y0, x1, y1 };
}

/** World-space bounding box of a placed instance (rotation/mirror applied). */
export function instanceBox(inst: ComponentInstance, def: ComponentDef): Box {
  const b = shapeBounds(def.symbol, def.pins);
  const corners = [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x0, y: b.y1 }, { x: b.x1, y: b.y1 }]
    .map((p) => transformPoint(p, inst.rotation, inst.mirror));
  return {
    x0: inst.position.x + Math.min(...corners.map((c) => c.x)), y0: inst.position.y + Math.min(...corners.map((c) => c.y)),
    x1: inst.position.x + Math.max(...corners.map((c) => c.x)), y1: inst.position.y + Math.max(...corners.map((c) => c.y)),
  };
}

/** Direction a stub leaves a pin: away from the part's origin along the dominant axis. */
function stubDir(inst: ComponentInstance, def: ComponentDef, pinId: string): Point {
  const pin = def.pins.find((p) => p.id === pinId)!;
  const t = transformPoint(pin, inst.rotation, inst.mirror);
  if (t.x === 0 && t.y === 0) return { x: 0, y: 1 };
  if (Math.abs(t.x) >= Math.abs(t.y)) return { x: Math.sign(t.x), y: 0 };
  return { x: 0, y: Math.sign(t.y) };
}

/** Ground symbol rotation so its body points along `dir` (the symbol hangs downward at 0°). */
function groundRotation(dir: Point): Rotation {
  if (dir.y < 0) return 180;
  if (dir.x > 0) return 270;
  if (dir.x < 0) return 90;
  return 0;
}

const SOURCE_LIKE = (def: ComponentDef) => def.category === "Sources" || /^[VI]$/.test(def.refPrefix);

/** Pin-partition signature: for every non-role pin, which group it is in. Used to verify layouts. */
export function pinPartition(project: Project, lookup: Lookup = getPart): Map<string, string> {
  const conn = computeConnectivity(project, lookup);
  const out = new Map<string, string>();
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    if (!def || def.role) continue;
    for (const pin of def.pins) out.set(`${c.ref}.${pin.id}`, conn.pinNet.get(`${c.id}:${pin.id}`) ?? `__nc_${c.id}_${pin.id}`);
  }
  return out;
}

/** Compare an actual pin->net map with the proposal's nets. Returns human-readable mismatches. */
export function comparePartition(actual: Map<string, string>, nets: ResolvedNet[]): string[] {
  const problems: string[] = [];
  const desired = new Map<string, string>();
  for (const n of nets) for (const p of n.pins) desired.set(`${p.ref}.${p.pinId}`, n.name);
  const actualToDesired = new Map<string, string>();
  for (const n of nets) {
    const actualNets = new Set(n.pins.map((p) => actual.get(`${p.ref}.${p.pinId}`)));
    if (actualNets.size > 1) problems.push(`net ${n.name} is split into ${actualNets.size} pieces`);
    for (const a of actualNets) {
      if (a === undefined) { problems.push(`net ${n.name} has a pin that was not placed`); continue; }
      const prev = actualToDesired.get(a);
      if (prev && prev !== n.name) problems.push(`nets ${prev} and ${n.name} are shorted together`);
      actualToDesired.set(a, n.name);
    }
    if (n.ground && n.pins.length && actual.get(`${n.pins[0].ref}.${n.pins[0].pinId}`) !== "0") problems.push(`net ${n.name} is not connected to ground`);
  }
  for (const [pin, a] of actual) {
    if (desired.has(pin)) continue;
    const d = actualToDesired.get(a);
    if (d) problems.push(`${pin} should be unconnected but is on net ${d}`);
    else if ([...actual.values()].filter((x) => x === a).length > 1) problems.push(`${pin} should be unconnected but touches other pins`);
  }
  return [...new Set(problems)];
}

interface Obstacles {
  /** point key -> owner (net index, or -1 for "someone else") */
  points: Map<string, number>;
  segments: { a: Point; b: Point; owner: number }[];
  boxes: Box[];
}

function segHitsBox(a: Point, b: Point, bx: Box): boolean {
  // Orthogonal segments only; test against the box shrunk by 0.5 so touching an edge is allowed.
  const x0 = bx.x0 + 0.5, x1 = bx.x1 - 0.5, y0 = bx.y0 + 0.5, y1 = bx.y1 - 0.5;
  if (x0 >= x1 || y0 >= y1) return false;
  const sx0 = Math.min(a.x, b.x), sx1 = Math.max(a.x, b.x), sy0 = Math.min(a.y, b.y), sy1 = Math.max(a.y, b.y);
  return sx1 > x0 && sx0 < x1 && sy1 > y0 && sy0 < y1;
}

function pathClear(path: Point[], owner: number, ob: Obstacles): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    for (const [k, o] of ob.points) {
      if (o === owner) continue;
      const [x, y] = k.split(",").map(Number);
      if (onSegment({ x, y }, a, b)) return false;
    }
    for (const bx of ob.boxes) if (segHitsBox(a, b, bx)) return false;
  }
  for (const v of path) {
    for (const s of ob.segments) if (s.owner !== owner && onSegment(v, s.a, s.b)) return false;
  }
  return true;
}

function addPath(path: Point[], owner: number, ob: Obstacles) {
  for (const p of path) ob.points.set(keyOf(p), owner);
  for (let i = 1; i < path.length; i++) ob.segments.push({ a: path[i - 1], b: path[i], owner });
}

/** Orthogonal route candidates between two points: straight, one bend, then Z-shapes and detours. */
function routes(a: Point, b: Point): Point[][] {
  const out: Point[][] = [];
  if (a.x === b.x || a.y === b.y) out.push([a, b]);
  else out.push([a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b]);
  const mx = Math.round((a.x + b.x) / 2), my = Math.round((a.y + b.y) / 2);
  for (const d of [0, -2, 2, -4, 4]) {
    if (a.y !== b.y) out.push([a, { x: mx + d, y: a.y }, { x: mx + d, y: b.y }, b]);
    if (a.x !== b.x) out.push([a, { x: a.x, y: my + d }, { x: b.x, y: my + d }, b]);
  }
  for (const d of [2, 4, 6]) {
    const top = Math.min(a.y, b.y) - d, bottom = Math.max(a.y, b.y) + d;
    out.push([a, { x: a.x, y: top }, { x: b.x, y: top }, b], [a, { x: a.x, y: bottom }, { x: b.x, y: bottom }, b]);
  }
  // Drop zero-length segments and duplicate consecutive points.
  return out.map((p) => p.filter((q, i) => i === 0 || q.x !== p[i - 1].x || q.y !== p[i - 1].y)).filter((p) => p.length >= 2);
}

/**
 * Build the proposed project from `base` and a checked proposal. `nets` comes from checkProposal().
 * `base` is not modified.
 */
export function layoutProposal(base: Project, proposal: Proposal, nets: ResolvedNet[], lookup: Lookup = getPart): LayoutResult {
  const first = buildOnce(base, proposal, nets, lookup, "wired");
  if (first.ok) return first;
  const second = buildOnce(base, proposal, nets, lookup, "labels");
  if (second.ok) return second;
  return { ...first, diagnostics: [...first.diagnostics, ...second.diagnostics] };
}

function buildOnce(base: Project, proposal: Proposal, nets: ResolvedNet[], lookup: Lookup, style: "wired" | "labels"): LayoutResult {
  const project: Project = structuredClone(base);
  const sch = project.schematic;
  const removeRefs = new Set(proposal.remove);
  const refToId = new Map<string, string>();

  // --- 1. remove parts, remembering where their pins were (to clean up the wires left behind)
  const removedPinKeys = new Set<string>();
  sch.components = sch.components.filter((c) => {
    const def = lookup(c.type);
    if (!def || def.role || !removeRefs.has(c.ref)) return true;
    for (const pin of def.pins) removedPinKeys.add(keyOf(pinWorldPosition(c, def, pin.id)!));
    return false;
  });

  // --- 2. update kept parts, create new ones (unplaced)
  const byRef = new Map(sch.components.filter((c) => !lookup(c.type)?.role).map((c) => [c.ref, c]));
  const newParts: ComponentInstance[] = [];
  for (const part of proposal.parts) {
    const def = lookup(part.type)!;
    let inst = byRef.get(part.ref);
    if (!inst) {
      inst = { id: newId("c"), type: part.type, ref: part.ref, position: { x: 0, y: 0 }, rotation: 0, props: {} };
      for (const pd of def.props) inst.props[pd.key] = pd.default;
      newParts.push(inst);
    }
    for (const kv of part.values) inst.props[kv.key] = kv.value;
    if (part.kicadFootprint !== null || part.kicadSymbol !== null) {
      inst.kicad = { ...inst.kicad };
      if (part.kicadFootprint !== null) inst.kicad.footprint = part.kicadFootprint;
      if (part.kicadSymbol !== null) inst.kicad.symbol = part.kicadSymbol;
    }
    refToId.set(part.ref, inst.id);
  }

  // Desired net index for each "componentId:pinId".
  const desired = new Map<string, number>();
  nets.forEach((n, i) => { for (const p of n.pins) desired.set(`${refToId.get(p.ref)}:${p.pinId}`, i); });

  // --- 3. existing nets: keep intact ones, unwire the ones the proposal changes
  const conn = computeConnectivity(project, lookup);
  const instById = new Map(sch.components.map((c) => [c.id, c]));
  const deadWires = new Set<string>();
  const deadPoints = new Set<string>();
  const deadComps = new Set<string>();
  /** desired index -> intact existing groups (their connection points) */
  const groups = new Map<number, { points: Point[]; isGround: boolean; labels: string[] }[]>();
  const freePins: { inst: ComponentInstance; pinId: string; net: number }[] = [];
  const occupiedLabels = new Map<string, number>();
  const wireOwner = new Map<string, number>();

  for (const e of conn.nets) {
    const simPins = e.pins.filter((p) => !lookup(instById.get(p.componentId)!.type)?.role);
    const roleComps = e.pins.filter((p) => lookup(instById.get(p.componentId)!.type)?.role).map((p) => p.componentId);
    const targets = new Set(simPins.map((p) => desired.get(`${p.componentId}:${p.pinId}`) ?? `nc:${p.componentId}:${p.pinId}`));
    const unwire = () => {
      e.wireIds.forEach((w) => deadWires.add(w));
      e.points.forEach((p) => deadPoints.add(keyOf(p)));
      roleComps.forEach((id) => deadComps.add(id));
    };
    if (simPins.length === 0) {
      if (e.points.some((p) => removedPinKeys.has(keyOf(p)))) unwire();
      continue;
    }
    const target = [...targets][0];
    const broken = targets.size > 1 || typeof target === "string" && simPins.length > 1
      || (typeof target === "number" && e.isGround && !nets[target].ground);
    const bare = e.wireIds.length === 0 && e.labelNames.length === 0 && roleComps.length === 0 && simPins.length === 1;
    if (broken || bare) {
      if (broken) unwire();
      for (const p of simPins) {
        const net = desired.get(`${p.componentId}:${p.pinId}`);
        if (net !== undefined) freePins.push({ inst: instById.get(p.componentId)!, pinId: p.pinId, net });
      }
      continue;
    }
    if (typeof target !== "number") continue; // an unconnected-by-design pin with its own wiring: leave it
    const pts = e.points.filter((p) => !removedPinKeys.has(keyOf(p)));
    (groups.get(target) ?? groups.set(target, []).get(target)!).push({ points: pts, isGround: e.isGround, labels: e.labelNames });
    for (const l of e.labelNames) occupiedLabels.set(l.toLowerCase(), target);
    for (const w of e.wireIds) wireOwner.set(w, target);
  }
  sch.wires = sch.wires.filter((w) => !deadWires.has(w.id));
  sch.labels = sch.labels.filter((l) => !deadPoints.has(keyOf(l.position)));
  sch.components = sch.components.filter((c) => !deadComps.has(c.id));

  // --- 4. place new parts in signal-flow columns to the right of the existing drawing
  for (const inst of newParts) {
    const def = lookup(inst.type)!;
    for (const pin of def.pins) {
      const net = desired.get(`${inst.id}:${pin.id}`);
      if (net !== undefined) freePins.push({ inst, pinId: pin.id, net });
    }
  }
  placeNewParts(project, newParts, nets, lookup);
  sch.components.push(...newParts);

  // --- 5. connect
  const ob: Obstacles = { points: new Map(), segments: [], boxes: [] };
  for (const c of sch.components) {
    const def = lookup(c.type);
    if (!def) continue;
    if (!def.role) ob.boxes.push(instanceBox(c, def));
    for (const pin of def.pins) {
      const k = keyOf(pinWorldPosition(c, def, pin.id)!);
      ob.points.set(k, desired.get(`${c.id}:${pin.id}`) ?? -1);
    }
  }
  for (const w of sch.wires) addPath(w.points, wireOwner.get(w.id) ?? -1, ob);
  for (const l of sch.labels) ob.points.set(keyOf(l.position), -1);
  // Re-tag kept groups' points with their desired net so own-net routes may touch them.
  for (const [i, gs] of groups) for (const g of gs) for (const p of g.points) ob.points.set(keyOf(p), i);

  const labelFor = (i: number): string => {
    let name = nets[i].label;
    let n = 1;
    while (occupiedLabels.has(name.toLowerCase()) && occupiedLabels.get(name.toLowerCase()) !== i) name = `${nets[i].label}_${n++}`;
    occupiedLabels.set(name.toLowerCase(), i);
    return name;
  };
  const addLabel = (name: string, at: Point, owner: number) => {
    sch.labels.push({ id: newId("l"), name, position: at, rotation: 0 });
    ob.points.set(keyOf(at), owner);
  };
  const addGround = (at: Point, dir: Point, owner: number) => {
    sch.components.push({ id: newId("c"), type: "ground", ref: "#PWR", position: at, rotation: groundRotation(dir), props: {} });
    ob.points.set(keyOf(at), owner);
  };
  const addWire = (path: Point[], owner: number) => {
    sch.wires.push({ id: newId("w"), points: path });
    addPath(path, owner, ob);
  };

  const byNet = new Map<number, typeof freePins>();
  for (const f of freePins) (byNet.get(f.net) ?? byNet.set(f.net, []).get(f.net)!).push(f);

  // Stub ends, chosen so they touch nothing else.
  const stubOf = new Map<(typeof freePins)[number], { tip: Point; end: Point; dir: Point } | null>();
  for (const f of freePins) {
    const def = lookup(f.inst.type)!;
    const tip = pinWorldPosition(f.inst, def, f.pinId)!;
    const dir = stubDir(f.inst, def, f.pinId);
    let chosen: { tip: Point; end: Point; dir: Point } | null = null;
    if (style === "wired") {
      for (const len of [2, 3, 1, 4]) {
        const end = { x: tip.x + dir.x * len, y: tip.y + dir.y * len };
        if (pathClear([tip, end], f.net, ob)) { chosen = { tip, end, dir }; break; }
      }
    }
    stubOf.set(f, chosen);
    if (chosen) addPath([chosen.tip, chosen.end], f.net, ob); // reserve; wire is created below
  }

  for (let i = 0; i < nets.length; i++) {
    const members = byNet.get(i) ?? [];
    const gs = groups.get(i) ?? [];
    const net = nets[i];
    const memberCount = members.length + gs.length;
    const needsGround = net.ground && !gs.some((g) => g.isGround);
    if (memberCount <= 1 && !needsGround) {
      // Nothing to join; keep a stub-free single pin.
      continue;
    }
    const stubs = members.map((m) => stubOf.get(m));
    for (let k = 0; k < members.length; k++) { const s = stubs[k]; if (s) addWire([s.tip, s.end], i); }

    if (net.ground) {
      members.forEach((m, k) => {
        const s = stubs[k];
        if (s) addGround(s.end, s.dir, i);
        else addGround(pinWorldPosition(m.inst, lookup(m.inst.type)!, m.pinId)!, stubDir(m.inst, lookup(m.inst.type)!, m.pinId), i);
      });
      for (const g of gs) if (!g.isGround && g.points.length) addGround(g.points[0], { x: 0, y: 1 }, i);
      continue;
    }

    // Try plain wires for nets made only of stubbed free pins.
    if (style === "wired" && gs.length === 0 && stubs.every((s) => s)) {
      const ends = stubs.map((s) => s!.end).sort((a, b) => a.x - b.x || a.y - b.y);
      const planned: Point[][] = [];
      const trial: Obstacles = { points: new Map(ob.points), segments: [...ob.segments], boxes: ob.boxes };
      let okRoute = true;
      for (let k = 1; k < ends.length && okRoute; k++) {
        const r = routes(ends[k - 1], ends[k]).find((path) => pathClear(path, i, trial));
        if (!r) { okRoute = false; break; }
        planned.push(r);
        addPath(r, i, trial);
      }
      if (okRoute) { planned.forEach((p) => addWire(p, i)); continue; }
    }

    // Labels: one at every stub end (or pin tip), and one on each kept group.
    const name = labelFor(i);
    members.forEach((m, k) => {
      const s = stubs[k];
      addLabel(name, s ? s.end : pinWorldPosition(m.inst, lookup(m.inst.type)!, m.pinId)!, i);
    });
    for (const g of gs) {
      if (g.labels.some((l) => l.toLowerCase() === name.toLowerCase())) continue;
      if (g.points.length) addLabel(name, g.points[0], i);
    }
  }

  // Ground symbols need unique-looking refs; the netlister ignores them, KiCad export annotates them.
  let pwr = 1;
  const usedPwr = new Set(sch.components.filter((c) => c.ref.startsWith("#PWR") && c.ref !== "#PWR").map((c) => c.ref));
  for (const c of sch.components) if (c.ref === "#PWR") { while (usedPwr.has(`#PWR${pwr}`)) pwr++; c.ref = `#PWR${pwr}`; usedPwr.add(c.ref); }

  // --- 6. verify
  const actual = pinPartition(project, lookup);
  const problems = comparePartition(actual, nets);
  const netNames = new Map<string, string>();
  for (const n of nets) if (n.pins[0]) netNames.set(n.name, actual.get(`${n.pins[0].ref}.${n.pins[0].pinId}`) ?? "");
  const diagnostics: Diagnostic[] = problems.length ? [{
    severity: "error", code: "ai-layout-mismatch", source: "ai",
    componentIds: [...refToId.values()],
    message: `Automatic ${style === "wired" ? "wiring" : "labelling"} could not reproduce the proposed connections: ${problems.slice(0, 4).join("; ")}.`,
    fix: "This usually happens when existing parts touch pins directly. Move the parts apart (or remove the touching wires) and ask again.",
  }] : [];
  return { ok: problems.length === 0, project, refToId, netNames, style, diagnostics };
}

/** Columns by breadth-first distance from the sources over non-ground nets; stacked within a column. */
function placeNewParts(project: Project, parts: ComponentInstance[], nets: ResolvedNet[], lookup: Lookup) {
  if (!parts.length) return;
  const neighbors = new Map<string, Set<string>>();
  for (const n of nets) {
    if (n.ground || n.pins.length > 8) continue; // supply rails would connect everything to everything
    for (const a of n.pins) for (const b of n.pins) if (a.ref !== b.ref) {
      (neighbors.get(a.ref) ?? neighbors.set(a.ref, new Set()).get(a.ref)!).add(b.ref);
    }
  }
  const refs = parts.map((p) => p.ref);
  const depth = new Map<string, number>();
  const queue = parts.filter((p) => SOURCE_LIKE(lookup(p.type)!)).map((p) => p.ref);
  if (!queue.length) queue.push(refs[0]);
  queue.forEach((r) => depth.set(r, 0));
  while (queue.length) {
    const r = queue.shift()!;
    for (const m of neighbors.get(r) ?? []) {
      if (!depth.has(m) && refs.includes(m)) { depth.set(m, depth.get(r)! + 1); queue.push(m); }
    }
  }
  let maxD = Math.max(0, ...depth.values());
  for (const r of refs) if (!depth.has(r)) depth.set(r, ++maxD);

  // Existing drawing extent.
  let x0 = 0, y0 = 0, haveExisting = false;
  let ex1 = -Infinity, ey0 = Infinity;
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    if (!def) continue;
    const b = instanceBox(c, def);
    ex1 = Math.max(ex1, b.x1); ey0 = Math.min(ey0, b.y0); haveExisting = true;
  }
  for (const w of project.schematic.wires) for (const p of w.points) { ex1 = Math.max(ex1, p.x); ey0 = Math.min(ey0, p.y); haveExisting = true; }
  if (haveExisting) { x0 = Math.ceil(ex1) + 12; y0 = Math.floor(ey0); }

  const columns = new Map<number, ComponentInstance[]>();
  for (const p of parts) { const d = depth.get(p.ref)!; (columns.get(d) ?? columns.set(d, []).get(d)!).push(p); }
  let cx = x0;
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const col = columns.get(d)!;
    let cy = y0;
    let width = 0;
    for (const p of col) {
      const def = lookup(p.type)!;
      const b = shapeBounds(def.symbol, def.pins);
      // Integer position so pin tips land on the grid; bounding box starts at (cx, cy).
      p.position = { x: cx - Math.floor(b.x0), y: cy - Math.floor(b.y0) };
      width = Math.max(width, Math.ceil(b.x1) - Math.floor(b.x0));
      cy += Math.ceil(b.y1) - Math.floor(b.y0) + 10;
    }
    cx += width + 14;
  }
}
