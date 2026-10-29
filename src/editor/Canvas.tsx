// Schematic canvas: grid, zoom/pan, selection (click, shift, marquee), move with rubber-banding,
// placement (click or drag-and-drop from the library), orthogonal wiring, inline net labels,
// keyboard shortcuts, status bar and shortcut help. Pure geometry lives in ./ops.
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Connectivity } from "../core/connectivity";
import { keyOf, pinWorldPosition } from "../core/geometry";
import { getPart } from "../core/library";
import { useProject } from "../core/store";
import type { ComponentDef, ComponentInstance, NetLabel, Point, Wire } from "../core/types";
import { formatSI, parseSI } from "../core/units";
import { useSim } from "../sim/store";
import * as A from "./actions";
import { componentBounds, hitPin, hitTest, hitWire, itemsBounds, itemsInRect, labelBounds, moveItems, pinPoints, routeAvoiding, type Rect, type Schematic } from "./ops";
import { SymbolShapes } from "./SymbolView";
import { PART_MIME, useEditor, usePointer, type Hover, type View } from "./store";
import { HelpOverlay, StatusBar } from "./StatusBar";
import "./editor.css";
import { SimCanvasOverlay } from "../sim/CanvasOverlay";

export { nextRef } from "./ops";

/** Pixels per grid unit at 100% zoom. */
export const PX = 12;
const MIN_ZOOM = 0.1, MAX_ZOOM = 8;

type Gesture =
  | { kind: "pan"; client: Point; origin: View }
  | { kind: "move"; start: Point; base: Schematic; ids: string[]; label: string; moved: boolean; dx: number; dy: number }
  | { kind: "marquee"; a: Point; add: boolean; prev: string[] }
  | { kind: "wire-drag"; client: Point };

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const snap = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });
const editable = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");

/** View that fits `r` into a wÃ—h viewport with a margin. */
export function fitView(r: Rect, w: number, h: number): View {
  const pad = 6;
  const zoom = clampZoom(Math.min(4, Math.min(w / ((r.w + pad * 2) * PX), h / ((r.h + pad * 2) * PX))));
  const s = PX * zoom;
  return { zoom, x: r.x + r.w / 2 - w / 2 / s, y: r.y + r.h / 2 - h / 2 / s };
}

