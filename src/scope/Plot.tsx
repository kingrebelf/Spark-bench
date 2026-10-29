// Oscilloscope-style plot on Canvas 2D: stacked panes sharing one x axis, a left and right y axis per
// pane (e.g. volts and amps), min/max decimation, wheel zoom, box zoom, pan, two cursors, playhead.
//
// Mouse:  wheel = zoom time/frequency axis · Shift+wheel = zoom y · drag = box zoom ·
//         right/middle-drag or Alt+drag = pan · double-click = autoscale ·
//         click = cursor A (Shift+click = cursor B) when cursors are on, otherwise seek playback.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { formatSI } from "../core/units";
import { logTicks, niceTicks, tickLabel } from "./axes";
import { decimate } from "./decimate";
import { interpolate, lowerBound, measure, type Measurements } from "./measure";

export interface PlotSeries {
  id: string;
  label: string;
  color: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  pane: number;
  axis: "left" | "right";
  unit: string;
}
export interface AxisSpec { unit: string; label: string }
export interface PaneSpec { left?: AxisSpec; right?: AxisSpec }
export interface PlotHandle { toCanvas(): HTMLCanvasElement | null }

interface Props {
  series: PlotSeries[];
  panes: PaneSpec[];
  xUnit: string;
  xLabel: string;
  xLog?: boolean;
  /** Playback position (x units); draws a playhead and dims the not-yet-played part. */
  playhead?: number | null;
  /**
   * Data with x beyond this is not drawn, measured or read by cursors (live playback: the trace grows with
   * the playhead, and nothing past a change that is still being re-simulated is shown).
   */
  hideAfter?: number | null;
  /** Start of data that is being recomputed; marked on the plot. */
  pendingFrom?: number | null;
  /** Follow the playhead with a window of this x span when the data is longer (until you zoom). */
  follow?: number | null;
  onSeek?: (x: number) => void;
  /** Show the min/max/avg/RMS/pk-pk/frequency table (time-domain plots). */
  measurements?: boolean;
  height: number;
  handle?: Ref<PlotHandle>;
}

type Range = [number, number];
interface View { x: Range | null; y: Record<string, Range> }
type Drag =
  | { kind: "box"; pane: number; x0: number; y0: number; x1: number; y1: number; shift: boolean }
  | { kind: "pan"; pane: number; lastX: number; lastY: number }
  | { kind: "cursor"; which: "a" | "b" };

const M = { left: 62, right: 62, top: 8, bottom: 30, gap: 14 };

