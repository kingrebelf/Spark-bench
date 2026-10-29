// Properties of the selection: part values with SI validation, reference, rotation/mirror,
// provenance and model limits; net label and wire details; multi-selection summary.
import { memo, useDeferredValue, useMemo, useRef } from "react";
import { getPart } from "../core/library";
import { useProject } from "../core/store";
import type { ComponentDef, ComponentInstance, PropDef, Rotation } from "../core/types";
import { formatSI, parseSI } from "../core/units";
import * as A from "./actions";
import { PROV_TEXT } from "./LibraryPanel";

const ANALYSIS_NAMES: Record<string, string> = { op: "DC operating point", tran: "transient", ac: "AC sweep" };

/**
 * Undo-friendly edits for a text field: the first change after focusing opens a new undo step,
 * later keystrokes fold into it. So "4.7k" typed in one go is one step, and a later edit is another.
 */
function useEditSession() {
  const fresh = useRef(true);
  return {
    onFocus: () => { fresh.current = true; },
    commit: (label: string, recipe: Parameters<ReturnType<typeof useProject.getState>["update"]>[1]) => {
      useProject.getState().update(label, recipe, { merge: !fresh.current });
      fresh.current = false;
    },
  };
}

/** Validate a numeric prop value. Returns the parsed number, an error or a warning. */
export function checkNumber(raw: string, p: PropDef): { value?: number; error?: string; warning?: string } {
  if (raw.trim() === "") return p.default === "" ? {} : { error: "Required. Enter a number such as 4.7k, 100n or 1MEG." };
  const v = parseSI(raw);
  if (Number.isNaN(v)) return { error: "Not a number. Use e.g. 4.7k, 100n, 2.2u, 1MEG (M = mega, m = milli)." };
  if (p.min !== undefined && v < p.min) return { value: v, error: `Must be at least ${formatSI(p.min, p.unit ?? "")}.` };
  if (p.min === 0 && v === 0 && /Ω|F|H/.test(p.unit ?? "")) return { value: v, warning: "Zero may make the circuit unsolvable." };
  if (/^\s*[-+]?[\d.]+\s*m\s*(Ω|ohm)?\s*$/i.test(raw) && p.unit === "Ω") return { value: v, warning: "“m” means milli (×0.001). For mega use “M” or “MEG”." };
  return { value: v };
}

export const PropertiesPanel = memo(function PropertiesPanel() {
  const project = useProject((s) => s.project);
  const selection = useProject((s) => s.selection);
  const s = project.schematic;
  const live = selection.filter((id) => s.components.some((c) => c.id === id) || s.wires.some((w) => w.id === id) || s.labels.some((l) => l.id === id));

  if (live.length === 0) return <EmptyProps />;
  if (live.length > 1) return <MultiProps ids={live} />;
  const id = live[0];
  const comp = s.components.find((c) => c.id === id);
  if (comp) return <ComponentProps key={comp.id} comp={comp} />;
  const label = s.labels.find((l) => l.id === id);
  if (label) return <LabelProps key={label.id} id={label.id} />;
  return <WireProps id={id} />;
});

function EmptyProps() {
  const s = useProject((st) => st.project.schematic);
  return (
    <aside className="panel props" aria-label="Properties">
      <h2>Properties</h2>
      <p className="hint">Select a part, wire or label to see and edit it here.</p>
      <dl className="facts"><dt>Parts</dt><dd>{s.components.length}</dd><dt>Wires</dt><dd>{s.wires.length}</dd><dt>Net labels</dt><dd>{s.labels.length}</dd></dl>
      <p className="hint">Start by clicking a part in the library (or dragging it onto the canvas), then drag from a pin to wire it. Press <b>?</b> on the canvas for all shortcuts.</p>
    </aside>
  );
}

function Actions() {
  return (
    <div className="actions">
      <button className="btn" onClick={() => A.rotateSelection()} title="Rotate 90° clockwise (R)">⟳ Rotate</button>
      <button className="btn" onClick={() => A.mirrorSelection()} title="Mirror left-right (X)">⇋ Mirror</button>
      <button className="btn" onClick={() => A.duplicateSelection()} title="Duplicate (Ctrl+D)">Duplicate</button>
      <button className="btn" onClick={() => A.deleteSelection()} title="Delete (Del)">Delete</button>
    </div>
  );
}