export const Canvas = memo(function Canvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const view = useEditor((s) => s.view);
  const tool = useEditor((s) => s.tool);
  const project = useProject((s) => s.project);
  const selection = useProject((s) => s.selection);
  const result = useSim((s) => s.result);
  const schematic = project.schematic;
  // Connectivity is O(wires Ã— points): it lags behind edits (deferred) and is frozen while
  // dragging, then recomputed on release, so moving parts stays smooth on large schematics.
  const [dragging, setDragging] = useState(false);
  const frozen = useRef(schematic);
  if (!dragging) frozen.current = schematic;
  const deferredSchematic = useDeferredValue(frozen.current);
  const conn = useMemo(() => A.connectivityOf({ ...project, schematic: deferredSchematic }), [deferredSchematic]); // eslint-disable-line react-hooks/exhaustive-deps
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [labelEdit, setLabelEdit] = useState<{ id?: string; at: Point; value: string } | null>(null);
  const [flash, setFlash] = useState({ n: 0, on: false });
  const gesture = useRef<Gesture | null>(null);
  const space = useRef(false);
  const pointerInside = useRef(false);
  const dirLocked = useRef(false);
  const wireFromSelect = useRef(false);
  const scale = PX * view.zoom;

  // ------------------------------------------------------------ viewport size, fit, reveal
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const fit = useCallback(() => {
    const b = A.boundsOfAll();
    const { w, h } = sizeRef.current;
    useEditor.getState().setView(b ? fitView(b, w, h) : { zoom: 1.4, x: -w / 2 / (PX * 1.4), y: -h / 2 / (PX * 1.4) });
  }, []);

  // Fit on first show, when a project is opened/created (a load: new project, empty history),
  // and when asked (F / Home / status bar). Saving or editing never moves the view.
  const fitToken = useEditor((s) => s.fitToken);
  useEffect(() => { if (size.w > 0) fit(); }, [fitToken, fit, size.w > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => useProject.subscribe((s, prev) => {
    const loaded = s.project !== prev.project && !s.past.length && !s.future.length
      && (s.project.meta.created !== prev.project.meta.created || s.filePath !== prev.filePath);
    if (loaded) setTimeout(fit, 0);
  }), [fit]);

  // Selections made outside the canvas (diagnostics, AI) are panned into view and flashed.
  useEffect(() => useProject.subscribe((s, prev) => {
    if (s.selection === prev.selection || A.isLocalSelect() || !s.selection.length) return;
    const ids = new Set(s.selection);
    const b = itemsBounds(s.project.schematic, ids);
    if (!b) return;
    const v = useEditor.getState().view, { w, h } = sizeRef.current;
    const sc = PX * v.zoom;
    const vis = { x: v.x, y: v.y, w: w / sc, h: h / sc };
    const inside = b.x >= vis.x + 1 && b.y >= vis.y + 1 && b.x + b.w <= vis.x + vis.w - 1 && b.y + b.h <= vis.y + vis.h - 1;
    if (!inside) {
      if (b.w + 8 > vis.w || b.h + 8 > vis.h) useEditor.getState().setView(fitView(b, w, h));
      else useEditor.getState().setView({ ...v, x: b.x + b.w / 2 - vis.w / 2, y: b.y + b.h / 2 - vis.h / 2 });
    }
    setFlash((f) => ({ n: f.n + 1, on: true }));
  }), []);
  useEffect(() => {
    if (!flash.on) return;
    const t = setTimeout(() => setFlash((f) => ({ ...f, on: false })), 2000);
    return () => clearTimeout(t);
  }, [flash]);

  // ------------------------------------------------------------ coordinates and hits
  const toGrid = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = useEditor.getState().view, sc = PX * v.zoom;
    return { x: (e.clientX - r.left) / sc + v.x, y: (e.clientY - r.top) / sc + v.y };
  };
  /** Hit tolerance in grid units: about 7 screen pixels, but never more than a grid unit. */
  const tol = () => Math.min(1, Math.max(0.3, 7 / (PX * useEditor.getState().view.zoom)));
  const sch = () => useProject.getState().project.schematic;

  /** Snap for wiring/labels: nearest pin within reach, else nearest grid point. */
  const snapTarget = (p: Point): Point => hitPin(sch(), p, Math.max(0.6, tol()))?.point ?? snap(p);

  const isConnectionPoint = (g: Point) => {
    const s = sch();
    return !!hitPin(s, g, 0.01) || !!hitWire(s, g, 0.01) || s.labels.some((l) => l.position.x === g.x && l.position.y === g.y);
  };

  // ------------------------------------------------------------ wiring
  const finishWire = (pts: Point[]) => {
    A.commitWire(pts);
    usePointer.getState().set({ wire: [] });
    dirLocked.current = false;
    if (wireFromSelect.current) { wireFromSelect.current = false; useEditor.getState().setTool("select"); }
  };
  const cancelWire = () => {
    usePointer.getState().set({ wire: [] });
    dirLocked.current = false;
    if (wireFromSelect.current) { wireFromSelect.current = false; useEditor.getState().setTool("select"); }
  };
  /** Wire tool click at grid point g. */
  const wireClick = (g: Point, finish = false) => {
    const ps = usePointer.getState();
    if (!ps.wire.length) { ps.set({ wire: [g] }); dirLocked.current = false; return; }
    const last = ps.wire[ps.wire.length - 1];
    const route = routeAvoiding(last, g, ps.horizontalFirst, pinPoints(sch()));
    const pts = [...ps.wire, ...route.slice(1)];
    if (finish || (pts.length >= 2 && isConnectionPoint(g) && !(g.x === ps.wire[0].x && g.y === ps.wire[0].y && ps.wire.length === 1))) finishWire(pts);
    else if (g.x !== last.x || g.y !== last.y) { ps.set({ wire: pts }); dirLocked.current = false; }
  };

  // ------------------------------------------------------------ pointer handlers
  const capture = (e: React.PointerEvent) => { try { svgRef.current!.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } };
  const onPointerDown = (e: React.PointerEvent) => {
    wrapRef.current?.focus({ preventScroll: true });
    if (labelEdit) return;
    const p = toGrid(e), g = snap(p);
    const ed = useEditor.getState();
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault();
      capture(e);
      gesture.current = { kind: "pan", client: { x: e.clientX, y: e.clientY }, origin: ed.view };
      return;
    }
    if (e.button !== 0) return;
    if (ed.floating) { A.moveFloating(g); A.dropFloating(); return; }
    capture(e);
    const t = ed.tool;
    if (typeof t === "object") { A.placePart(t.place, g, ed.placeRotation, ed.placeMirror); return; }
    if (t === "wire") { wireClick(snapTarget(p)); gesture.current = { kind: "wire-drag", client: { x: e.clientX, y: e.clientY } }; return; }
    if (t === "label") {
      e.preventDefault(); // keep the default mousedown focus from stealing focus from the inline editor
      const at = snapTarget(p);
      setLabelEdit({ at, value: A.suggestLabelName() });
      return;
    }
    // select tool: press on a pin tip starts a wire (click-click or drag)
    const s = sch();
    const pin = hitPin(s, p, Math.min(0.5, tol()));
    const hit = hitTest(s, p, tol());
    if (pin && !e.shiftKey) {
      wireFromSelect.current = true;
      ed.setTool("wire");
      usePointer.getState().set({ wire: [pin.point] });
      dirLocked.current = false;
      gesture.current = { kind: "wire-drag", client: { x: e.clientX, y: e.clientY } };
      return;
    }
    const sel = useProject.getState().selection;
    if (hit) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        A.select(sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]);
        return;
      }
      const ids = sel.includes(hit.id) ? A.liveSelection() : [hit.id];
      if (!sel.includes(hit.id)) A.select(ids);
      gesture.current = { kind: "move", start: g, base: s, ids, label: "", moved: false, dx: 0, dy: 0 };
      return;
    }
    gesture.current = { kind: "marquee", a: p, add: e.shiftKey, prev: sel };
    if (!e.shiftKey) A.select([]);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toGrid(e);
    const ps = usePointer.getState();
    const t = useEditor.getState().tool;
    const g = t === "wire" || t === "label" ? snapTarget(p) : snap(p);
    const patch: Partial<typeof ps> = {};
    if (!ps.cursor || ps.cursor.x !== g.x || ps.cursor.y !== g.y) patch.cursor = g;
    // sticky wire direction: decided by the first real movement away from the last vertex
    if (ps.wire.length && !dirLocked.current) {
      const last = ps.wire[ps.wire.length - 1];
      const dx = Math.abs(g.x - last.x), dy = Math.abs(g.y - last.y);
      if (dx || dy) patch.horizontalFirst = dx >= dy;
      if (Math.max(dx, dy) >= 2) dirLocked.current = true;
    }
    const gs = gesture.current;
    if (useEditor.getState().floating && !gs) A.moveFloating(snap(p));
    if (gs?.kind === "pan") {
      const sc = PX * gs.origin.zoom;
      useEditor.getState().setView({ ...gs.origin, x: gs.origin.x - (e.clientX - gs.client.x) / sc, y: gs.origin.y - (e.clientY - gs.client.y) / sc });
    } else if (gs?.kind === "move") {
      const dx = g.x - gs.start.x, dy = g.y - gs.start.y;
      if (dx !== gs.dx || dy !== gs.dy) {
        gs.dx = dx; gs.dy = dy;
        const next = moveItems(gs.base, new Set(gs.ids), dx, dy);
        const cur = sch();
        if (!gs.label) gs.label = `Move ${describe(gs.base, gs.ids)}`;
        // first change of a drag opens a new undo step, the rest fold into it
        useProject.getState().update(gs.label, (d) => A.setSchematic(d, next, cur), { merge: gs.moved });
        if (!gs.moved) setDragging(true);
        gs.moved = true;
      }
    } else if (gs?.kind === "marquee") {
      patch.marquee = { a: gs.a, b: p };
    } else if (!gs) {
      patch.hover = hoverAt(p, t);
    }
    if (Object.keys(patch).length) ps.set(patch);
  };

  const hoverAt = (p: Point, t: typeof tool): Hover | null => {
    const s = sch();
    const pin = hitPin(s, p, Math.min(0.5, tol()));
    if (pin) return { kind: "pin", id: pin.id, pinId: pin.pinId };
    if (t !== "select") { const w = hitWire(s, p, tol()); return w ? { kind: "wire", id: w.id } : null; }
    const h = hitTest(s, p, tol());
    return h ? (h.kind === "pin" ? { kind: "pin", id: h.id, pinId: h.pinId } : { kind: h.kind, id: h.id }) : null;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const gs = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!gs) return;
    if (gs.kind === "marquee") {
      const b = toGrid(e);
      usePointer.getState().set({ marquee: null });
      const r = { x: Math.min(gs.a.x, b.x), y: Math.min(gs.a.y, b.y), w: Math.abs(b.x - gs.a.x), h: Math.abs(b.y - gs.a.y) };
      if (r.w < 0.3 && r.h < 0.3) return;
      const ids = itemsInRect(sch(), r, b.x >= gs.a.x ? "inside" : "touch");
      A.select(gs.add ? [...new Set([...gs.prev, ...ids])] : ids);
    } else if (gs.kind === "wire-drag") {
      // a press-drag-release while wiring acts as a click at the release point
      if (Math.hypot(e.clientX - gs.client.x, e.clientY - gs.client.y) > 6) wireClick(snapTarget(toGrid(e)));
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = toGrid(e);
    const t = useEditor.getState().tool;
    if (t === "wire") {
      const ps = usePointer.getState();
      if (ps.wire.length >= 2) finishWire(ps.wire);
      return;
    }
    if (t !== "select") return;
    const hit = hitTest(sch(), p, tol());
    if (hit?.kind === "label") {
      const l = sch().labels.find((x) => x.id === hit.id)!;
      setLabelEdit({ id: l.id, at: l.position, value: l.name });
    } else if (hit?.kind === "component") {
      // jump to the first editable value in the Properties panel
      setTimeout(() => (document.querySelector(".props input:not([type=checkbox])") as HTMLInputElement | null)?.select(), 0);
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault(); // also stops Ctrl+wheel / pinch from zooming the whole window
    const v = useEditor.getState().view;
    if (e.shiftKey) { useEditor.getState().setView({ ...v, x: v.x + e.deltaY / (PX * v.zoom) }); return; }
    const p = toGrid(e);
    const zoom = clampZoom(v.zoom * Math.pow(1.0015, -e.deltaY));
    const r = svgRef.current!.getBoundingClientRect();
    const s2 = PX * zoom;
    useEditor.getState().setView({ zoom, x: p.x - (e.clientX - r.left) / s2, y: p.y - (e.clientY - r.top) / s2 });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ed = useEditor.getState(), ps = usePointer.getState();
    if (ed.floating) A.cancelFloating();
    else if (ps.wire.length) cancelWire();
    else if (ed.tool !== "select") ed.setTool("select");
  };

  // ------------------------------------------------------------ drag and drop from the library
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PART_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const g = snap(toGrid(e));
    const ps = usePointer.getState();
    if (!ps.cursor || ps.cursor.x !== g.x || ps.cursor.y !== g.y) ps.set({ cursor: g });
  };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(PART_MIME) || usePointer.getState().dropPart;
    if (!id) return;
    e.preventDefault();
    const ed = useEditor.getState();
    A.placePart(id, snap(toGrid(e)), ed.placeRotation, ed.placeMirror);
    usePointer.getState().set({ dropPart: null });
    wrapRef.current?.focus({ preventScroll: true });
  };

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editable(e.target) || e.defaultPrevented) return;
      const active = document.activeElement;
      const inEditor = !!wrapRef.current?.contains(active) || (pointerInside.current && !editable(active));
      if (e.key === " " && e.type === "keyup") { space.current = false; wrapRef.current?.classList.remove("panning"); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // Undo/redo work wherever focus is (except text fields, which keep their own undo).
      if (e.type === "keydown" && ctrl && (k === "z" || k === "y")) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) useProject.getState().redo(); else useProject.getState().undo();
        return;
      }
      if (e.type !== "keydown" || !inEditor) return;
      const ed = useEditor.getState(), ps = usePointer.getState();
      const placing = typeof ed.tool === "object" || !!ps.dropPart;
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === " ") { handled(); space.current = true; wrapRef.current?.classList.add("panning"); return; }
      if (ctrl) {
        if (k === "a") { handled(); A.selectAll(); }
        else if (k === "c") { handled(); A.copySelection(); }
        else if (k === "x") { handled(); A.cutSelection(); }
        else if (k === "v") { handled(); A.paste(); }
        else if (k === "d") { handled(); A.duplicateSelection(); }
        else if (k === "0") { handled(); fit(); }
        return;
      }
      if (e.altKey) return;
      switch (k) {
        case "Escape":
          handled();
          if (ed.helpOpen) ed.setHelpOpen(false);
          else if (ed.floating) A.cancelFloating();
          else if (ps.wire.length) cancelWire();
          else if (ed.tool !== "select") ed.setTool("select");
          else A.select([]);
          return;
        case "?": handled(); ed.setHelpOpen(!ed.helpOpen); return;
        case "f": case "Home": handled(); fit(); return;
        case "+": case "=": handled(); zoomBy(1.25); return;
        case "-": case "_": handled(); zoomBy(0.8); return;
        case "w": handled(); ed.setTool("wire"); return;
        case "l": handled(); ed.setTool("label"); return;
        case "/": handled(); ps.set({ horizontalFirst: !ps.horizontalFirst }); dirLocked.current = true; return;
        case "r": handled(); if (placing) ed.rotatePlacement(); else A.rotateSelection(e.shiftKey); return;
        case "x": handled(); if (placing) ed.mirrorPlacement(); else A.mirrorSelection(); return;
        case "Enter":
          if (ps.wire.length >= 2) { handled(); finishWire(ps.wire); }
          else if (ed.tool === "select") {
            const l = sch().labels.find((x) => x.id === useProject.getState().selection[0]);
            if (l && useProject.getState().selection.length === 1) { handled(); setLabelEdit({ id: l.id, at: l.position, value: l.name }); }
          }
          return;
        case "Delete": case "Backspace":
          handled();
          if (ps.wire.length) { const w = ps.wire.slice(0, -1); ps.set({ wire: w }); if (!w.length) cancelWire(); }
          else A.deleteSelection();
          return;
        case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown": {
          handled();
          const step = e.shiftKey ? 10 : 1;
          const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, dy = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
          if (ed.tool === "select" && A.liveSelection().length) A.nudgeSelection(dx * step, dy * step);
          else { const v = ed.view, px = 60 * (e.shiftKey ? 4 : 1) / (PX * v.zoom); ed.setView({ ...v, x: v.x + dx * px, y: v.y + dy * px }); }
          return;
        }
      }
    };
    const onBlur = () => { space.current = false; wrapRef.current?.classList.remove("panning"); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); window.removeEventListener("blur", onBlur); };
  }, [fit]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomBy = (f: number) => {
    const v = useEditor.getState().view, { w, h } = sizeRef.current;
    const zoom = clampZoom(v.zoom * f);
    const cx = v.x + w / 2 / (PX * v.zoom), cy = v.y + h / 2 / (PX * v.zoom);
    useEditor.getState().setView({ zoom, x: cx - w / 2 / (PX * zoom), y: cy - h / 2 / (PX * zoom) });
  };

  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const el = svgRef.current!;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  // Leaving wire mode by any route (toolbar, Esc) drops the in-progress wire.
  useEffect(() => { if (tool !== "wire") { usePointer.getState().set({ wire: [] }); wireFromSelect.current = false; } }, [tool]);

  // DC operating-point annotations by net.
  const opVolts = useMemo(() => {
    const m = new Map<string, number>();
    if (result?.ok && result.analysis === "op") for (const v of result.vectors) if (v.kind === "voltage" && v.netName) m.set(v.netName, v.real[0]);
    return m;
  }, [result]);

  const selSet = useMemo(() => new Set(selection), [selection]);
  const symW = Math.min(3, Math.max(1.25, scale * 0.12));
  const wireW = Math.min(4, Math.max(1.6, scale * 0.16));
  const cursorClass = typeof tool === "object" ? "placing" : tool === "wire" || tool === "label" ? "drawing" : "";

  return (
    <div ref={wrapRef} className={`sb-editor ${cursorClass}`} tabIndex={-1}
      onPointerEnter={() => { pointerInside.current = true; }}
      onPointerLeave={() => { pointerInside.current = false; usePointer.getState().set({ cursor: null, hover: null }); }}>
      <svg ref={svgRef} className="sb-canvas" role="application" aria-label="Schematic canvas. Press ? for keyboard shortcuts."
        style={{ ["--sym-w" as string]: `${symW}px`, ["--wire-w" as string]: `${wireW}px` }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { gesture.current = null; setDragging(false); usePointer.getState().set({ marquee: null }); }}
        onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
        onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => usePointer.getState().set({ cursor: null })}>
        <Grid view={view} w={size.w} h={size.h} />
        <g transform={`scale(${scale}) translate(${-view.x},${-view.y})`}>
          <Scene schematic={schematic} selSet={selSet} conn={conn} flash={flash.on ? flash.n : 0} />
          <NetHighlight schematic={schematic} conn={conn} />
          <OpAnnotations conn={conn} opVolts={opVolts} />
          <SimCanvasOverlay />
          <Overlay schematic={schematic} />
        </g>
      </svg>
      {labelEdit && (
        <LabelEditor edit={labelEdit} view={view}
          onDone={(name) => {
            const n = name?.trim();
            if (n) { if (labelEdit.id) A.renameLabel(labelEdit.id, n); else A.addLabel(n, labelEdit.at); }
            setLabelEdit(null);
            if (!labelEdit.id) useEditor.getState().setTool("select");
            wrapRef.current?.focus({ preventScroll: true });
          }} />
      )}
      <StatusBar onFit={fit} onZoom={zoomBy} />
      <HelpOverlay />
    </div>
  );
});

