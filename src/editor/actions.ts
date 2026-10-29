// Editor commands shared by the canvas, keyboard shortcuts and panels. Every schematic change
// goes through useProject.update so it is undoable with a readable label.
import { computeConnectivity, type Connectivity } from "../core/connectivity";
import { getPart } from "../core/library";
import { newId } from "../core/project";
import { useProject } from "../core/store";
import type { Point, Project, Rotation } from "../core/types";
import {
  addWire, copyItems, deleteItems, type Clip, describeItems, itemsBounds, mirrorItems, moveItems, nextRef, pasteClip, rotateItems,
  type Schematic,
} from "./ops";
import { useEditor, usePointer } from "./store";

const st = () => useProject.getState();
const sch = () => st().project.schematic;

/** Replace the schematic arrays that differ from `base` (keeps undo patches small). */
export function setSchematic(d: Project, next: Schematic, base: Schematic) {
  if (next.components !== base.components) d.schematic.components = next.components;
  if (next.wires !== base.wires) d.schematic.wires = next.wires;
  if (next.labels !== base.labels) d.schematic.labels = next.labels;
}

/** Ids that still exist in the schematic. */
export function liveSelection(): string[] {
  const s = sch();
  const all = new Set([...s.components.map((c) => c.id), ...s.wires.map((w) => w.id), ...s.labels.map((l) => l.id)]);
  return st().selection.filter((id) => all.has(id));
}

// Selections the editor makes itself are "local"; anything else (diagnostics, AI) gets revealed on canvas.
let localSelect = false;
export function select(ids: string[]) {
  localSelect = true;
  st().setSelection(ids);
  localSelect = false;
}
export const isLocalSelect = () => localSelect;

function apply(label: string, fn: (s: Schematic) => Schematic, opts?: { merge?: boolean }) {
  const base = sch();
  const next = fn(base);
  if (next === base) return;
  st().update(label, (d) => setSchematic(d, next, base), opts);
}

export function deleteSelection() {
  const ids = liveSelection();
  if (!ids.length) return;
  apply(`Delete ${describeItems(sch(), ids)}`, (s) => deleteItems(s, new Set(ids)));
  select([]);
}

export function rotateSelection(ccw = false) {
  const ids = liveSelection();
  if (!ids.length) return;
  apply(`Rotate ${describeItems(sch(), ids)}`, (s) => rotateItems(s, new Set(ids), ccw));
}

export function mirrorSelection() {
  const ids = liveSelection();
  if (!ids.length) return;
  apply(`Mirror ${describeItems(sch(), ids)}`, (s) => mirrorItems(s, new Set(ids)));
}

let lastNudge = { at: 0, key: "" };
export function nudgeSelection(dx: number, dy: number) {
  const ids = liveSelection();
  if (!ids.length) return;
  const label = `Move ${describeItems(sch(), ids)}`;
  // Repeated arrow presses within a moment form one undo step.
  const key = ids.join(",");
  const merge = Date.now() - lastNudge.at < 1000 && lastNudge.key === key;
  lastNudge = { at: Date.now(), key };
  apply(label, (s) => moveItems(s, new Set(ids), dx, dy), { merge });
}

export function selectAll() {
  const s = sch();
  select([...s.components.map((c) => c.id), ...s.wires.map((w) => w.id), ...s.labels.map((l) => l.id)]);
}

export function copySelection(): boolean {
  const ids = liveSelection();
  const clip = ids.length ? copyItems(sch(), new Set(ids)) : undefined;
  if (!clip) return false;
  useEditor.getState().setClipboard(clip);
  return true;
}

export function cutSelection() {
  if (!copySelection()) return;
  const ids = liveSelection();
  apply(`Cut ${describeItems(sch(), ids)}`, (s) => deleteItems(s, new Set(ids)));
  select([]);
}

/**
 * Insert a clip. With the cursor over the canvas the copies land at the cursor and float with it
 * until the next click (Esc cancels); otherwise they land next to the originals.
 */
