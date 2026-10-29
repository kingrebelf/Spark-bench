// Pure schematic-editing logic (no React, no DOM): routing, wire cleanup and merging,
// rubber-banding, hit-testing, transforms and copy/paste. Everything works on plain
// schematic data so it is unit-testable and usable from immer recipes.
import { getPart } from "../core/library";
import { newId } from "../core/project";
import { keyOf, onSegment, pinWorldPosition, transformPoint } from "../core/geometry";
import type { ComponentDef, ComponentInstance, NetLabel, Point, Project, Rotation, Shape, Wire } from "../core/types";

export type Schematic = Project["schematic"];
export type Lookup = (type: string) => ComponentDef | undefined;
export interface Rect { x: number; y: number; w: number; h: number }

const eq = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

// ---------------------------------------------------------------- refs

/** First free reference with this prefix: R1, R2, ... */
export function nextRef(prefix: string, comps: { ref: string }[], extraUsed?: Set<string>): string {
  const used = new Set(comps.map((c) => c.ref));
  let n = 1;
  while (used.has(`${prefix}${n}`) || extraUsed?.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Reference prefix of an instance: the def's prefix, or the leading non-digit part of its ref. */
export function refPrefixOf(inst: ComponentInstance, lookup: Lookup = getPart): string {
  return lookup(inst.type)?.refPrefix ?? (inst.ref.replace(/\d+$/, "") || "U");
}

// ---------------------------------------------------------------- routing and cleanup

/** Orthogonal route from a to b with one bend. `horizontalFirst` picks which leg comes first. */
export function routeOrthogonal(a: Point, b: Point, horizontalFirst: boolean): Point[] {
  if (a.x === b.x || a.y === b.y) return [a, b];
  const bend = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  return [a, bend, b];
}

/**
 * Like routeOrthogonal, but if the preferred corner would run the wire through a pin tip (which
 * would silently connect to it) and the other corner would not, take the other corner.
 */
export function routeAvoiding(a: Point, b: Point, horizontalFirst: boolean, avoid: Point[]): Point[] {
  const first = routeOrthogonal(a, b, horizontalFirst);
  if (!touchesAny(first, avoid)) return first;
  const other = routeOrthogonal(a, b, !horizontalFirst);
  return touchesAny(other, avoid) ? first : other;
}

/** Drop repeated points and interior points that lie on a straight run (collinear). */
export function simplifyPolyline(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    if (out.length && eq(out[out.length - 1], p)) continue;
    out.push({ x: p.x, y: p.y });
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      // collinear and b between a and c (no doubling back) -> drop b
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (cross === 0 && dot >= 0) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}

/** Insert elbows so every segment is horizontal or vertical. */
export function orthogonalize(pts: Point[]): Point[] {
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    if (a.x !== b.x && a.y !== b.y) {
      // keep going in the direction of the previous segment when possible
      const prev = out[out.length - 2];
      const prevHorizontal = prev ? prev.y === a.y : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      out.push(prevHorizontal ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    }
    out.push(b);
  }
  return out;
}

function direction(a: Point, b: Point): Point {
  return { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
}

export function pinPoints(s: Schematic, lookup: Lookup = getPart): Point[] {
  const out: Point[] = [];
  for (const c of s.components) {
    const def = lookup(c.type);
    if (def) for (const pin of def.pins) out.push(pinWorldPosition(c, def, pin.id)!);
  }
  return out;
}

/** Every point that something other than wire geometry attaches to: pin tips and label anchors. */
export function anchorKeys(s: Schematic, lookup: Lookup = getPart): Set<string> {
  const keys = new Set<string>();
  for (const c of s.components) {
    const def = lookup(c.type);
    if (!def || def.role === "netlabel") continue;
    for (const pin of def.pins) keys.add(keyOf(pinWorldPosition(c, def, pin.id)!));
  }
  for (const l of s.labels) keys.add(keyOf(l.position));
  return keys;
}

/**
 * Add a wire and tidy up: simplify it, then join it end-to-end with existing wires that
 * continue in a straight line through a point nothing else attaches to. Returns the new wire list
 * and the id of the wire that now contains the new segment(s).
 */
export function addWire(s: Schematic, points: Point[], lookup: Lookup = getPart, id = newId("w")): { wires: Wire[]; id: string } {
  let pts = simplifyPolyline(points);
  if (pts.length < 2) return { wires: s.wires, id: "" };
  const anchors = anchorKeys(s, lookup);
  let wires = [...s.wires];
  let merged = true;
  while (merged) {
    merged = false;
    for (const end of [0, 1] as const) {
      const p = end === 0 ? pts[0] : pts[pts.length - 1];
      if (anchors.has(keyOf(p))) continue;
      const touching = wires.filter((w) => w.points.some((q, i) => eq(q, p) || (i > 0 && onSegment(p, w.points[i - 1], q))));
      if (touching.length !== 1) continue;
      const w = touching[0];
      const wStart = eq(w.points[0], p), wEnd = eq(w.points[w.points.length - 1], p);
      if (!wStart && !wEnd) continue;
      // direction leaving p along the new wire vs along the existing wire
      const newDir = end === 0 ? direction(pts[0], pts[1]) : direction(pts[pts.length - 1], pts[pts.length - 2]);
      const wDir = wStart ? direction(w.points[0], w.points[1]) : direction(w.points[w.points.length - 1], w.points[w.points.length - 2]);
      if (!(newDir.x === -wDir.x && newDir.y === -wDir.y)) continue; // only straight continuations
      const wPts = wStart ? [...w.points].reverse() : [...w.points]; // wPts ends at p
      pts = end === 0 ? simplifyPolyline([...wPts, ...pts.slice(1)]) : simplifyPolyline([...pts, ...wPts.reverse().slice(1)]);
      wires = wires.filter((x) => x !== w);
      id = w.id;
      merged = true;
      break;
    }
  }
  wires.push({ id, points: pts });
  return { wires, id };
}

/** Remove zero-length wires and collapse redundant vertices. Keeps wire identity when unchanged. */
export function cleanupWires(wires: Wire[]): Wire[] {
  const out: Wire[] = [];
  for (const w of wires) {
    const pts = simplifyPolyline(w.points);
    if (pts.length < 2) continue;
    out.push(pts.length === w.points.length && pts.every((p, i) => eq(p, w.points[i])) ? w : { ...w, points: pts });
  }
  return out;
}

// ---------------------------------------------------------------- rubber-banding

type EndMode = "slide" | "h" | "v";

function bandOnce(points: Point[], moves: Map<string, Point>, fixed: Set<string>, modes: [EndMode, EndMode]): Point[] {
  const pts = points.map((p) => ({ ...p }));
  const ends = [0, pts.length - 1];
  const inserts: { at: number; p: Point }[] = [];
  ends.forEach((e, k) => {
    const to = moves.get(keyOf(points[e]));
    if (!to) return;
    const n = e === 0 ? 1 : pts.length - 2;
    const otherEnd = e === 0 ? pts.length - 1 : 0;
    const mode = modes[k];
    const wasHorizontal = points[e].y === points[n].y;
    pts[e] = { ...to };
    if (mode === "slide") {
      if (n !== otherEnd && !fixed.has(keyOf(points[n]))) {
        pts[n] = wasHorizontal ? { x: pts[n].x, y: to.y } : { x: to.x, y: pts[n].y };
      }
    } else {
      const from = pts[n];
      const elbow = mode === "h" ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
      inserts.push({ at: e === 0 ? 1 : pts.length - 1, p: elbow });
    }
  });
  inserts.sort((a, b) => b.at - a.at).forEach((i) => pts.splice(i.at, 0, i.p));
  return simplifyPolyline(orthogonalize(pts));
}

/** Points of `avoid` that a wire would touch (vertex or segment interior), ignoring its own end points. */
function touchesAny(pts: Point[], avoid: Point[]): boolean {
  const a = pts[0], z = pts[pts.length - 1];
  for (const q of avoid) {
    if (eq(q, a) || eq(q, z)) continue;
    for (let i = 1; i < pts.length; i++) if (onSegment(q, pts[i - 1], pts[i])) return true;
  }
  return false;
}

/**
 * Move a wire's endpoints that sit on moved anchors (old key -> new point) while keeping it orthogonal.
 * The neighbouring vertex slides along with the endpoint unless something else is attached there
 * (`fixed`); otherwise an elbow is inserted. When `avoid` points are given (pin tips), routes that
 * would run through one of them (and so short to it) are rejected in favour of another elbow choice.
 */
export function rubberBand(points: Point[], moves: Map<string, Point>, fixed: Set<string>, avoid: Point[] = []): Point[] {
  const startMoves = moves.get(keyOf(points[0]));
  const endMoves = moves.get(keyOf(points[points.length - 1]));
  // Whole wire hangs between two anchors that moved together: translate it rigidly.
  if (startMoves && endMoves) {
    const d0 = { x: startMoves.x - points[0].x, y: startMoves.y - points[0].y };
    const last = points[points.length - 1];
    if (d0.x === endMoves.x - last.x && d0.y === endMoves.y - last.y) return points.map((p) => ({ x: p.x + d0.x, y: p.y + d0.y }));
  }
  const modes: EndMode[] = ["slide", "h", "v"];
  let first: Point[] | undefined;
  for (const m0 of modes) {
    for (const m1 of modes) {
      if (!startMoves && m0 !== "slide") continue;
      if (!endMoves && m1 !== "slide") continue;
      const out = bandOnce(points, moves, fixed, [m0, m1]);
      first ??= out;
      if (!avoid.length || !touchesAny(out, avoid)) return out;
    }
  }
  return first!;
}

// ---------------------------------------------------------------- bounds and hit-testing

export function symbolBounds(shapes: Shape[], pins: { x: number; y: number }[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of pins) add(p.x, p.y);
  for (const s of shapes) {
    if (s.kind === "line") { add(s.x1, s.y1); add(s.x2, s.y2); }
    else if (s.kind === "rect") { add(s.x, s.y); add(s.x + s.w, s.y + s.h); }
    else if (s.kind === "circle") { add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r); }
    else if (s.kind === "polyline") s.points.forEach((p) => add(p.x, p.y));
    else if (s.kind === "arc") { add(Math.min(s.x1, s.x2) - s.r, Math.min(s.y1, s.y2) - s.r); add(Math.max(s.x1, s.x2) + s.r, Math.max(s.y1, s.y2) + s.r); }
    else if (s.kind === "text") { const sz = s.size ?? 1.2; add(s.x - sz * 0.3, s.y - sz / 2); add(s.x + sz * 0.3, s.y + sz / 2); }
  }
  if (!Number.isFinite(x0)) return { x: -1, y: -1, w: 2, h: 2 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const boundsCache = new WeakMap<ComponentDef, Rect>();
export function defBounds(def: ComponentDef): Rect {
  let b = boundsCache.get(def);
  if (!b) { b = symbolBounds(def.symbol, def.pins); boundsCache.set(def, b); }
  return b;
}

/** World-space bounding box of a placed component (rotation and mirror applied). */
export function componentBounds(c: ComponentInstance, def: ComponentDef): Rect {
  const b = defBounds(def);
  const corners = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }]
    .map((p) => transformPoint(p, c.rotation, c.mirror));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: c.position.x + x, y: c.position.y + y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Approximate label box (text drawn to the right of / above the anchor). */
export function labelBounds(l: NetLabel): Rect {
  return { x: l.position.x - 0.4, y: l.position.y - 1.4, w: Math.max(1.5, l.name.length * 0.7 + 0.9), h: 1.8 };
}

export function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const inRect = (p: Point, r: Rect, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

export type Hit =
  | { kind: "pin"; id: string; pinId: string; point: Point }
  | { kind: "label"; id: string }
  | { kind: "wire"; id: string; segment: number; dist: number }
  | { kind: "component"; id: string };

/** Find the pin tip nearest to p within `tol` grid units. */
export function hitPin(s: Schematic, p: Point, tol: number, lookup: Lookup = getPart): Extract<Hit, { kind: "pin" }> | undefined {
  let best: Extract<Hit, { kind: "pin" }> | undefined, bestD = tol;
  for (const c of s.components) {
    const def = lookup(c.type);
    if (!def) continue;
    for (const pin of def.pins) {
      const q = pinWorldPosition(c, def, pin.id)!;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bestD) { bestD = d; best = { kind: "pin", id: c.id, pinId: pin.id, point: q }; }
    }
  }
  return best;
}

export function hitWire(s: Schematic, p: Point, tol: number): Extract<Hit, { kind: "wire" }> | undefined {
  let best: Extract<Hit, { kind: "wire" }> | undefined, bestD = tol;
  for (const w of s.wires) {
    for (let i = 1; i < w.points.length; i++) {
      const d = distToSeg(p, w.points[i - 1], w.points[i]);
      if (d <= bestD) { bestD = d; best = { kind: "wire", id: w.id, segment: i - 1, dist: d }; }
    }
  }
  return best;
}

/**
 * Topmost item under p. Labels first; then a part whose body contains p, unless a wire passes
 * within a hair of p (wires are thin, so a precise hit on one wins); then wires within `tol`;
 * then parts with a little padding.
 */
export function hitTest(s: Schematic, p: Point, tol: number, lookup: Lookup = getPart): Hit | undefined {
  for (let i = s.labels.length - 1; i >= 0; i--) if (inRect(p, labelBounds(s.labels[i]))) return { kind: "label", id: s.labels[i].id };
  const w = hitWire(s, p, tol);
  const partAt = (pad: number) => {
    for (let i = s.components.length - 1; i >= 0; i--) {
      const c = s.components[i], def = lookup(c.type);
      if (def && inRect(p, componentBounds(c, def), pad)) return { kind: "component" as const, id: c.id };
    }
    return undefined;
  };
  if (!w || w.dist > 0.25) { const c = partAt(0); if (c) return c; }
  return w ?? partAt(0.3);
}

const rectContains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const rectsTouch = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

function segTouchesRect(a: Point, b: Point, r: Rect): boolean {
  // segments are axis-aligned in practice; treat as their bounding box
  return rectsTouch(r, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
}

/** Marquee selection. "inside": item fully enclosed (drag left→right); "touch": any overlap (drag right→left). */
export function itemsInRect(s: Schematic, r: Rect, mode: "inside" | "touch", lookup: Lookup = getPart): string[] {
  const ids: string[] = [];
  for (const c of s.components) {
    const def = lookup(c.type);
    if (!def) { if (inRect(c.position, r)) ids.push(c.id); continue; }
    const b = componentBounds(c, def);
    if (mode === "inside" ? rectContains(r, b) : rectsTouch(r, b)) ids.push(c.id);
  }
  for (const w of s.wires) {
    const ok = mode === "inside" ? w.points.every((p) => inRect(p, r)) : w.points.some((p, i) => i > 0 && segTouchesRect(w.points[i - 1], p, r));
    if (ok) ids.push(w.id);
  }
  for (const l of s.labels) {
    const b = labelBounds(l);
    if (mode === "inside" ? inRect(l.position, r) : rectsTouch(r, b)) ids.push(l.id);
  }
  return ids;
}

/** Bounding box of the given items (all items when ids is omitted). Undefined when empty. */
export function itemsBounds(s: Schematic, ids?: Set<string>, lookup: Lookup = getPart): Rect | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const addR = (r: Rect) => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); };
  for (const c of s.components) {
    if (ids && !ids.has(c.id)) continue;
    const def = lookup(c.type);
    addR(def ? componentBounds(c, def) : { ...c.position, w: 0, h: 0 });
  }
  for (const w of s.wires) if (!ids || ids.has(w.id)) for (const p of w.points) addR({ ...p, w: 0, h: 0 });
  for (const l of s.labels) if (!ids || ids.has(l.id)) addR(labelBounds(l));
  if (!Number.isFinite(x0)) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- transforms with rubber-banding

/** Map old position -> new position for everything a selection carries (pins, wire vertices, labels). */
function anchorMoves(before: Schematic, after: Schematic, ids: Set<string>, lookup: Lookup): Map<string, Point> {
  const moves = new Map<string, Point>();
  const afterComps = new Map(after.components.map((c) => [c.id, c]));
  for (const c of before.components) {
    if (!ids.has(c.id)) continue;
    const def = lookup(c.type), c2 = afterComps.get(c.id);
    if (!def || !c2) continue;
    for (const pin of def.pins) {
      const a = pinWorldPosition(c, def, pin.id)!, b = pinWorldPosition(c2, def, pin.id)!;
      if (!eq(a, b)) moves.set(keyOf(a), b);
    }
  }
  const afterWires = new Map(after.wires.map((w) => [w.id, w]));
  for (const w of before.wires) {
    if (!ids.has(w.id)) continue;
    const w2 = afterWires.get(w.id);
    if (w2) w.points.forEach((p, i) => { if (!eq(p, w2.points[i])) moves.set(keyOf(p), w2.points[i]); });
  }
  const afterLabels = new Map(after.labels.map((l) => [l.id, l]));
  for (const l of before.labels) {
    const l2 = afterLabels.get(l.id);
    if (ids.has(l.id) && l2 && !eq(l.position, l2.position)) moves.set(keyOf(l.position), l2.position);
  }
  return moves;
}

/** Re-attach unselected wires and labels to the anchors the selection moved. */
function reattach(before: Schematic, after: Schematic, ids: Set<string>, lookup: Lookup): Schematic {
  const moves = anchorMoves(before, after, ids, lookup);
  if (!moves.size) return after;
  // points that stay put and have something attached: unmoved pins, labels and wire ends
  const fixed = anchorKeys({ ...after, labels: after.labels }, lookup);
  for (const w of after.wires) { fixed.add(keyOf(w.points[0])); fixed.add(keyOf(w.points[w.points.length - 1])); }
  const pins = pinPoints(after, lookup);
  const wires = after.wires.map((w) => {
    if (ids.has(w.id)) return w;
    const first = keyOf(w.points[0]), last = keyOf(w.points[w.points.length - 1]);
    if (!moves.has(first) && !moves.has(last)) return w;
    return { ...w, points: rubberBand(w.points, moves, fixed, pins) };
  });
  const labels = after.labels.map((l) => {
    if (ids.has(l.id)) return l;
    const to = moves.get(keyOf(l.position));
    return to ? { ...l, position: { ...to } } : l;
  });
  // Moved pins or wire ends that touched a pin that stayed put get a new stub wire so they stay joined.
  const stayed = new Set(pinPoints({ ...after, components: after.components.filter((c) => !ids.has(c.id)) }, lookup).map(keyOf));
  const wireEnds = new Set(before.wires.filter((w) => !ids.has(w.id)).flatMap((w) => [keyOf(w.points[0]), keyOf(w.points[w.points.length - 1])]));
  for (const [k, to] of moves) {
    if (!stayed.has(k) || wireEnds.has(k)) continue;
    const [x, y] = k.split(",").map(Number);
    const from = { x, y };
    const route = [routeOrthogonal(from, to, true), routeOrthogonal(from, to, false)].find((r) => !touchesAny(r, pins)) ?? routeOrthogonal(from, to, true);
    wires.push({ id: newId("w"), points: route });
  }
  return { ...after, wires: cleanupWires(wires), labels };
}

/** Translate the selected items by (dx, dy), rubber-banding attached wires. */
export function moveItems(s: Schematic, ids: Set<string>, dx: number, dy: number, lookup: Lookup = getPart, attach = true): Schematic {
  if (!dx && !dy) return s;
  const mv = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  const after: Schematic = {
    components: s.components.map((c) => (ids.has(c.id) ? { ...c, position: mv(c.position) } : c)),
    wires: s.wires.map((w) => (ids.has(w.id) ? { ...w, points: w.points.map(mv) } : w)),
    labels: s.labels.map((l) => (ids.has(l.id) ? { ...l, position: mv(l.position) } : l)),
  };
  return attach ? reattach(s, after, ids, lookup) : after;
}

/** Snapped centre of the selection, used as the pivot for rotate/mirror. */
export function pivotOf(s: Schematic, ids: Set<string>, lookup: Lookup = getPart): Point {
  const only = s.components.filter((c) => ids.has(c.id));
  if (only.length === 1 && s.wires.every((w) => !ids.has(w.id)) && s.labels.every((l) => !ids.has(l.id))) return only[0].position;
  const b = itemsBounds(s, ids, lookup) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) };
}

