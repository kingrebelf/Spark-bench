// Schematic canvas (first version). Grid, zoom (wheel), pan (middle-drag or Space+drag),
// placement, wiring, selection, move, rotate, delete.
import { useEffect, useMemo, useRef, useState } from "react";
import { computeConnectivity } from "../core/connectivity";
import { keyOf, pinWorldPosition, transformPoint } from "../core/geometry";
import { getPart } from "../core/library";
import { newId } from "../core/project";
import { useProject } from "../core/store";
import type { ComponentInstance, Point, Rotation } from "../core/types";
import { formatSI } from "../core/units";
import { useSim } from "../sim/store";
import { SymbolShapes, symbolBounds } from "./SymbolView";
import { useEditor } from "./store";

const PX = 12; // pixels per grid unit at zoom 1

export function nextRef(prefix: string, comps: ComponentInstance[]): string {
  let n = 1;
  const used = new Set(comps.map((c) => c.ref));
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function Canvas() {
  const { project, update, selection, setSelection } = useProject();
  const { tool, setTool } = useEditor();
  const result = useSim((s) => s.result);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -20, y: -15, zoom: 1.4 });
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [wirePts, setWirePts] = useState<Point[]>([]);
  const drag = useRef<{ kind: "pan" | "move"; start: Point; origin: Point; ids?: string[]; last?: Point } | null>(null);
  const space = useRef(false);

  const conn = useMemo(() => computeConnectivity(project), [project]);
  const scale = PX * view.zoom;

  const toGrid = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale + view.x, y: (e.clientY - r.top) / scale + view.y };
  };
  const snap = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

  const hitComponent = (p: Point): ComponentInstance | undefined => {
    for (const c of [...project.schematic.components].reverse()) {
      const def = getPart(c.type); if (!def) continue;
      const b = symbolBounds(def.symbol, def.pins);
      const local = transformPoint({ x: p.x - c.position.x, y: p.y - c.position.y }, ((360 - c.rotation) % 360) as Rotation);
      const lx = c.mirror ? -local.x : local.x;
      if (lx >= b.x - 0.5 && lx <= b.x + b.w + 0.5 && local.y >= b.y - 0.5 && local.y <= b.y + b.h + 0.5) return c;
    }
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === " ") space.current = e.type === "keydown";
      if (e.type !== "keydown") return;
      const st = useProject.getState();
      if (e.key === "Escape") { setWirePts([]); setTool("select"); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? st.redo() : st.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); st.redo(); }
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (!st.selection.length) return;
        const ids = new Set(st.selection);
        st.update("Delete", (d) => {
          d.schematic.components = d.schematic.components.filter((c) => !ids.has(c.id));
          d.schematic.wires = d.schematic.wires.filter((w) => !ids.has(w.id));
          d.schematic.labels = d.schematic.labels.filter((l) => !ids.has(l.id));
        });
        st.setSelection([]);
      } else if (e.key.toLowerCase() === "r" && !e.ctrlKey) {
        const ids = new Set(st.selection);
        st.update("Rotate", (d) => { for (const c of d.schematic.components) if (ids.has(c.id)) c.rotation = ((c.rotation + 90) % 360) as Rotation; });
      } else if (e.key.toLowerCase() === "w" && !e.ctrlKey) setTool("wire");
    };
    window.addEventListener("keydown", onKey); window.addEventListener("keyup", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); };
  }, [setTool]);

  const onWheel = (e: React.WheelEvent) => {
    const p = toGrid(e);
    const zoom = Math.min(8, Math.max(0.2, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const s2 = PX * zoom;
    const r = svgRef.current!.getBoundingClientRect();
    setView({ zoom, x: p.x - (e.clientX - r.left) / s2, y: p.y - (e.clientY - r.top) / s2 });
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toGrid(e), g = snap(p);
    if (e.button === 1 || space.current) { drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, origin: { x: view.x, y: view.y } }; return; }
    if (e.button !== 0) return;
    if (typeof tool === "object") {
      const def = getPart(tool.place)!;
      const id = newId("c");
      update(`Place ${def.name}`, (d) => {
        d.schematic.components.push({ id, type: def.id, ref: nextRef(def.refPrefix, d.schematic.components), position: g, rotation: 0,
          props: Object.fromEntries(def.props.map((pp) => [pp.key, pp.default])) });
      });
      setSelection([id]);
      if (!e.shiftKey) setTool("select");
      return;
    }
    if (tool === "wire") {
      const last = wirePts[wirePts.length - 1];
      const next = last && last.x !== g.x && last.y !== g.y ? [{ x: g.x, y: last.y }, g] : [g];
      const pts = [...wirePts, ...next];
      const ends = conn.pointNet.has(keyOf(g)) && wirePts.length > 0;
      if (ends || e.detail >= 2) {
        if (pts.length >= 2) update("Add wire", (d) => { d.schematic.wires.push({ id: newId("w"), points: dedupe(pts) }); });
        setWirePts([]);
      } else setWirePts(pts);
      return;
    }
    if (tool === "label") {
      // Electron has no window.prompt; the new label is selected so it can be renamed in Properties.
      const id = newId("l");
      update("Add label", (d) => { d.schematic.labels.push({ id, name: `NET${d.schematic.labels.length + 1}`, position: g, rotation: 0 }); });
      setSelection([id]);
      setTool("select");
      return;
    }
    const hit = hitComponent(p);
    const wire = !hit && project.schematic.wires.find((w) => w.points.some((q, i) => i > 0 && distToSeg(p, w.points[i - 1], q) < 0.4));
    const label = !hit && !wire && project.schematic.labels.find((l) => Math.hypot(l.position.x - p.x, l.position.y - p.y) < 1);
    const id = hit?.id ?? (wire || undefined)?.id ?? (label || undefined)?.id;
    if (!id) { setSelection([]); return; }
    const ids = e.shiftKey ? [...new Set([...selection, id])] : selection.includes(id) ? selection : [id];
    setSelection(ids);
    drag.current = { kind: "move", start: g, origin: g, ids, last: g };
  };

  const onMove = (e: React.PointerEvent) => {
    const p = toGrid(e);
    setCursor(snap(p));
    const d = drag.current; if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, x: d.origin.x - (e.clientX - d.start.x) / scale, y: d.origin.y - (e.clientY - d.start.y) / scale }));
    } else {
      const g = snap(p);
      const dx = g.x - d.last!.x, dy = g.y - d.last!.y;
      if (!dx && !dy) return;
      d.last = g;
      const ids = new Set(d.ids);
      update("Move", (dr) => {
        for (const c of dr.schematic.components) if (ids.has(c.id)) { c.position.x += dx; c.position.y += dy; }
        for (const w of dr.schematic.wires) if (ids.has(w.id)) for (const q of w.points) { q.x += dx; q.y += dy; }
        for (const l of dr.schematic.labels) if (ids.has(l.id)) { l.position.x += dx; l.position.y += dy; }
      }, { merge: true });
    }
  };
  const onUp = () => {
    if (drag.current?.kind === "move") useProject.setState((s) => ({ past: s.past.map((h, i) => i === s.past.length - 1 && h.label === "Move" ? { ...h, label: "Move (done)" } : h) }));
    drag.current = null;
  };

  // DC operating point annotations by net.
  const opVolts = useMemo(() => {
    const m = new Map<string, number>();
    if (result?.ok && result.analysis === "op") for (const v of result.vectors) if (v.kind === "voltage" && v.netName) m.set(v.netName, v.real[0]);
    return m;
  }, [result]);

  const w = svgRef.current?.clientWidth ?? 1200, h = svgRef.current?.clientHeight ?? 800;
  const selSet = new Set(selection);
  return (
    <svg ref={svgRef} className="canvas" onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onContextMenu={(e) => { e.preventDefault(); setWirePts([]); setTool("select"); }}
      style={{ cursor: tool === "select" ? "default" : "crosshair" }} aria-label="Schematic canvas">
      <defs>
        <pattern id="grid" width={scale} height={scale} patternUnits="userSpaceOnUse" x={-view.x * scale} y={-view.y * scale}>
          <circle cx={0.5} cy={0.5} r={view.zoom > 0.6 ? 0.9 : 0} fill="var(--grid)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
      <g transform={`scale(${scale}) translate(${-view.x},${-view.y})`}>
        {project.schematic.wires.map((wi) => (
          <polyline key={wi.id} points={wi.points.map((q) => `${q.x},${q.y}`).join(" ")} fill="none"
            stroke={selSet.has(wi.id) ? "var(--accent)" : "var(--wire)"} strokeWidth={selSet.has(wi.id) ? 3 : 2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        ))}
        {conn.junctions.map((j) => <circle key={keyOf(j)} cx={j.x} cy={j.y} r={0.35} fill="var(--wire)" />)}
        {project.schematic.components.map((c) => {
          const def = getPart(c.type);
          if (!def) return <text key={c.id} x={c.position.x} y={c.position.y} fill="var(--error)" fontSize={1}>? {c.type}</text>;
          const sel = selSet.has(c.id);
          const b = symbolBounds(def.symbol, def.pins);
          const vertical = c.rotation === 0 || c.rotation === 180 ? b.h >= b.w : b.w > b.h;
          const tx = vertical ? 2 : 0, ty = vertical ? 0 : -2.6;
          return (
            <g key={c.id} className="part">
              <g transform={`translate(${c.position.x},${c.position.y}) rotate(${c.rotation}) scale(${c.mirror ? -1 : 1},1)`} color={sel ? "var(--accent)" : "var(--symbol)"}>
                <SymbolShapes shapes={def.symbol} />
              </g>
              {def.role !== "ground" && (
                <text x={c.position.x + tx} y={c.position.y + ty} fontSize={1.1} fill="var(--text)" dominantBaseline="middle">
                  <tspan fontWeight={600}>{c.ref}</tspan>
                  {(def.displayProps ?? []).map((k) => {
                    const pd = def.props.find((pp) => pp.key === k);
                    return <tspan key={k} x={c.position.x + tx} dy={1.3} fill="var(--text-dim)">{String(c.props[k] ?? pd?.default ?? "")}{pd?.unit && !/[a-zA-ZΩ]$/.test(String(c.props[k] ?? "")) ? pd.unit : ""}</tspan>;
                  })}
                </text>
              )}
              {def.pins.map((pin) => {
                const pp = pinWorldPosition(c, def, pin.id)!;
                const connected = conn.pinNet.has(`${c.id}:${pin.id}`) && conn.nets.find((n) => n.name === conn.pinNet.get(`${c.id}:${pin.id}`))!.points.length > 1;
                return connected ? null : <circle key={pin.id} cx={pp.x} cy={pp.y} r={0.3} fill="none" stroke="var(--pin-open)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />;
              })}
            </g>
          );
        })}
        {project.schematic.labels.map((l) => (
          <g key={l.id}>
            <circle cx={l.position.x} cy={l.position.y} r={0.25} fill="var(--label)" />
            <text x={l.position.x + 0.5} y={l.position.y - 0.6} fontSize={1.1} fill={selSet.has(l.id) ? "var(--accent)" : "var(--label)"} fontWeight={600}>{l.name}</text>
          </g>
        ))}
        {[...opVolts].map(([net, v]) => {
          const n = conn.nets.find((x) => x.name === net); if (!n || net === "0") return null;
          const pt = n.points.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a));
          return <g key={net}><rect x={pt.x + 0.4} y={pt.y + 0.3} width={formatSI(v, "V").length * 0.62 + 0.6} height={1.4} rx={0.3} fill="var(--op-bg)" />
            <text x={pt.x + 0.7} y={pt.y + 1.05} fontSize={1} fill="var(--op-fg)" dominantBaseline="middle">{formatSI(v, "V")}</text></g>;
        })}
        {tool === "wire" && wirePts.length > 0 && (
          <polyline points={[...wirePts, ...(cursor.x !== wirePts[wirePts.length - 1].x && cursor.y !== wirePts[wirePts.length - 1].y ? [{ x: cursor.x, y: wirePts[wirePts.length - 1].y }] : []), cursor].map((q) => `${q.x},${q.y}`).join(" ")}
            fill="none" stroke="var(--accent)" strokeDasharray="4 3" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
        {typeof tool === "object" && (() => { const def = getPart(tool.place); return def ? <g opacity={0.5} transform={`translate(${cursor.x},${cursor.y})`} color="var(--accent)"><SymbolShapes shapes={def.symbol} /></g> : null; })()}
      </g>
      <text x={10} y={h - 10} fill="var(--text-dim)" fontSize={12}>{`x ${cursor.x}  y ${cursor.y}  ·  ${Math.round(view.zoom * 100)}%  ·  ${w > 0 ? "" : ""}`}</text>
    </svg>
  );
}

function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
}
function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