function describe(s: Schematic, ids: string[]) {
  if (ids.length > 3) return `${ids.length} items`;
  return ids.map((id) => s.components.find((c) => c.id === id)?.ref ?? (s.wires.some((w) => w.id === id) ? "wire" : s.labels.find((l) => l.id === id)?.name ?? "item")).join(", ");
}

// ---------------------------------------------------------------- grid

const STEPS = [1, 2, 5, 10, 20, 50, 100];
const Grid = memo(function Grid({ view, w, h }: { view: View; w: number; h: number }) {
  const scale = PX * view.zoom;
  const minor = STEPS.find((s) => s * scale >= 9) ?? 100;
  const major = STEPS.find((s) => s >= minor * 5 && s % 10 === 0 && s * scale >= 50) ?? 100;
  const ms = minor * scale, Ms = major * scale;
  const ox = -view.x * scale, oy = -view.y * scale;
  const r = Math.min(1.6, Math.max(1, ms / 14));
  return (
    <g aria-hidden="true">
      <defs>
        <pattern id="sb-grid-minor" width={ms} height={ms} patternUnits="userSpaceOnUse" x={ox} y={oy}>
          <circle cx={0} cy={0} r={r} className="grid-dot" />
          <circle cx={ms} cy={0} r={r} className="grid-dot" />
          <circle cx={0} cy={ms} r={r} className="grid-dot" />
          <circle cx={ms} cy={ms} r={r} className="grid-dot" />
        </pattern>
        <pattern id="sb-grid-major" width={Ms} height={Ms} patternUnits="userSpaceOnUse" x={ox} y={oy}>
          <path d={`M0,0 H${Ms} M0,0 V${Ms}`} className="grid-major" />
        </pattern>
      </defs>
      <rect width={w} height={h} fill="url(#sb-grid-major)" />
      <rect width={w} height={h} fill="url(#sb-grid-minor)" />
      {/* origin marker */}
      <path d={`M${ox - 8},${oy} H${ox + 8} M${ox},${oy - 8} V${oy + 8}`} className="grid-origin" />
    </g>
  );
});