function ComponentProps({ comp }: { comp: ComponentInstance }) {
  const def = getPart(comp.type);
  const comps = useProject((s) => s.project.schematic.components);
  const refSession = useEditSession();
  if (!def) {
    return (
      <aside className="panel props" aria-label="Properties">
        <h2>{comp.ref}</h2>
        <p className="error">Unknown part type “{comp.type}”. This installation has no definition for it, so it cannot be simulated.</p>
        <p className="hint">Replace it with a library part, or open the project in a SparkBench version that has this part.</p>
        <Actions />
      </aside>
    );
  }
  const dupRef = comps.some((c) => c.id !== comp.id && c.ref === comp.ref);
  const setComp = (fn: (c: ComponentInstance) => void) => (d: Parameters<Parameters<ReturnType<typeof useProject.getState>["update"]>[1]>[0]) => { fn(d.schematic.components.find((c) => c.id === comp.id)!); };
  const valueProps = def.props.filter((p) => !p.model), modelProps = def.props.filter((p) => p.model);
  const unsupported = Object.entries(def.analyses ?? {}).filter(([, ok]) => ok === false).map(([a]) => ANALYSIS_NAMES[a] ?? a);

  return (
    <aside className="panel props" aria-label="Properties">
      <h2>{comp.ref} <small>{def.name}</small></h2>
      <p className={`prov-note prov-${def.provenance}`}>
        <span className="prov-badge">{def.provenance === "none" ? "schematic only" : def.provenance}</span>
        {PROV_TEXT[def.provenance]}{def.accuracyNote ? ` ${def.accuracyNote}` : ""}
      </p>
      {unsupported.length > 0 && <p className="unsupported">⚠ Not available in {unsupported.join(" or ")} analysis.</p>}
      {def.role !== "ground" && (
        <label className={`field ${dupRef || !comp.ref.trim() ? "invalid" : ""}`}>
          <span>Reference</span>
          <input value={comp.ref} spellCheck={false} onFocus={refSession.onFocus}
            onChange={(e) => refSession.commit(`Rename ${comp.ref} → ${e.target.value}`, setComp((c) => { c.ref = e.target.value; }))} />
          {dupRef && <em>Another part is also called {comp.ref}. References must be unique for simulation and KiCad export.</em>}
          {!comp.ref.trim() && <em>A reference is required.</em>}
        </label>
      )}
      {valueProps.map((p) => <PropField key={p.key} comp={comp} p={p} />)}
      <div className="row2">
        <label className="field"><span>Rotation</span>
          <select value={comp.rotation} onChange={(e) => useProject.getState().update(`Rotate ${comp.ref}`, setComp((c) => { c.rotation = Number(e.target.value) as Rotation; }))}>
            {[0, 90, 180, 270].map((r) => <option key={r} value={r}>{r}°</option>)}
          </select>
        </label>
        <label className="field"><span>Mirrored</span>
          <select value={comp.mirror ? "yes" : "no"} onChange={() => A.mirrorSelection()}>
            <option value="no">No</option><option value="yes">Yes</option>
          </select>
        </label>
      </div>
      {modelProps.length > 0 && <>
        <div className="section-title">Model</div>
        {modelProps.map((p) => <PropField key={p.key} comp={comp} p={p} />)}
      </>}
      <Actions />
      <PartFacts comp={comp} def={def} />
    </aside>
  );
}

function PropField({ comp, p }: { comp: ComponentInstance; p: PropDef }) {
  const session = useEditSession();
  const v = comp.props[p.key] ?? p.default;
  const label = `Edit ${comp.ref} ${p.label.toLowerCase()}`;
  const set = (val: string | boolean) => session.commit(label, (d) => { d.schematic.components.find((c) => c.id === comp.id)!.props[p.key] = val; });
  const check = p.kind === "number" ? checkNumber(String(v), p) : {};
  const showParsed = check.value !== undefined && !check.error && String(v).trim() !== "" && formatSI(check.value, p.unit ?? "") !== `${String(v).trim()} ${p.unit ?? ""}`.trim();
  return (
    <label className={`field ${check.error ? "invalid" : check.warning ? "warnf" : ""}`}>
      <span>{p.label}{p.unit ? ` (${p.unit})` : ""}</span>
      {p.kind === "bool" ? <input type="checkbox" checked={!!v} onFocus={session.onFocus} onChange={(e) => set(e.target.checked)} />
        : p.kind === "select" ? <select value={String(v)} onFocus={session.onFocus} onChange={(e) => set(e.target.value)}>{(p.options ?? []).map((o) => <option key={o}>{o}</option>)}</select>
        : <input value={String(v)} spellCheck={false} onFocus={session.onFocus} onChange={(e) => set(e.target.value)}
            aria-invalid={!!check.error} inputMode={p.kind === "number" ? "decimal" : undefined}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />}
      {check.error && <em>{check.error}</em>}
      {check.warning && <span className="w">{check.warning}</span>}
      {showParsed && <span className="parsed">= {formatSI(check.value!, p.unit ?? "")}</span>}
      {p.help && <small>{p.help}</small>}
    </label>
  );
}

function PartFacts({ comp, def }: { comp: ComponentInstance; def: ComponentDef }) {
  return (
    <>
      <div className="section-title">Details</div>
      <p className="hint">{def.description}</p>
      <dl className="facts">
        <dt>Position</dt><dd>{comp.position.x}, {comp.position.y}</dd>
        <dt>Pins</dt><dd>{def.pins.map((p) => p.name).join(", ") || "none"}</dd>
        {def.kicad && <><dt>KiCad</dt><dd>{comp.kicad?.symbol ?? def.kicad.symbol}</dd></>}
        {(comp.kicad?.footprint ?? def.kicad?.footprint) && <><dt>Footprint</dt><dd>{comp.kicad?.footprint ?? def.kicad?.footprint}</dd></>}
      </dl>
    </>
  );
}

