// Canvas tuning popover: a part's main values (field + tune slider) right next to the part, so values can
// be tuned without looking away from the scope. Opens on double-click or Enter on a selected part (focused,
// stays until Esc / click outside), and during a live run also when hovering a part (closes when the
// pointer leaves; clicking into it keeps it open).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getPart } from "../core/library";
import { useProject } from "../core/store";
import { useSim } from "../sim/store";
import { componentBounds } from "./ops";
import { useEditor, usePointer, type View } from "./store";
import { tunableProps } from "./tune";
import { TuneField } from "./TuneField";

const HOVER_OPEN_MS = 450;
const HOVER_CLOSE_MS = 350;
const WIDTH = 248;

/** Open the popover for a part when it has values to tune; false when it has none. */
export function openTuner(id: string): boolean {
  const c = useProject.getState().project.schematic.components.find((x) => x.id === id);
  const def = c && getPart(c.type);
  if (!def || !tunableProps(def).length) return false;
  useEditor.getState().setTune({ id, pinned: true, focus: true });
  return true;
}

export function TunePopover({ view, px, width, height, onClose }: { view: View; px: number; width: number; height: number; onClose: () => void }) {
  const tune = useEditor((s) => s.tune);
  const setTune = useEditor((s) => s.setTune);
  const live = useSim((s) => !!s.session?.live);
  const comp = useProject((s) => (tune ? s.project.schematic.components.find((c) => c.id === tune.id) : undefined));
  const boxRef = useRef<HTMLDivElement>(null);
  const over = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [boxH, setBoxH] = useState(0);
  useLayoutEffect(() => { setBoxH(boxRef.current?.offsetHeight ?? 0); });

  // Hover to open during a live run.
  useEffect(() => {
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = usePointer.subscribe((s, prev) => {
      if (s.hover === prev.hover) return;
      const ed = useEditor.getState();
      if (!useSim.getState().session?.live || ed.tool !== "select") return;
      const h = s.hover?.kind === "component" || s.hover?.kind === "pin" ? s.hover.id : null;
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
      const cur = useEditor.getState().tune;
      if (h && cur?.id === h) { if (closeTimer.current) clearTimeout(closeTimer.current); return; }
      if (h && !cur?.pinned) {
        const c = useProject.getState().project.schematic.components.find((x) => x.id === h);
        const def = c && getPart(c.type);
        if (def && tunableProps(def).length) openTimer = setTimeout(() => useEditor.getState().setTune({ id: h, pinned: false }), HOVER_OPEN_MS);
      }
      if (cur && !cur.pinned) scheduleClose();
    });
    return () => { unsub(); if (openTimer) clearTimeout(openTimer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      const cur = useEditor.getState().tune;
      if (!cur || cur.pinned || over.current || boxRef.current?.contains(document.activeElement)) return;
      const h = usePointer.getState().hover;
      if (h && "id" in h && h.id === cur.id) return;
      useEditor.getState().setTune(null);
    }, HOVER_CLOSE_MS);
  };

  // A pinned popover closes on a press outside it (not the press that opened it).
  useEffect(() => {
    if (!tune?.pinned) return;
    const opened = performance.now();
    const onDown = (e: PointerEvent) => {
      if (performance.now() - opened < 250 || boxRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [tune?.id, tune?.pinned]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  // A popover closed under the pointer (Esc) gets no pointerleave: forget it when the part changes or it closes.
  useEffect(() => { over.current = false; }, [tune?.id]);

  const def = comp && getPart(comp.type);
  if (!tune || !comp || !def) return null;
  const props = tunableProps(def);
  if (!props.length) return null;
  const b = componentBounds(comp, def);
  const s = px * view.zoom;
  const right = (b.x + b.w - view.x) * s + 10;
  const left = (b.x - view.x) * s - 10 - WIDTH;
  const x = right + WIDTH <= width || left < 0 ? Math.max(4, Math.min(right, width - WIDTH - 4)) : left;
  // keep it inside the canvas (the canvas can be short when the simulation panel is open)
  const y = Math.max(4, Math.min((b.y - view.y) * s, height - boxH - 36));

  return (
    <div ref={boxRef} className="tune-pop" role="dialog" aria-label={`Tune ${comp.ref}`} style={{ left: x, top: y, width: WIDTH }}
      onPointerEnter={() => { over.current = true; if (closeTimer.current) clearTimeout(closeTimer.current); }}
      onPointerLeave={() => { over.current = false; if (!tune.pinned) scheduleClose(); }}
      onFocus={() => { if (!tune.pinned) setTune({ id: tune.id, pinned: true }); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <header>
        <b>{comp.ref}</b><span>{def.name}</span>
        {live && <span className="live-dot" title="Changes apply to the running simulation">live</span>}
        <button type="button" onClick={onClose} aria-label="Close tuner" title="Close (Esc)">×</button>
      </header>
      {props.map((p, i) => (
        <TuneField key={`${comp.id}:${p.key}`} compId={comp.id} p={p} slider compact autoFocus={!!tune.focus && i === 0} onEscape={onClose} />
      ))}
    </div>
  );
}