// ---------------------------------------------------------------- scene

const Scene = memo(function Scene({ schematic, selSet, conn, flash }: { schematic: Schematic; selSet: Set<string>; conn: Connectivity; flash: number }) {
  // pins that touch nothing else get an open-pin marker
  const openPins = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of conn.nets) {
      if (n.pins.length === 1 && !n.wireIds.length && !n.labelNames.length) {
        const p = n.pins[0];
        m.set(p.componentId, [...(m.get(p.componentId) ?? []), p.pinId]);
      }
    }
    return m;
  }, [conn]);
  return (
    <>
      <g className="wires">
        {schematic.wires.map((w) => <WireView key={w.id} wire={w} selected={selSet.has(w.id)} />)}
      </g>
      <g className="junctions">
        {conn.junctions.map((j) => <circle key={keyOf(j)} cx={j.x} cy={j.y} r={0.38} className="junction" />)}
      </g>
      <g className="parts">
        {schematic.components.map((c) => (
          <PartView key={c.id} inst={c} def={getPart(c.type)} selected={selSet.has(c.id)} open={openPins.get(c.id)?.join(",") ?? ""} />
        ))}
      </g>
      <g className="labels">
        {schematic.labels.map((l) => <LabelView key={l.id} label={l} selected={selSet.has(l.id)} />)}
      </g>
      {selSet.size > 0 && <SelectionHalos key={flash} schematic={schematic} selSet={selSet} flash={flash > 0} />}
    </>
  );
});