/** Rotate the selection 90° clockwise (or counter-clockwise) about its pivot. */
export function rotateItems(s: Schematic, ids: Set<string>, ccw = false, lookup: Lookup = getPart): Schematic {
  const c0 = pivotOf(s, ids, lookup);
  const r: Rotation = ccw ? 270 : 90;
  const rot = (p: Point) => { const t = transformPoint({ x: p.x - c0.x, y: p.y - c0.y }, r); return { x: c0.x + t.x, y: c0.y + t.y }; };
  const after: Schematic = {
    components: s.components.map((c) => (ids.has(c.id) ? { ...c, position: rot(c.position), rotation: ((c.rotation + r) % 360) as Rotation } : c)),
    wires: s.wires.map((w) => (ids.has(w.id) ? { ...w, points: w.points.map(rot) } : w)),
    labels: s.labels.map((l) => (ids.has(l.id) ? { ...l, position: rot(l.position) } : l)),
  };
  return reattach(s, after, ids, lookup);
}

/** Mirror the selection left-right on screen about its pivot. */
export function mirrorItems(s: Schematic, ids: Set<string>, lookup: Lookup = getPart): Schematic {
  const c0 = pivotOf(s, ids, lookup);
  const fx = (p: Point) => ({ x: 2 * c0.x - p.x, y: p.y });
  const after: Schematic = {
    components: s.components.map((c) => {
      if (!ids.has(c.id)) return c;
      // Local mirror is applied before rotation; for 90/270 a screen-horizontal flip also needs +180°.
      const rotation = (c.rotation === 90 || c.rotation === 270 ? (c.rotation + 180) % 360 : c.rotation) as Rotation;
      return { ...c, position: fx(c.position), mirror: !c.mirror, rotation };
    }),
    wires: s.wires.map((w) => (ids.has(w.id) ? { ...w, points: w.points.map(fx) } : w)),
    labels: s.labels.map((l) => (ids.has(l.id) ? { ...l, position: fx(l.position) } : l)),
  };
  return reattach(s, after, ids, lookup);
}