function useNetOf(pointKey: "wire" | "label", id: string) {
  const project = useDeferredValue(useProject((s) => s.project));
  return useMemo(() => {
    const conn = A.connectivityOf(project);
    if (pointKey === "wire") return conn.nets.find((n) => n.wireIds.includes(id));
    const l = project.schematic.labels.find((x) => x.id === id);
    return l ? conn.nets.find((n) => n.points.some((p) => p.x === l.position.x && p.y === l.position.y)) : undefined;
  }, [project, pointKey, id]);
}

function NetFacts({ net }: { net: ReturnType<typeof useNetOf> }) {
  const comps = useProject((s) => s.project.schematic.components);
  if (!net) return null;
  const pins = net.pins.map((p) => {
    const c = comps.find((x) => x.id === p.componentId);
    const pin = c && getPart(c.type)?.pins.find((x) => x.id === p.pinId);
    return c ? `${c.ref}.${pin?.name ?? p.pinId}` : "?";
  });
  return (
    <dl className="facts">
      <dt>Net</dt><dd>{net.isGround ? "GND (0)" : net.name}</dd>
      <dt>Connects</dt><dd>{pins.length ? pins.join(", ") : "no pins"}</dd>
      {net.labelNames.length > 0 && <><dt>Labels</dt><dd>{[...new Set(net.labelNames)].join(", ")}</dd></>}
    </dl>
  );
}

function LabelProps({ id }: { id: string }) {
  const label = useProject((s) => s.project.schematic.labels.find((l) => l.id === id))!;
  const session = useEditSession();
  const net = useNetOf("label", id);
  const onWire = net && (net.wireIds.length > 0 || net.pins.length > 0);
  return (
    <aside className="panel props" aria-label="Properties">
      <h2>Net label <small>{label.name}</small></h2>
      <label className={`field ${!label.name.trim() ? "invalid" : ""}`}><span>Name</span>
        <input value={label.name} spellCheck={false} onFocus={session.onFocus}
          onChange={(e) => session.commit(`Rename label → ${e.target.value}`, (d) => { d.schematic.labels.find((l) => l.id === id)!.name = e.target.value; })} />
        {!label.name.trim() && <em>A label needs a name.</em>}
      </label>
      <p className="hint">Labels with the same name are connected, even without a wire. “GND” or “0” means ground.</p>
      {!onWire && <p className="unsupported">⚠ This label is not on a wire or pin, so it connects nothing. Move it onto a wire end or pin.</p>}
      <NetFacts net={net} />
      <div className="actions"><button className="btn" onClick={() => A.deleteSelection()}>Delete</button></div>
    </aside>
  );
}

function WireProps({ id }: { id: string }) {
  const wire = useProject((s) => s.project.schematic.wires.find((w) => w.id === id));
  const net = useNetOf("wire", id);
  if (!wire) return null;
  const len = wire.points.reduce((a, p, i) => (i ? a + Math.abs(p.x - wire.points[i - 1].x) + Math.abs(p.y - wire.points[i - 1].y) : 0), 0);
  return (
    <aside className="panel props" aria-label="Properties">
      <h2>Wire</h2>
      <NetFacts net={net} />
      <dl className="facts">
        <dt>Length</dt><dd>{len} units ({(len * 1.27).toFixed(2)} mm)</dd>
        <dt>Bends</dt><dd>{Math.max(0, wire.points.length - 2)}</dd>
      </dl>
      <p className="hint">Hover a wire to highlight its whole net. To name the net, press L and click the wire.</p>
      <div className="actions"><button className="btn" onClick={() => A.deleteSelection()}>Delete</button></div>
    </aside>
  );
}

function MultiProps({ ids }: { ids: string[] }) {
  const s = useProject((st) => st.project.schematic);
  const set = new Set(ids);
  const comps = s.components.filter((c) => set.has(c.id));
  const groups = new Map<string, ComponentInstance[]>();
  for (const c of comps) { const n = getPart(c.type)?.name ?? c.type; groups.set(n, [...(groups.get(n) ?? []), c]); }
  const wires = s.wires.filter((w) => set.has(w.id)).length;
  const labels = s.labels.filter((l) => set.has(l.id)).length;
  return (
    <aside className="panel props" aria-label="Properties">
      <h2>{ids.length} items selected</h2>
      <ul className="summary">
        {[...groups].map(([name, cs]) => (
          <li key={name}><span>{name} ×{cs.length}</span>
            <span>{cs.slice(0, 6).map((c, i) => <span key={c.id}>{i ? ", " : ""}<button onClick={() => A.select([c.id])} title={`Select only ${c.ref}`}>{c.ref}</button></span>)}{cs.length > 6 ? " …" : ""}</span>
          </li>
        ))}
        {wires > 0 && <li><span>Wires</span><span>{wires}</span></li>}
        {labels > 0 && <li><span>Net labels</span><span>{labels}</span></li>}
      </ul>
      <Actions />
      <p className="hint">Shift+click toggles items. Drag or use arrow keys to move them together; connected wires follow.</p>
    </aside>
  );
}