const WireView = memo(function WireView({ wire, selected }: { wire: Wire; selected: boolean }) {
  const pts = wire.points.map((q) => `${q.x},${q.y}`).join(" ");
  return (
    <>
      {selected && <polyline points={pts} className="wire-halo" />}
      <polyline points={pts} className={`wire ${selected ? "selected" : ""}`} />
    </>
  );
});

function displayValue(inst: ComponentInstance, def: ComponentDef, key: string): string {
  const pd = def.props.find((p) => p.key === key);
  const raw = String(inst.props[key] ?? pd?.default ?? "");
  if (!pd?.unit || raw === "") return raw;
  if (/[a-zA-ZÎ©Â°%]$/.test(raw) && !/[TGMkKmuÂµnpf]$/.test(raw) && !/meg$/i.test(raw)) return raw;
  return Number.isNaN(parseSI(raw)) ? raw : `${raw}${/^\d/.test(pd.unit) ? " " : ""}${pd.unit}`;
}

const PartView = memo(function PartView({ inst: c, def, selected, open }: { inst: ComponentInstance; def: ComponentDef | undefined; selected: boolean; open: string }) {
  if (!def) {
    return (
      <g className="part unknown">
        <rect x={c.position.x - 2} y={c.position.y - 1} width={4} height={2} className="unknown-box" />
        <text x={c.position.x} y={c.position.y} fontSize={0.9} textAnchor="middle" dominantBaseline="central" className="unknown-text">? {c.type}</text>
      </g>
    );
  }
  const b = componentBounds(c, def);
  const tall = b.h >= b.w;
  const lines = def.role === "ground" ? [] : [c.ref, ...(def.displayProps ?? []).map((k) => displayValue(c, def, k))];
  const tx = tall ? b.x + b.w + 0.7 : b.x + b.w / 2;
  const ty = tall ? b.y + b.h / 2 - (lines.length - 1) * 0.65 : b.y - 1 - (lines.length - 1) * 1.3;
  return (
    <g className={`part ${selected ? "selected" : ""}`}>
      <title>{`${c.ref} Â· ${def.name}`}</title>
      <rect x={b.x - 0.3} y={b.y - 0.3} width={b.w + 0.6} height={b.h + 0.6} className="part-hit" />
      <g transform={`translate(${c.position.x},${c.position.y}) rotate(${c.rotation}) scale(${c.mirror ? -1 : 1},1)`} color={selected ? "var(--ed-sel)" : "var(--symbol)"}>
        <SymbolShapes shapes={def.symbol} />
      </g>
      {lines.length > 0 && (
        <text x={tx} y={ty} fontSize={1.1} textAnchor={tall ? "start" : "middle"} dominantBaseline="central" className="part-text">
          {lines.map((t, i) => <tspan key={i} x={tx} dy={i === 0 ? 0 : 1.3} className={i === 0 ? "ref" : "val"}>{t}</tspan>)}
        </text>
      )}
      {open && open.split(",").map((pid) => {
        const pp = pinWorldPosition(c, def, pid);
        return pp ? <rect key={pid} x={pp.x - 0.3} y={pp.y - 0.3} width={0.6} height={0.6} className="pin-open" /> : null;
      })}
    </g>
  );
});

