// A numeric part value that is quick to tune: typed values apply as you type (debounced) and at once on
// Enter / blur, ↑/↓ and the mouse wheel step through preferred values, and a tune slider sweeps a range
// around the value. Everything done while the field group has focus is one undo step.
// Used by the Properties panel and by the canvas tuning popover.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useProject } from "../core/store";
import type { PropDef } from "../core/types";
import { formatSI, parseSI } from "../core/units";
import { useSim } from "../sim/store";
import {
  checkNumber, createApplier, createEditSession, defaultRange, sliderMax, sliderToValue, stepValue, toStored, valueToSlider, withEnds, type TuneRange,
} from "./tune";

const fmt = (v: number, unit?: string) => formatSI(v, unit ?? "", 3);

export function TuneField({ compId, p, slider, autoFocus, onEscape, compact }: {
  compId: string; p: PropDef; slider: boolean; autoFocus?: boolean; onEscape?: () => void; compact?: boolean;
}) {
  const raw = useProject((s) => {
    const c = s.project.schematic.components.find((x) => x.id === compId);
    return String(c?.props[p.key] ?? p.default ?? "");
  });
  const ref = useProject((s) => s.project.schematic.components.find((x) => x.id === compId)?.ref ?? "");
  const live = useSim((s) => !!s.session?.live);
  const [draft, setDraft] = useState(raw);
  const [flash, setFlash] = useState(0);
  const editing = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const max = p.unit === "%" ? 100 : undefined;

  // Not editing: show what is stored (undo, slider, canvas popover and other edits show up here).
  useEffect(() => { if (!editing.current) setDraft(raw); }, [raw]);

  const label = `Edit ${ref} ${p.label.toLowerCase()}`;
  const session = useMemo(() => createEditSession(() => useProject.getState().update), []);
  const write = (text: string) => {
    session.commit(label, (d) => { const c = d.schematic.components.find((x) => x.id === compId); if (c) c.props[p.key] = text; });
    setFlash((n) => n + 1);
  };
  const writeRef = useRef(write);
  writeRef.current = write;
  const applier = useMemo(() => createApplier({ isValid: (t) => !checkNumber(t, p).error, apply: (t) => writeRef.current(t) }), [p]);
  // A field removed while focused (selection changed, popover closed) gets no blur: apply what was typed.
  useEffect(() => () => { applier.flush(); }, [applier]);

  const stored = () => String(useProject.getState().project.schematic.components.find((x) => x.id === compId)?.props[p.key] ?? p.default ?? "");
  const current = () => { const v = parseSI(draft); return Number.isNaN(v) ? parseSI(raw) : v; };

  const setValue = (v: number) => {
    const text = toStored(v);
    setDraft(text);
    applier.applied(text);
    if (text !== stored()) write(text);
  };
  const step = (dir: 1 | -1, shift: boolean, ctrl: boolean) => {
    const v = current();
    if (Number.isNaN(v)) return;
    setValue(stepValue(v, dir, p.unit, { shift, ctrl }, p.min, max));
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  // Wheel steps only while the field has focus, so scrolling the panel never changes values. Native and
  // non-passive so it can stop the page from scrolling or zooming (Ctrl+wheel).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      const d = e.deltaY || e.deltaX; // Shift+wheel arrives as deltaX on Windows
      if (!d) return;
      e.preventDefault();
      stepRef.current(d < 0 ? 1 : -1, e.shiftKey, e.ctrlKey || e.metaKey);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => { if (autoFocus) setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0); }, [autoFocus]);

  // ---- tune slider range: frozen while the group has focus, re-centred on the value afterwards
  const [range, setRange] = useState<TuneRange | null>(() => { const v = parseSI(raw); return Number.isFinite(v) ? defaultRange(v, p.unit, p.min) : null; });
  const custom = useRef(false);
  const recentre = () => {
    if (custom.current) return;
    const v = parseSI(stored());
    setRange(Number.isFinite(v) ? defaultRange(v, p.unit, p.min) : null);
  };
  useEffect(() => { if (!editing.current) recentre(); }, [raw]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = checkNumber(draft, p);
  const showParsed = check.value !== undefined && !check.error && draft.trim() !== "" && fmt(check.value, p.unit) !== `${draft.trim()} ${p.unit ?? ""}`.trim();
  const v = current();
  const status = check.error ? <em id={`${id}-err`}>{check.error}</em>
    : flash > 0 ? <span key={flash} className="applied" aria-live="polite">✓ {live ? "applied live" : "applied"}</span> : null;

  return (
    <div ref={wrapRef} className={`field tune ${check.error ? "invalid" : check.warning ? "warnf" : ""} ${compact ? "compact" : ""}`}
      onFocus={(e) => {
        if (wrapRef.current?.contains(e.relatedTarget as Node | null)) return;
        editing.current = true;
        session.begin();
        applier.reset(stored());
      }}
      onBlur={(e) => {
        if (wrapRef.current?.contains(e.relatedTarget as Node | null)) return;
        applier.flush();
        editing.current = false;
        setDraft(stored());
        recentre();
      }}>
      <label htmlFor={id}>{p.label}{p.unit ? ` (${p.unit})` : ""}</label>
      <div className="tune-row">
        <input id={id} ref={inputRef} value={draft} spellCheck={false} inputMode="decimal" aria-invalid={!!check.error}
          aria-describedby={check.error ? `${id}-err` : undefined}
          title="↑/↓ or wheel: next standard value · Shift: fine (E96 / 1 %) · Ctrl: ×10 / ÷10 · Enter applies now"
          onChange={(e) => { setDraft(e.target.value); applier.edit(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); step(e.key === "ArrowUp" ? 1 : -1, e.shiftKey, e.ctrlKey || e.metaKey); }
            else if (e.key === "Enter") { e.preventDefault(); applier.flush(); }
            else if (e.key === "Escape") {
              e.preventDefault(); e.stopPropagation();
              applier.cancel(); setDraft(stored());
              if (onEscape) onEscape(); else inputRef.current?.blur();
            }
          }} />
        {p.unit && <span className="unit" aria-hidden="true">{p.unit}</span>}
      </div>
      {slider && range && <TuneSlider range={range} value={v} unit={p.unit} label={`${p.label} tuner`}
        onChange={setValue}
        onEnds={(lo, hi) => { const r = withEnds(range, lo, hi); if (r) { custom.current = true; setRange(r); } return !!r; }}
        onReset={custom.current ? () => { custom.current = false; recentre(); } : undefined} />}
      <div className="tune-status">
        {status}
        {!check.error && check.warning && <span className="w">{check.warning}</span>}
        {showParsed && <span className="parsed">= {fmt(check.value!, p.unit)}</span>}
      </div>
      {p.help && !compact && <small>{p.help}</small>}
    </div>
  );
}