export function deleteItems(s: Schematic, ids: Set<string>): Schematic {
  return {
    components: s.components.filter((c) => !ids.has(c.id)),
    wires: s.wires.filter((w) => !ids.has(w.id)),
    labels: s.labels.filter((l) => !ids.has(l.id)),
  };
}

// ---------------------------------------------------------------- clipboard

export interface Clip { components: ComponentInstance[]; wires: Wire[]; labels: NetLabel[]; origin: Point }

export function copyItems(s: Schematic, ids: Set<string>, lookup: Lookup = getPart): Clip | undefined {
  const b = itemsBounds(s, ids, lookup);
  if (!b) return undefined;
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  return {
    components: clone(s.components.filter((c) => ids.has(c.id))),
    wires: clone(s.wires.filter((w) => ids.has(w.id))),
    labels: clone(s.labels.filter((l) => ids.has(l.id))),
    origin: { x: Math.round(b.x), y: Math.round(b.y) },
  };
}

/**
 * Paste a clip so its top-left lands at `at`. Every item gets a fresh id and every part a fresh
 * reference (R1 -> next free R). Labels keep their names, so they join the same nets.
 */
export function pasteClip(s: Schematic, clip: Clip, at: Point, lookup: Lookup = getPart): { schematic: Schematic; ids: string[] } {
  const dx = at.x - clip.origin.x, dy = at.y - clip.origin.y;
  const mv = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  const used = new Set<string>();
  const ids: string[] = [];
  const components = clip.components.map((c) => {
    const ref = nextRef(refPrefixOf(c, lookup), s.components, used);
    used.add(ref);
    const id = newId("c");
    ids.push(id);
    return { ...c, id, ref, position: mv(c.position), props: { ...c.props } };
  });
  const wires = clip.wires.map((w) => { const id = newId("w"); ids.push(id); return { id, points: w.points.map(mv) }; });
  const labels = clip.labels.map((l) => { const id = newId("l"); ids.push(id); return { ...l, id, position: mv(l.position) }; });
  return {
    schematic: { components: [...s.components, ...components], wires: [...s.wires, ...wires], labels: [...s.labels, ...labels] },
    ids,
  };
}

// ---------------------------------------------------------------- labels for history

/** Human-readable description of a set of items for undo labels: "R1", "R1, C2", "5 items". */
export function describeItems(s: Schematic, ids: Iterable<string>): string {
  const list = [...ids];
  if (list.length > 3) return `${list.length} items`;
  const names = list.map((id) => s.components.find((c) => c.id === id)?.ref
    ?? (s.wires.some((w) => w.id === id) ? "wire" : undefined)
    ?? (s.labels.find((l) => l.id === id) ? `label ${s.labels.find((l) => l.id === id)!.name}` : "item"));
  return names.join(", ");
}

/** True when the point is on any wire segment or is a wire vertex. */
export function onAnyWire(s: Schematic, p: Point): boolean {
  return s.wires.some((w) => w.points.some((q, i) => i > 0 && onSegment(p, w.points[i - 1], q)));
}