const LabelView = memo(function LabelView({ label: l, selected }: { label: NetLabel; selected: boolean }) {
  const b = labelBounds(l);
  return (
    <g className={`netlabel ${selected ? "selected" : ""}`}>
      <title>{`Net label ${l.name}. Double-click to rename.`}</title>
      <rect x={b.x} y={b.y} width={b.w} height={b.h - 0.4} rx={0.3} className="netlabel-bg" />
      <circle cx={l.position.x} cy={l.position.y} r={0.28} className="netlabel-dot" />
      <text x={l.position.x + 0.2} y={l.position.y - 0.55} fontSize={1.1} className="netlabel-text">{l.name}</text>
    </g>
  );
});

function SelectionHalos({ schematic, selSet, flash }: { schematic: Schematic; selSet: Set<string>; flash: boolean }) {
  const boxes: Rect[] = [];
  for (const c of schematic.components) {
    if (!selSet.has(c.id)) continue;
    const def = getPart(c.type);
    boxes.push(def ? componentBounds(c, def) : { x: c.position.x - 2, y: c.position.y - 1, w: 4, h: 2 });
  }
  for (const l of schematic.labels) if (selSet.has(l.id)) boxes.push(labelBounds(l));
  return (
    <g className={`sel-halos ${flash ? "flash" : ""}`} aria-hidden="true">
      {boxes.map((b, i) => <rect key={i} x={b.x - 0.6} y={b.y - 0.6} width={b.w + 1.2} height={b.h + 1.2} rx={0.5} className="sel-box" />)}
    </g>
  );
}