function TuneSlider({ range, value, unit, label, onChange, onEnds, onReset }: {
  range: TuneRange; value: number; unit?: string; label: string;
  onChange: (v: number) => void; onEnds: (lo: number, hi: number) => boolean; onReset?: () => void;
}) {
  const n = sliderMax(range);
  const pos = Number.isFinite(value) ? valueToSlider(range, value) : 0;
  return (
    <div className="tune-slider">
      <EndField value={range.lo} unit={unit} label="Tuner minimum" onSet={(x) => onEnds(x, range.hi)} />
      <input type="range" min={0} max={n} step={1} value={pos} aria-label={label}
        aria-valuetext={fmt(sliderToValue(range, pos), unit)}
        title={range.kind === "series" ? "Drag to sweep standard values (log scale)" : "Drag to sweep the value"}
        onChange={(e) => onChange(sliderToValue(range, Number(e.target.value)))} />
      <EndField value={range.hi} unit={unit} label="Tuner maximum" onSet={(x) => onEnds(range.lo, x)} />
      {onReset && <button type="button" className="tune-reset" onClick={onReset} title="Centre the tuner on the value again" aria-label="Reset tuner range">↺</button>}
    </div>
  );
}

/** A tuner end: shows the bound, click to type a new one. */
function EndField({ value, unit, label, onSet }: { value: number; unit?: string; label: string; onSet: (v: number) => boolean }) {
  const [text, setText] = useState<string | null>(null);
  if (text == null) {
    return <button type="button" className="tune-end" onClick={() => setText(toStored(value))} title={`${label}: click to change`} aria-label={`${label} ${fmt(value, unit)}, change`}>{fmt(value, unit)}</button>;
  }
  const done = (ok: boolean) => {
    if (ok && !onSet(parseSI(text))) return; // keep editing an impossible bound
    setText(null);
  };
  return (
    <input className="tune-end" autoFocus value={text} aria-label={label} spellCheck={false}
      aria-invalid={!Number.isFinite(parseSI(text))}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } }}
      onBlur={() => setText(null)} />
  );
}