function cssVar(el: Element, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function Plot({ series, panes, xUnit, xLabel, xLog, playhead, hideAfter, pendingFrom, follow, onSeek, measurements, height, handle }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [view, setView] = useState<View>({ x: null, y: {} });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [cursorsOn, setCursorsOn] = useState(false);
  const [cursors, setCursors] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const drag = useRef<Drag | null>(null);
  const [box, setBox] = useState<Drag | null>(null);

  // Reset zoom when the data set changes (a new run).
  const firstX = series[0]?.x;
  useEffect(() => { setView({ x: null, y: {} }); setCursors({ a: null, b: null }); }, [firstX]);

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(() => series.filter((s) => !hidden.has(s.id)), [series, hidden]);

  // Full x extent of the data.
  const extent = useMemo<Range>(() => {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) if (s.x.length) { lo = Math.min(lo, s.x[0]); hi = Math.max(hi, s.x[s.x.length - 1]); }
    if (!Number.isFinite(lo)) return [0, 1];
    if (lo === hi) return xLog ? [lo / 2, hi * 2] : [lo - 0.5, hi + 0.5];
    return [lo, hi];
  }, [series, xLog]);
  const followRange = useMemo<Range | null>(() => {
    if (view.x || follow == null || playhead == null || xLog || extent[1] - extent[0] <= follow) return null;
    // Page like a scope in roll mode: the window jumps forward when the playhead nears its right edge.
    const page = follow * 0.75;
    const rel = playhead - extent[0];
    const k = rel <= follow * 0.9 ? 0 : Math.floor((rel - follow * 0.9) / page) + 1;
    const lo = Math.min(extent[1] - follow, extent[0] + k * page);
    return [lo, lo + follow];
  }, [view.x, follow, playhead, xLog, extent]);
  const xr: Range = view.x ?? followRange ?? extent;
  const lim = hideAfter ?? Infinity;

  const fx = useCallback((v: number) => (xLog ? Math.log10(Math.max(v, 1e-300)) : v), [xLog]);
  const ifx = useCallback((v: number) => (xLog ? 10 ** v : v), [xLog]);
  const plotW = Math.max(10, width - M.left - M.right);
  const paneH = Math.max(30, (height - M.top - M.bottom - M.gap * (panes.length - 1)) / panes.length);
  const paneTop = (p: number) => M.top + p * (paneH + M.gap);
  const xToPx = useCallback((v: number) => M.left + (fx(v) - fx(xr[0])) / (fx(xr[1]) - fx(xr[0])) * plotW, [fx, xr, plotW]);
  const pxToX = useCallback((px: number) => ifx(fx(xr[0]) + (px - M.left) / plotW * (fx(xr[1]) - fx(xr[0]))), [fx, ifx, xr, plotW]);

  // Autoscaled y ranges for every pane/axis that has no manual range.
  const yRanges = useMemo(() => {
    const out: Record<string, Range> = {};
    panes.forEach((spec, p) => (["left", "right"] as const).forEach((side) => {
      if (!spec[side]) return;
      const key = `${p}:${side}`;
      if (view.y[key]) { out[key] = view.y[key]; return; }
      let lo = Infinity, hi = -Infinity;
      for (const s of visible) {
        if (s.pane !== p || s.axis !== side) continue;
        const a = Math.max(0, lowerBound(s.x, xr[0]) - 1), b = Math.min(s.x.length, lowerBound(s.x, Math.min(xr[1], pendingFrom ?? Infinity)) + 1);
        for (let i = a; i < b; i++) { const v = s.y[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
      if (hi - lo < 1e-15 + Math.abs(hi) * 1e-9) { const d = Math.abs(hi) * 0.1 || 1; lo -= d; hi += d; }
      const pad = (hi - lo) * 0.06;
      out[key] = [lo - pad, hi + pad];
    }));
    return out;
  }, [panes, visible, view.y, xr]);

  const yToPx = (key: string, v: number) => {
    const [lo, hi] = yRanges[key]; const p = Number(key.split(":")[0]);
    return paneTop(p) + paneH - (v - lo) / (hi - lo) * paneH;
  };
  const pxToY = (key: string, px: number) => {
    const [lo, hi] = yRanges[key]; const p = Number(key.split(":")[0]);
    return lo + (paneTop(p) + paneH - px) / paneH * (hi - lo);
  };
  const paneAt = (py: number) => Math.max(0, Math.min(panes.length - 1, Math.floor((py - M.top) / (paneH + M.gap))));

  // Decimated traces for the current x view; recomputed only when the view or data changes.
  const decimated = useMemo(() => visible.map((s) => ({ s, d: decimate(s.x, s.y, xr[0], xr[1], Math.ceil(plotW), (v) => (fx(v) - fx(xr[0])) / (fx(xr[1]) - fx(xr[0])) * plotW) })),
    [visible, xr, plotW, fx]);

  // ---------------------------------------------------------------- drawing
  const drawBase = useCallback((ctx: CanvasRenderingContext2D, forExport = false) => {
    const el = baseRef.current!;
    const text = cssVar(el, "--text", "#ddd"), dim = cssVar(el, "--text-dim", "#999"), grid = cssVar(el, "--grid", "#333"), bg = cssVar(el, "--panel-2", "#1d252e");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    ctx.font = "11px " + cssVar(el, "--mono", "monospace");
    ctx.lineWidth = 1;
    // x ticks
    const xt = xLog ? logTicks(xr[0], xr[1]) : niceTicks(xr[0], xr[1], Math.max(2, Math.floor(plotW / 90))).map((value) => ({ value, major: true }));
    panes.forEach((spec, p) => {
      const top = paneTop(p);
      ctx.strokeStyle = grid;
      ctx.beginPath();
      for (const t of xt) { const px = Math.round(xToPx(t.value)) + 0.5; ctx.moveTo(px, top); ctx.lineTo(px, top + paneH); }
      ctx.stroke();
      (["left", "right"] as const).forEach((side) => {
        const ax = spec[side]; if (!ax) return;
        const key = `${p}:${side}`; const [lo, hi] = yRanges[key];
        const yt = niceTicks(lo, hi, Math.max(2, Math.floor(paneH / 40)));
        if (side === "left" || !spec.left) {
          ctx.strokeStyle = grid; ctx.beginPath();
          for (const v of yt) { const py = Math.round(yToPx(key, v)) + 0.5; ctx.moveTo(M.left, py); ctx.lineTo(M.left + plotW, py); }
          ctx.stroke();
        }
        ctx.fillStyle = dim; ctx.textBaseline = "middle"; ctx.textAlign = side === "left" ? "right" : "left";
        for (const v of yt) ctx.fillText(tickLabel(v, ax.unit), side === "left" ? M.left - 5 : M.left + plotW + 5, yToPx(key, v));
        ctx.save(); ctx.fillStyle = text; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.translate(side === "left" ? 2 : width - 14, top + paneH / 2); ctx.rotate(-Math.PI / 2);
        ctx.fillText(ax.label, 0, 0); ctx.restore();
      });
      ctx.strokeStyle = dim; ctx.strokeRect(M.left + 0.5, top + 0.5, plotW, paneH);
    });
    // x labels under the last pane
    const bottom = paneTop(panes.length - 1) + paneH;
    ctx.fillStyle = dim; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const t of xt) if (t.major || xt.length < 12) ctx.fillText(tickLabel(t.value, xUnit), xToPx(t.value), bottom + 4);
    ctx.fillStyle = text; ctx.textAlign = "right"; ctx.fillText(xLabel, M.left + plotW, bottom + 16);

    // traces, clipped per pane
    const ph = playhead != null && !forExport && hideAfter == null ? xToPx(playhead) : null;
    const cut = Number.isFinite(lim) ? Math.min(M.left + plotW, Math.max(M.left, xToPx(lim))) : null;
    for (const { s, d } of decimated) {
      const key = `${s.pane}:${s.axis}`; if (!yRanges[key]) continue;
      const top = paneTop(s.pane);
      const path = () => {
        ctx.beginPath();
        for (let i = 0; i < d.length; i++) { const px = xToPx(d.x[i]), py = yToPx(key, d.y[i]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
      };
      ctx.save(); ctx.beginPath(); ctx.rect(M.left, top, plotW, paneH); ctx.clip();
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
      if (cut != null) {
        // Nothing past the limit: not yet played, or waiting for the re-simulation.
        ctx.beginPath(); ctx.rect(M.left, top, cut - M.left, paneH); ctx.clip(); path(); ctx.stroke();
      } else if (ph != null) {
        // Played part bright, the rest faint: the waveform "draws" as playback advances.
        ctx.save(); ctx.beginPath(); ctx.rect(M.left, top, ph - M.left, paneH); ctx.clip(); path(); ctx.stroke(); ctx.restore();
        ctx.save(); ctx.globalAlpha = 0.22; ctx.beginPath(); ctx.rect(ph, top, M.left + plotW - ph, paneH); ctx.clip(); path(); ctx.stroke(); ctx.restore();
      } else { path(); ctx.stroke(); }
      ctx.restore();
    }
    if (pendingFrom != null && !forExport) {
      const px = xToPx(pendingFrom);
      if (px <= M.left + plotW) {
        const x0 = Math.max(M.left, px);
        ctx.save(); ctx.fillStyle = cssVar(el, "--accent", "#4fc3f7"); ctx.globalAlpha = 0.08;
        ctx.fillRect(x0, M.top, M.left + plotW - x0, bottom - M.top);
        ctx.globalAlpha = 1; ctx.fillStyle = text; ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText("re-simulating from 0 s with your change…", x0 + 4, M.top + 4);
        ctx.restore();
      }
    }
  }, [width, height, panes, xr, xLog, plotW, paneH, yRanges, decimated, xToPx, xUnit, xLabel, playhead, lim, pendingFrom]);

  const drawOverlay = useCallback((ctx: CanvasRenderingContext2D) => {
    const el = overRef.current!;
    ctx.clearRect(0, 0, width, height);
    const bottom = paneTop(panes.length - 1) + paneH;
    const accent = cssVar(el, "--accent", "#4fc3f7"), text = cssVar(el, "--text", "#ddd");
    ctx.font = "11px " + cssVar(el, "--mono", "monospace");
    if (playhead != null) {
      const px = Math.round(xToPx(playhead)) + 0.5;
      if (px >= M.left && px <= M.left + plotW) { ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px, M.top); ctx.lineTo(px, bottom); ctx.stroke(); }
    }
    if (cursorsOn) for (const which of ["a", "b"] as const) {
      const v = cursors[which]; if (v == null) continue;
      const px = Math.round(xToPx(v)) + 0.5;
      if (px < M.left || px > M.left + plotW) continue;
      ctx.strokeStyle = text; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, M.top); ctx.lineTo(px, bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = text; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(which.toUpperCase(), px + 3, M.top + 2);
    }
    if (box?.kind === "box") {
      ctx.strokeStyle = accent; ctx.fillStyle = "rgba(79,195,247,0.12)"; ctx.lineWidth = 1;
      const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1), w = Math.abs(box.x1 - box.x0), h = Math.abs(box.y1 - box.y0);
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
  }, [width, height, panes.length, paneH, playhead, xToPx, plotW, cursorsOn, cursors, box]);

  const setup = (c: HTMLCanvasElement | null) => {
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) { c.width = Math.round(width * dpr); c.height = Math.round(height * dpr); }
    const ctx = c.getContext("2d")!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  };
  useEffect(() => { const ctx = setup(baseRef.current); if (ctx) drawBase(ctx); });
  useEffect(() => { const ctx = setup(overRef.current); if (ctx) drawOverlay(ctx); });

  useImperativeHandle(handle, () => ({
    toCanvas() {
      if (!baseRef.current) return null;
      const legendH = 22;
      const c = document.createElement("canvas");
      c.width = width * 2; c.height = (height + legendH) * 2;
      const ctx = c.getContext("2d")!; ctx.scale(2, 2);
      drawBase(ctx, true);
      ctx.drawImage(overRef.current!, 0, 0, width, height);
      ctx.fillStyle = cssVar(baseRef.current, "--panel-2", "#1d252e"); ctx.fillRect(0, height, width, legendH);
      ctx.font = "12px " + cssVar(baseRef.current, "--font", "sans-serif"); ctx.textBaseline = "middle";
      let x = M.left;
      for (const s of visible) { ctx.fillStyle = s.color; ctx.fillRect(x, height + 7, 10, 8); ctx.fillText(s.label, x + 14, height + 11); x += ctx.measureText(s.label).width + 32; }
      return c;
    },
  }), [width, height, drawBase, visible]);

  // ---------------------------------------------------------------- interaction
  const local = (e: { clientX: number; clientY: number }) => {
    const r = overRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const clampX = (v: number) => Math.min(extent[1], Math.max(extent[0], v));
  const zoomX = (center: number, f: number) => {
    const c = fx(center), a = fx(xr[0]), b = fx(xr[1]);
    let na = c - (c - a) * f, nb = c + (b - c) * f;
    const ea = fx(extent[0]), eb = fx(extent[1]);
    if (nb - na >= (eb - ea) * (1 - 1e-6)) { setView((v) => ({ ...v, x: null })); return; }
    if (na < ea) { nb += ea - na; na = ea; }
    if (nb > eb) { na -= nb - eb; nb = eb; }
    setView((v) => ({ ...v, x: [ifx(na), ifx(nb)] }));
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = local(e);
    const f = e.deltaY < 0 ? 1 / 1.2 : 1.2;
    if (e.shiftKey) {
      const pane = paneAt(p.y);
      setView((v) => {
        const y = { ...v.y };
        for (const side of ["left", "right"] as const) {
          const key = `${pane}:${side}`; if (!yRanges[key]) continue;
          const c = pxToY(key, p.y), [lo, hi] = yRanges[key];
          y[key] = [c - (c - lo) * f, c + (hi - c) * f];
        }
        return { ...v, y };
      });
    } else zoomX(pxToX(Math.max(M.left, Math.min(M.left + plotW, p.x))), f);
  };
  // React's onWheel is passive; block page scroll natively.
  useEffect(() => {
    const el = overRef.current; if (!el) return;
    const h = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  const onDown = (e: React.PointerEvent) => {
    const p = local(e);
    overRef.current!.setPointerCapture(e.pointerId);
    if (cursorsOn && e.button === 0 && !e.altKey) {
      for (const which of ["a", "b"] as const) {
        const v = cursors[which];
        if (v != null && Math.abs(xToPx(v) - p.x) < 6) { drag.current = { kind: "cursor", which }; return; }
      }
    }
    if (e.button === 1 || e.button === 2 || e.altKey) { drag.current = { kind: "pan", pane: paneAt(p.y), lastX: p.x, lastY: p.y }; return; }
    if (e.button === 0) drag.current = { kind: "box", pane: paneAt(p.y), x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const p = local(e);
    if (d.kind === "cursor") { const v = clampX(pxToX(p.x)); setCursors((c) => ({ ...c, [d.which]: v })); return; }
    if (d.kind === "pan") {
      const dx = p.x - d.lastX, dy = p.y - d.lastY;
      d.lastX = p.x; d.lastY = p.y;
      const shift = -dx / plotW * (fx(xr[1]) - fx(xr[0]));
      const ea = fx(extent[0]), eb = fx(extent[1]);
      let na = fx(xr[0]) + shift, nb = fx(xr[1]) + shift;
      if (na < ea) { nb += ea - na; na = ea; }
      if (nb > eb) { na -= nb - eb; nb = eb; }
      setView((v) => {
        const y = { ...v.y };
        for (const side of ["left", "right"] as const) {
          const key = `${d.pane}:${side}`; if (!yRanges[key]) continue;
          const [lo, hi] = yRanges[key]; const dv = dy / paneH * (hi - lo);
          y[key] = [lo + dv, hi + dv];
        }
        return { x: v.x || dx ? [ifx(na), ifx(nb)] : null, y };
      });
      return;
    }
    d.x1 = p.x; d.y1 = p.y;
    setBox({ ...d });
  };
  const onUp = () => {
    const d = drag.current; drag.current = null; setBox(null);
    if (!d || d.kind !== "box") return;
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 4 && h < 4) {
      // A click.
      const v = clampX(pxToX(d.x0));
      if (cursorsOn) setCursors((c) => (d.shift ? { ...c, b: v } : { ...c, a: v }));
      else onSeek?.(v);
      return;
    }
    setView((v) => {
      const next: View = { x: v.x, y: { ...v.y } };
      if (w >= 4) next.x = [pxToX(Math.min(d.x0, d.x1)), pxToX(Math.max(d.x0, d.x1))];
      if (h >= 8) for (const side of ["left", "right"] as const) {
        const key = `${d.pane}:${side}`; if (!yRanges[key]) continue;
        next.y[key] = [pxToY(key, Math.max(d.y0, d.y1)), pxToY(key, Math.min(d.y0, d.y1))];
      }
      return next;
    });
  };
  const autoscale = () => setView({ x: null, y: {} });

  // ---------------------------------------------------------------- readouts
  const cA = cursorsOn ? cursors.a : null, cB = cursorsOn ? cursors.b : null;
  const window_: Range = cA != null && cB != null ? [Math.min(cA, cB), Math.max(cA, cB)] : xr;
  const meas = useMemo(() => {
    if (!measurements) return new Map<string, Measurements | null>();
    const b = Math.min(window_[1], lim);
    return new Map(visible.map((s) => [s.id, b > window_[0] ? measure(s.x, s.y, window_[0], b) : null]));
  }, [measurements, visible, window_[0], window_[1], lim]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtY = (v: number, unit: string) => (unit === "dB" ? `${v.toFixed(2)} dB` : unit === "°" ? `${v.toFixed(1)}°` : formatSI(v, unit, 4));
  const zoomed = view.x !== null || Object.keys(view.y).length > 0;

  return (
    <div className="plot" ref={wrapRef}>
      <div className="plot-tools">
        <button className="btn sm" onClick={autoscale} disabled={!zoomed} title="Fit all data (double-click the plot)">Autoscale</button>
        <button className="btn sm" onClick={() => zoomX(ifx((fx(xr[0]) + fx(xr[1])) / 2), 1 / 1.5)} title="Zoom in on the x axis (mouse wheel)">Zoom +</button>
        <button className="btn sm" onClick={() => zoomX(ifx((fx(xr[0]) + fx(xr[1])) / 2), 1.5)} disabled={!view.x} title="Zoom out on the x axis">Zoom −</button>
        <label className="chk" title="Click the plot to place cursor A, Shift+click for cursor B; drag a cursor to move it">
          <input type="checkbox" checked={cursorsOn} onChange={(e) => {
            setCursorsOn(e.target.checked);
            if (e.target.checked && cursors.a == null) setCursors({ a: ifx(fx(xr[0]) + (fx(xr[1]) - fx(xr[0])) * 0.3), b: ifx(fx(xr[0]) + (fx(xr[1]) - fx(xr[0])) * 0.7) });
          }} /> Cursors
        </label>
        <span className="hint">Wheel: zoom · drag: box zoom · right-drag: pan · Shift+wheel: y zoom · double-click: fit</span>
      </div>
      <div className="plot-canvas" style={{ height }}>
        <canvas ref={baseRef} style={{ width, height }} />
        <canvas ref={overRef} style={{ width, height }} className="plot-over" aria-label={`Plot of ${visible.map((s) => s.label).join(", ")}`} role="img"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}
          onDoubleClick={autoscale} onContextMenu={(e) => e.preventDefault()} />
      </div>
      <table className="plot-table">
        <thead>
          <tr>
            <th>Trace</th>
            {cA != null && <th>A @ {fmtX(cA, xUnit)}</th>}
            {cB != null && <th>B @ {fmtX(cB, xUnit)}</th>}
            {cA != null && cB != null && <th>Δ (B−A)</th>}
            {measurements && <><th>Min</th><th>Max</th><th>Avg</th><th>RMS</th><th>Pk-pk</th><th>Freq</th></>}
          </tr>
        </thead>
        <tbody>
          {series.map((s) => {
            const on = !hidden.has(s.id);
            const va = cA != null && cA <= lim ? interpolate(s.x, s.y, cA) : null, vb = cB != null && cB <= lim ? interpolate(s.x, s.y, cB) : null;
            const m = meas.get(s.id);
            return (
              <tr key={s.id} className={on ? "" : "off"}>
                <td>
                  <label className="chk"><input type="checkbox" checked={on} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                    <span className="swatch" style={{ background: s.color }} />{s.label}</label>
                </td>
                {cA != null && <td>{va != null ? fmtY(va, s.unit) : "—"}</td>}
                {cB != null && <td>{vb != null ? fmtY(vb, s.unit) : "—"}</td>}
                {cA != null && cB != null && <td>{va != null && vb != null ? fmtY(vb - va, s.unit) : "—"}</td>}
                {measurements && (on && m ? <>
                  <td>{fmtY(m.min, s.unit)}</td><td>{fmtY(m.max, s.unit)}</td><td>{fmtY(m.avg, s.unit)}</td>
                  <td>{fmtY(m.rms, s.unit)}</td><td>{fmtY(m.pkpk, s.unit)}</td>
                  <td title={m.freq == null ? "Needs at least two full, regular periods in the measured window" : undefined}>{m.freq == null ? "—" : formatSI(Number(m.freq.toPrecision(4)), "Hz", 4)}</td>
                </> : <td colSpan={6} className="dim">{on ? "too few samples in window" : "hidden"}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="plot-foot">
        {cA != null && cB != null && <span>Δ{xUnit === "s" ? "t" : "f"} = {fmtX(Math.abs(cB - cA), xUnit)}{xUnit === "s" && cB !== cA ? ` · 1/Δt = ${formatSI(Number((1 / Math.abs(cB - cA)).toPrecision(4)), "Hz", 4)}` : ""}</span>}
        {measurements && <span className="dim">Measured over {cA != null && cB != null ? "cursors A–B" : "the visible range"} ({fmtX(window_[0], xUnit)} … {fmtX(Math.min(window_[1], lim), xUnit)}){Number.isFinite(lim) ? ", up to what has been played" : ""}; averages are time-weighted.</span>}
      </div>
    </div>
  );
}

const fmtX = (v: number, unit: string) => formatSI(v, unit, 4);
