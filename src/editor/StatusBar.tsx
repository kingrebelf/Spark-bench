// Canvas status bar (cursor, zoom, selection, tool hint, last undo step) and the shortcut help overlay.
import { useEffect, useRef } from "react";
import { getPart } from "../core/library";
import { useProject } from "../core/store";
import { useEditor, usePointer } from "./store";

const MM_PER_UNIT = 1.27;

function toolHint(tool: ReturnType<typeof useEditor.getState>["tool"], wiring: boolean): string {
  if (typeof tool === "object") return `Placing ${getPart(tool.place)?.name ?? tool.place}: click to place · R rotate · X mirror · Esc done`;
  if (tool === "wire") return wiring ? "Click to bend · click a pin or wire to finish · / flip corner · Backspace undo point · Esc cancel" : "Click a pin or grid point to start a wire · Esc done";
  if (tool === "label") return "Click a wire or pin to attach a net label · Esc done";
  return "Drag a pin to wire · drag empty space to box-select · ? shortcuts";
}

export function StatusBar({ onFit, onZoom }: { onFit: () => void; onZoom: (f: number) => void }) {
  const cursor = usePointer((s) => s.cursor);
  const wiring = usePointer((s) => s.wire.length > 0);
  const zoom = useEditor((s) => s.view.zoom);
  const tool = useEditor((s) => s.tool);
  const setHelp = useEditor((s) => s.setHelpOpen);
  const selCount = useProject((s) => s.selection.length);
  const lastStep = useProject((s) => s.past[s.past.length - 1]?.label);
  const counts = useProject((s) => s.project.schematic);
  return (
    <div className="sb-status" role="status">
      <span className="coords" title="Cursor position in grid units (1 unit = 1.27 mm / 50 mil)">
        {cursor ? <>x {cursor.x} y {cursor.y} <small>({(cursor.x * MM_PER_UNIT).toFixed(2)}, {(cursor.y * MM_PER_UNIT).toFixed(2)} mm)</small></> : <small>{counts.components.length} parts · {counts.wires.length} wires</small>}
      </span>
      <span className="sel">{selCount ? `${selCount} selected` : "Nothing selected"}</span>
      <span className="hint">{toolHint(tool, wiring)}</span>
      {lastStep && <span className="last" title="Ctrl+Z undoes this">Last: {lastStep}</span>}
      <span className="zoom">
        <button onClick={() => onZoom(0.8)} title="Zoom out (-)" aria-label="Zoom out">−</button>
        <span aria-label="Zoom level">{Math.round(zoom * 100)}%</span>
        <button onClick={() => onZoom(1.25)} title="Zoom in (+)" aria-label="Zoom in">+</button>
        <button onClick={onFit} title="Zoom to fit (F or Home)">Fit</button>
        <button onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
      </span>
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  ["View", [["Wheel", "Zoom at cursor"], ["Middle-drag / Space+drag", "Pan"], ["Arrow keys (nothing selected)", "Pan"], ["F / Home / Ctrl+0", "Zoom to fit"], ["+ / −", "Zoom in / out"]]],
  ["Select & edit", [["Click / Shift+click", "Select / add or remove"], ["Drag on empty space", "Box select (→ inside, ← touching)"], ["Ctrl+A", "Select all"], ["Drag / Arrow keys", "Move (Shift+arrow: 10 units)"], ["R / Shift+R", "Rotate clockwise / counter-clockwise"], ["X", "Mirror left-right"], ["Delete", "Delete selection"], ["Ctrl+C / X / V / D", "Copy / cut / paste at cursor / duplicate"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Double-click part", "Edit its value"]]],
  ["Wiring & labels", [["W", "Wire tool"], ["Drag from a pin", "Draw a wire from that pin"], ["Click", "Add a bend; clicking a pin or wire finishes"], ["/", "Flip which way the corner goes"], ["Double-click / Enter", "Finish the wire here"], ["Backspace", "Remove the last bend"], ["L", "Net label tool"], ["Double-click label / Enter", "Rename label"]]],
  ["Placing parts", [["Click or drag from library", "Place a part"], ["R / X while placing", "Rotate / mirror the ghost"], ["Esc or right-click", "Stop placing"]]],
];

export function HelpOverlay() {
  const open = useEditor((s) => s.helpOpen);
  const setOpen = useEditor((s) => s.setHelpOpen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="sb-help-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="sb-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1} ref={ref}
        onKeyDown={(e) => { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}>
        <header><h2>Keyboard shortcuts</h2><button className="btn" onClick={() => setOpen(false)}>Close</button></header>
        <div className="cols">
          {SHORTCUTS.map(([group, rows]) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