// ---------------------------------------------------------------- hover highlight, overlays

function NetHighlight({ schematic, conn }: { schematic: Schematic; conn: Connectivity }) {
  const hover = usePointer((s) => s.hover);
  const net = useMemo(() => {
    if (!hover) return undefined;
    if (hover.kind === "wire") return conn.nets.find((n) => n.wireIds.includes(hover.id));
    if (hover.kind === "pin") { const name = conn.pinNet.get(`${hover.id}:${hover.pinId}`); return conn.nets.find((n) => n.name === name); }
    return undefined;
  }, [hover, conn]);
  if (!hover) return null;
  const pinRing = hover.kind === "pin" ? (() => {
    const c = schematic.components.find((x) => x.id === hover.id);
    const def = c && getPart(c.type);
    return c && def ? pinWorldPosition(c, def, hover.pinId) : undefined;
  })() : undefined;
  const wires = net ? schematic.wires.filter((w) => net.wireIds.includes(w.id)) : [];
  const pins = net ? net.pins.map((p) => {
    const c = schematic.components.find((x) => x.id === p.componentId);
    const def = c && getPart(c.type);
    return c && def ? pinWorldPosition(c, def, p.pinId) : undefined;
  }).filter((p): p is Point => !!p) : [];
  return (
    <g className="net-hl" aria-hidden="true">
      {wires.map((w) => <polyline key={w.id} points={w.points.map((q) => `${q.x},${q.y}`).join(" ")} className="net-hl-wire" />)}
      {pins.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={0.35} className="net-hl-pin" />)}
      {pinRing && <circle cx={pinRing.x} cy={pinRing.y} r={0.6} className="pin-hover" />}
      {net && (hover.kind === "wire" || hover.kind === "pin") && pins.length + wires.length > 0 && (() => {
        const at = pinRing ?? wires[0]?.points[0];
        return at ? <text x={at.x + 0.8} y={at.y + 1.6} fontSize={0.95} className="net-hl-name">{net.isGround ? "GND (0)" : net.name}</text> : null;
      })()}
    </g>
  );
}

