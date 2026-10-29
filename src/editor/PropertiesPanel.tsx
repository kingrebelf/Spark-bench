import { getPart } from "../core/library";
import { useProject } from "../core/store";
import { parseSI } from "../core/units";

const PROV_TEXT: Record<string, string> = {
  ideal: "Ideal element: exact within SPICE's ideal model.",
  generic: "Generic model with typical parameters, not a specific manufacturer part.",
  behavioral: "Behavioral macromodel: reproduces the function, not device physics.",
  vendor: "Manufacturer-supplied model.",
  none: "Schematic only: not simulated.",
};

export function PropertiesPanel() {
  const { project, selection, update } = useProject();
  const comp = selection.length === 1 ? project.schematic.components.find((c) => c.id === selection[0]) : undefined;
  const label = selection.length === 1 ? project.schematic.labels.find((l) => l.id === selection[0]) : undefined;

  if (label) {
    return (
      <aside className="panel props">
        <h2>Net label</h2>
        <label className="field"><span>Name</span>
          <input value={label.name} onChange={(e) => update("Rename label", (d) => { d.schematic.labels.find((l) => l.id === label.id)!.name = e.target.value; }, { merge: true })} />
        </label>
        <p className="hint">Labels with the same name are connected. "GND" or "0" means ground.</p>
      </aside>
    );
  }
  if (!comp) {
    return <aside className="panel props"><h2>Properties</h2><p className="hint">{selection.length > 1 ? `${selection.length} items selected.` : "Select a part to edit its values."}</p></aside>;
  }
  const def = getPart(comp.type);
  if (!def) return <aside className="panel props"><h2>{comp.ref}</h2><p className="error">Unknown part type "{comp.type}".</p></aside>;
  const set = (key: string, v: string | boolean) => update(`Edit ${comp.ref}`, (d) => { d.schematic.components.find((c) => c.id === comp.id)!.props[key] = v; }, { merge: true });

  return (
    <aside className="panel props">
      <h2>{comp.ref} <small>{def.name}</small></h2>
      <p className="hint">{def.description}</p>
      <p className={`prov-note prov-${def.provenance}`}><b>{def.provenance}</b> · {PROV_TEXT[def.provenance]}{def.accuracyNote ? ` ${def.accuracyNote}` : ""}</p>
      {def.role !== "ground" && (
        <label className="field"><span>Reference</span>
          <input value={comp.ref} onChange={(e) => update("Edit reference", (d) => { d.schematic.components.find((c) => c.id === comp.id)!.ref = e.target.value; }, { merge: true })} />
        </label>
      )}
      {def.props.map((p) => {
        const v = comp.props[p.key] ?? p.default;
        const invalid = p.kind === "number" && String(v).trim() !== "" && Number.isNaN(parseSI(String(v)));
        return (
          <label key={p.key} className={`field ${invalid ? "invalid" : ""}`}>
            <span>{p.label}{p.unit ? ` (${p.unit})` : ""}</span>
            {p.kind === "bool" ? <input type="checkbox" checked={!!v} onChange={(e) => set(p.key, e.target.checked)} />
              : p.kind === "select" ? <select value={String(v)} onChange={(e) => set(p.key, e.target.value)}>{p.options!.map((o) => <option key={o}>{o}</option>)}</select>
              : <input value={String(v)} onChange={(e) => set(p.key, e.target.value)} aria-invalid={invalid} />}
            {invalid && <em>Not a number. Use e.g. 4.7k, 100n, 1MEG.</em>}
            {p.help && <small>{p.help}</small>}
          </label>
        );
      })}
      {def.analyses && Object.entries(def.analyses).filter(([, ok]) => ok === false).map(([a]) => <p key={a} className="warn">Not available in {a.toUpperCase()} analysis.</p>)}
    </aside>
  );
}