function insertClip(clip: Clip, label: string) {
  const cursor = usePointer.getState().cursor;
  const target = cursor ?? { x: clip.origin.x + 4, y: clip.origin.y + 4 };
  const base = sch();
  const r = pasteClip(base, clip, target);
  st().update(label, (d) => setSchematic(d, r.schematic, base));
  select(r.ids);
  if (cursor) useEditor.getState().setFloating({ ids: r.ids, label, anchor: cursor });
}

export function paste() {
  const clip = useEditor.getState().clipboard;
  if (!clip) return;
  const n = clip.components.length + clip.wires.length + clip.labels.length;
  insertClip(clip, `Paste ${n} item${n === 1 ? "" : "s"}`);
}

export function duplicateSelection() {
  const ids = liveSelection();
  const clip = ids.length ? copyItems(sch(), new Set(ids)) : undefined;
  if (clip) insertClip(clip, `Duplicate ${describeItems(sch(), ids)}`);
}

/** Drop floating (just pasted) items where they are. */
export function dropFloating() { useEditor.getState().setFloating(null); }

/** Cancel a floating paste: remove the pasted items again. */
export function cancelFloating() {
  const f = useEditor.getState().floating;
  if (!f) return;
  useEditor.getState().setFloating(null);
  if (st().past[st().past.length - 1]?.label === f.label) { st().undo(); useProject.setState({ future: st().future.slice(1) }); }
  select([]);
}

/** Move floating items so their anchor sits at `to` (folds into the paste's undo step). */
export function moveFloating(to: Point) {
  const f = useEditor.getState().floating;
  if (!f) return;
  const dx = to.x - f.anchor.x, dy = to.y - f.anchor.y;
  if (!dx && !dy) return;
  const base = sch();
  const next = moveItems(base, new Set(f.ids), dx, dy, getPart, false);
  st().update(f.label, (d) => setSchematic(d, next, base), { merge: true });
  useEditor.getState().setFloating({ ...f, anchor: to });
}

export function placePart(partId: string, at: Point, rotation: Rotation = 0, mirror = false): string | undefined {
  const def = getPart(partId);
  if (!def) return undefined;
  const id = newId("c");
  const ref = nextRef(def.refPrefix, sch().components);
  st().update(`Place ${def.name} ${ref}`, (d) => {
    d.schematic.components.push({
      id, type: def.id, ref, position: { x: at.x, y: at.y }, rotation, ...(mirror ? { mirror } : {}),
      props: Object.fromEntries(def.props.map((p) => [p.key, p.default])),
    });
  });
  useEditor.getState().noteRecent(def.id);
  select([id]);
  return id;
}

export function commitWire(points: Point[]): string | undefined {
  if (points.length < 2) return undefined;
  const r = addWire(sch(), points);
  if (!r.id) return undefined;
  st().update("Add wire", (d) => { d.schematic.wires = r.wires; });
  return r.id;
}

/** Suggest a fresh label name: the net's existing label if any, else NET1, NET2, ... */
export function suggestLabelName(): string {
  const used = new Set(sch().labels.map((l) => l.name));
  let n = 1;
  while (used.has(`NET${n}`)) n++;
  return `NET${n}`;
}

export function addLabel(name: string, at: Point): string {
  const id = newId("l");
  st().update(`Add label ${name}`, (d) => { d.schematic.labels.push({ id, name, position: { ...at }, rotation: 0 }); });
  select([id]);
  return id;
}

export function renameLabel(id: string, name: string) {
  const l = sch().labels.find((x) => x.id === id);
  if (!l || l.name === name) return;
  st().update(`Rename label ${l.name} → ${name}`, (d) => { d.schematic.labels.find((x) => x.id === id)!.name = name; });
}

export function boundsOfAll() {
  return itemsBounds(sch());
}

// Connectivity is the most expensive derived value; canvas and panels share one result per schematic.
const connCache = new WeakMap<Schematic, Connectivity>();
export function connectivityOf(project: Project): Connectivity {
  let c = connCache.get(project.schematic);
  if (!c) { c = computeConnectivity(project); connCache.set(project.schematic, c); }
  return c;
}
