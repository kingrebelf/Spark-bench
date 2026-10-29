// Editor commands shared by the canvas, keyboard shortcuts and panels. Every schematic change
// goes through useProject.update so it is undoable with a readable label.
import { getPart } from "../core/library";
import { newId } from "../core/project";
import { useProject } from "../core/store";
import type { Point, Project, Rotation } from "../core/types";
import {
  addWire, copyItems, deleteItems, describeItems, itemsBounds, mirrorItems, moveItems, nextRef, pasteClip, rotateItems,
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

/** Paste at the cursor when it is over the canvas, otherwise next to the original. */
export function paste(at?: Point) {
  const clip = useEditor.getState().clipboard;
  if (!clip) return;
  const cursor = usePointer.getState().cursor;
  const target = at ?? cursor ?? { x: clip.origin.x + 4, y: clip.origin.y + 4 };
  const base = sch();
  const r = pasteClip(base, clip, target);
  st().update(`Paste ${r.ids.length} item${r.ids.length === 1 ? "" : "s"}`, (d) => setSchematic(d, r.schematic, base));
  select(r.ids);
}

export function duplicateSelection() {
  const ids = liveSelection();
  const clip = ids.length ? copyItems(sch(), new Set(ids)) : undefined;
  if (!clip) return;
  const base = sch();
  const r = pasteClip(base, clip, { x: clip.origin.x + 4, y: clip.origin.y + 4 });
  st().update(`Duplicate ${describeItems(base, ids)}`, (d) => setSchematic(d, r.schematic, base));
  select(r.ids);
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