function OpAnnotations({ conn, opVolts }: { conn: Connectivity; opVolts: Map<string, number> }) {
  if (!opVolts.size) return null;
  return (
    <g className="op-annot">
      {[...opVolts].map(([net, v]) => {
        const n = conn.nets.find((x) => x.name === net);
        if (!n || net === "0" || !n.points.length) return null;
        const pt = n.points.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a));
        const t = formatSI(v, "V");
        return (
          <g key={net}>
            <rect x={pt.x + 0.4} y={pt.y + 0.3} width={t.length * 0.62 + 0.6} height={1.4} rx={0.3} className="op-bg" />
            <text x={pt.x + 0.7} y={pt.y + 1.0} fontSize={1} dominantBaseline="central" className="op-fg">{t}</text>
          </g>
        );
      })}
    </g>
  );
}

function Overlay({ schematic }: { schematic: Schematic }) {
  const cursor = usePointer((s) => s.cursor);
  const wire = usePointer((s) => s.wire);
  const hf = usePointer((s) => s.horizontalFirst);
  const marquee = usePointer((s) => s.marquee);
  const dropPart = usePointer((s) => s.dropPart);
  const tool = useEditor((s) => s.tool);
  const rot = useEditor((s) => s.placeRotation);
  const mir = useEditor((s) => s.placeMirror);
  const ghostId = dropPart ?? (typeof tool === "object" ? tool.place : null);
  const ghost = ghostId ? getPart(ghostId) : undefined;
  const pins = useMemo(() => (tool === "wire" ? pinPoints(schematic) : []), [tool, schematic]);
  return (
    <g className="overlay" aria-hidden="true">
      {tool === "wire" && wire.length > 0 && cursor && (() => {
        const last = wire[wire.length - 1];
        const pts = [...wire, ...routeAvoiding(last, cursor, hf, pins).slice(1)];
        return <>
          <polyline points={wire.map((q) => `${q.x},${q.y}`).join(" ")} className="wire-draft" />
          <polyline points={pts.slice(wire.length - 1).map((q) => `${q.x},${q.y}`).join(" ")} className="wire-preview" />
          <circle cx={wire[0].x} cy={wire[0].y} r={0.3} className="wire-start" />
        </>;
      })()}
      {(tool === "wire" || tool === "label") && cursor && (
        <path d={`M${cursor.x - 0.8},${cursor.y} H${cursor.x + 0.8} M${cursor.x},${cursor.y - 0.8} V${cursor.y + 0.8}`} className="cursor-cross" />
      )}
      {ghost && cursor && (
        <g transform={`translate(${cursor.x},${cursor.y}) rotate(${rot}) scale(${mir ? -1 : 1},1)`} color="var(--ed-sel)" className="ghost">
          <SymbolShapes shapes={ghost.symbol} />
          {ghost.pins.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={0.25} className="ghost-pin" />)}
        </g>
      )}
      {marquee && (() => {
        const x = Math.min(marquee.a.x, marquee.b.x), y = Math.min(marquee.a.y, marquee.b.y);
        const touch = marquee.b.x < marquee.a.x;
        return <rect x={x} y={y} width={Math.abs(marquee.b.x - marquee.a.x)} height={Math.abs(marquee.b.y - marquee.a.y)} className={`marquee ${touch ? "touch" : ""}`} />;
      })()}
    </g>
  );
}

function LabelEditor({ edit, view, onDone }: { edit: { id?: string; at: Point; value: string }; view: View; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(edit.value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const mountedAt = useRef(0);
  useEffect(() => {
    mountedAt.current = performance.now();
    ref.current?.focus(); ref.current?.select();
  }, []);
  const s = PX * view.zoom;
  const finish = (v: string | null) => { if (done.current) return; done.current = true; onDone(v); };
  const invalid = !value.trim();
  return (
    <div className="label-editor" style={{ left: (edit.at.x - view.x) * s, top: (edit.at.y - view.y) * s }}>
      <input ref={ref} value={value} aria-label={edit.id ? "Rename net label" : "New net label name"} aria-invalid={invalid}
        onChange={(e) => setValue(e.target.value)} spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !invalid) finish(value);
          else if (e.key === "Escape") finish(null);
        }}
        onBlur={() => {
          // a blur right after opening comes from the click that opened us: take focus back
          if (performance.now() - mountedAt.current < 250) { setTimeout(() => ref.current?.focus(), 0); return; }
          finish(invalid ? null : value);
        }} />
      <span>{edit.id ? "Enter to rename Â· Esc to cancel" : "Name this net Â· Enter to place Â· Esc to cancel"}{/^(gnd|0)$/i.test(value.trim()) ? " Â· connects to ground" : ""}</span>
    </div>
  );
}
