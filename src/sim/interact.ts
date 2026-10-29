// Operating interactive parts on the schematic while a transient result plays (live mode).
// The canvas routes select-tool pointer events here first (`liveInput.down/move/up`); when a press lands on
// a switch, push button or potentiometer and a current transient result is shown, the press operates the
// part instead of selecting or moving it. Changes are recorded at the playback time and re-simulated.
import { getPart } from "../core/library";
import { useProject } from "../core/store";
import type { ComponentDef, ComponentInstance, Point } from "../core/types";
import { staticValue, valueAt } from "./live";
import { staleness, usePlayback, useSim } from "./store";

/** Point in the part's own symbol coordinates (inverse of translate · rotate · mirror). */
export function toLocal(c: ComponentInstance, p: Point): Point {
  const dx = p.x - c.position.x, dy = p.y - c.position.y;
  const a = -c.rotation * Math.PI / 180;
  const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
  return { x: c.mirror ? -x : x, y };
}

/** Grab box of an interactive part in symbol coordinates. */
export function grabBox(def: ComponentDef): { x0: number; y0: number; x1: number; y1: number } {
  switch (def.interactive?.kind) {
    case "slider": return { x0: -1.4, y0: -2.2, x1: 2.2, y1: 2.2 }; // pot body and wiper arrow
    default: return { x0: -2.6, y0: -2.8, x1: 2.6, y1: 0.9 };      // between the contacts, lever/plunger included
  }
}

/** Interactive parts can be operated: a current, successful transient result is shown. */
export function liveEnabled(): boolean {
  const sim = useSim.getState();
  if (!sim.session || !sim.result?.ok || sim.result.analysis !== "tran") return false;
  return !staleness(useProject.getState().project, sim.basis, sim.result.analysis).any;
}

export function liveHit(p: Point): { inst: ComponentInstance; def: ComponentDef; local: Point } | null {
  if (!liveEnabled()) return null;
  const comps = useProject.getState().project.schematic.components;
  for (let i = comps.length - 1; i >= 0; i--) {
    const c = comps[i];
    const def = getPart(c.type);
    if (!def?.interactive) continue;
    const l = toLocal(c, p), b = grabBox(def);
    if (l.x >= b.x0 && l.x <= b.x1 && l.y >= b.y0 && l.y <= b.y1) return { inst: c, def, local: l };
  }
  return null;
}

/** Value of an interactive part at playback time t (the recorded change in effect, else its static prop). */
export function liveValue(c: ComponentInstance, def: ComponentDef, t: number | null): number {
  const s = useSim.getState().session;
  const init = staticValue(c, def);
  if (!s || t == null) return t == null && s ? valueAt(init, s.changes[c.id], usePlayback.getState().t1) : init;
  return valueAt(init, s.changes[c.id], t);
}

/** Symbol y of the potentiometer wiper for a position in % (pin 1 = 100 % at the top). */
export const wiperY = (pct: number) => 1.6 - 3.2 * Math.min(1, Math.max(0, pct / 100));

type Drag =
  | { kind: "momentary"; id: string; t: number }
  | { kind: "slider"; id: string; c: ComponentInstance; y0: number; v0: number; last: number; lastT: number; min: number; max: number };
let drag: Drag | null = null;

const now = () => { const pb = usePlayback.getState(); return pb.t ?? pb.t1; };

export const liveInput = {
  /** Returns true when the press operated a part (the canvas then skips selection/move). */
  down(p: Point): boolean {
    const h = liveHit(p);
    if (!h) return false;
    const it = h.def.interactive!;
    const t = now();
    const v = liveValue(h.inst, h.def, t);
    const sim = useSim.getState();
    if (it.kind === "toggle") { sim.change(h.inst.id, v ? 0 : 1, t); return true; }
    if (it.kind === "momentary") { drag = { kind: "momentary", id: h.inst.id, t }; sim.change(h.inst.id, 1, t); return true; }
    drag = { kind: "slider", id: h.inst.id, c: h.inst, y0: h.local.y, v0: v, last: v, lastT: t, min: it.min ?? 0, max: it.max ?? 100 };
    return true;
  },
  move(p: Point) {
    if (drag?.kind !== "slider") return;
    const l = toLocal(drag.c, p);
    const span = drag.max - drag.min;
    const v = Math.round(Math.min(drag.max, Math.max(drag.min, drag.v0 + (drag.y0 - l.y) / 3.2 * span)));
    const t = now(), rate = usePlayback.getState().rate;
    if (v === drag.last) return;
    // Thin samples during a drag: at most ~20 recorded steps per second of playback.
    if (t - drag.lastT < rate / 20 && t > drag.lastT) { pendingSlider = v; return; }
    drag.last = v; drag.lastT = t; pendingSlider = null;
    useSim.getState().change(drag.id, v, t);
  },
  up() {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "momentary") {
      // A release has to come after the press; while paused both happen at the same time, so hold it briefly.
      const rate = usePlayback.getState().rate;
      const t = Math.max(now(), d.t + Math.max(rate * 0.1, 1e-5));
      useSim.getState().change(d.id, 0, t);
    } else if (pendingSlider != null && pendingSlider !== d.last) {
      useSim.getState().change(d.id, pendingSlider, Math.max(now(), d.lastT));
    }
    pendingSlider = null;
  },
  /** True when p is on an operable part (the canvas skips its double-click actions there). */
  hit(p: Point): boolean { return !!liveHit(p); },
  /** The part being held/dragged, for drawing. */
  active(): string | null { return drag?.id ?? null; },
};
let pendingSlider: number | null = null;
