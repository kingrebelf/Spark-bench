// KiCad panel: install status, mapping review with symbol/footprint pickers, export / update a KiCad
// project (schematic + optional PCB) with KiCad's own checks, and schematic import.
import { useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../core/store";
import type { Diagnostic } from "../core/types";
import { exportToKicad, importFromKicad, kicadApi, runMappingReview, safeName, type FootprintHit, type SymbolHit, type Violation, type WriteResult } from "./client";
import type { MappingRow } from "./mapping";
import { useKicad } from "./store";
import { describeGroup } from "./verify";
import "./kicad.css";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function KicadPanel() {
  const k = useKicad();
  const { project } = useProject();
  const available = kicadApi.available();

  useEffect(() => {
    if (!available || k.status) return;
    kicadApi.detect().then((status) => k.set({ status })).catch((e) => k.set({ status: { found: false, message: errMsg(e) } }));
  }, [available]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run the mapping review shortly after the parts change.
  const comps = project.schematic.components;
  useEffect(() => {
    if (!available || !k.status?.found) return;
    const t = setTimeout(() => {
      runMappingReview(useProject.getState().project).then((rows) => k.set({ rows, reviewedAt: Date.now() })).catch((e) => k.set({ error: errMsg(e) }));
    }, 300);
    return () => clearTimeout(t);
  }, [comps, k.status?.found]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!k.name) k.set({ name: safeName(project.meta.name) }); }, [project.meta.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!available) {
    return <aside className="panel props kicad"><h2>KiCad</h2>
      <p className="hint">KiCad export, import and PCB generation run in the SparkBench desktop app, which can start KiCad's own tools. This browser preview cannot.</p></aside>;
  }
  return (
    <aside className="panel props kicad">
      <h2>KiCad</h2>
      <Status />
      {k.status?.found && <>
        <MappingReview />
        <ExportSection />
        <ImportSection />
      </>}
      {k.error && <p className="error" role="alert">{k.error} <button className="btn" onClick={() => k.set({ error: null })}>Dismiss</button></p>}
    </aside>
  );
}

function Status() {
  const { status, set } = useKicad();
  if (!status) return <p className="hint">Looking for KiCad…</p>;
  return (
    <div className={`kc-status ${status.found ? "ok" : "missing"}`}>
      <span>{status.message}</span>
      {!status.found && <button className="btn" onClick={async () => set({ status: await kicadApi.detect(true) })}>Look again</button>}
    </div>
  );
}

// ------------------------------------------------------------------ mapping review

function MappingReview() {
  const { rows } = useKicad();
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  if (!rows) return <section><h3>Part mapping</h3><p className="hint">Checking symbols and footprints…</p></section>;
  const problems = rows.filter((r) => r.status === "error" || r.status === "warning");
  const shown = onlyProblems ? problems : rows;
  return (
    <section>
      <h3>Part mapping</h3>
      <p className="hint">
        {rows.length === 0 ? "No parts yet." : problems.length === 0
          ? `All ${rows.length} part(s) have an installed KiCad symbol${rows.some((r) => !r.boardless) ? " and footprint" : ""}.`
          : `${problems.length} of ${rows.length} part(s) need attention before the KiCad project is complete.`}
      </p>
      {rows.length > 0 && <label className="kc-check"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Show only parts with problems</label>}
      <ul className="kc-rows">
        {shown.map((r) => (
          <li key={r.componentId} className={`kc-row kc-${r.status}`}>
            <button className="kc-row-head" onClick={() => setOpen(open === r.componentId ? null : r.componentId)} aria-expanded={open === r.componentId}>
              <b>{r.ref}</b> <span className="kc-dim">{r.partName}</span>
              <span className="kc-map">{r.mapping.symbol || "no symbol"}{r.boardless ? "" : ` · ${r.mapping.footprint || "no footprint"}`}</span>
            </button>
            {r.diagnostics.map((d, i) => <DiagLine key={i} d={d} />)}
            {open === r.componentId && <MappingEditor row={r} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DiagLine({ d }: { d: Diagnostic }) {
  return <div className={`diag diag-${d.severity}`}>{d.message}{d.fix && <div className="fix">{d.fix}</div>}</div>;
}

function MappingEditor({ row }: { row: MappingRow }) {
  const update = useProject((s) => s.update);
  const setField = (key: "symbol" | "footprint", value: string | undefined) =>
    update(`KiCad ${key} for ${row.ref}`, (d) => {
      const c = d.schematic.components.find((x) => x.id === row.componentId);
      if (!c) return;
      const kc = { ...(c.kicad ?? {}) };
      if (value === undefined) delete kc[key]; else kc[key] = value;
      if (Object.keys(kc).length) c.kicad = kc; else delete c.kicad;
    });
  return (
    <div className="kc-editor">
      <Picker label="KiCad symbol" current={row.mapping.symbol} placeholder="Search symbols, e.g. LM358 or Device:R"
        search={(q) => kicadApi.searchSymbols(q).then((h: SymbolHit[]) => h.map((x) => ({ id: x.libId, hint: x.description })))}
        onPick={(id) => setField("symbol", id)} />
      {!row.boardless || !row.mapping.footprint ? (
        <Picker label="Footprint" current={row.mapping.footprint} placeholder="Search footprints, e.g. R_0805 or DIP-8"
          search={(q) => kicadApi.searchFootprints(q).then((h: FootprintHit[]) => h.map((x) => ({ id: x.fpId, hint: "" })))}
          onPick={(id) => setField("footprint", id)} />
      ) : null}
      {row.mapping.symbolSource === "instance" || useProject.getState().project.schematic.components.find((c) => c.id === row.componentId)?.kicad?.footprint !== undefined ? (
        <button className="btn" onClick={() => { setField("symbol", undefined); setField("footprint", undefined); }}>Use the part's default mapping</button>
      ) : null}
      <p className="hint">Pin numbers come from the part's pin map; the review above re-checks them against the chosen symbol and footprint.</p>
    </div>
  );
}

function Picker({ label, current, placeholder, search, onPick }: {
  label: string; current: string; placeholder: string; search: (q: string) => Promise<{ id: string; hint: string }[]>; onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; hint: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try { const h = await search(q); if (n === seq.current) setHits(h); } finally { if (n === seq.current) setBusy(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="field">
      <span>{label}: <code>{current || "none"}</code></span>
      <input value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${label}`} />
      {busy && <small>Searching installed libraries… (the first search indexes them)</small>}
      {hits && hits.length === 0 && !busy && <small>No matches in the installed KiCad libraries.</small>}
      {hits && hits.length > 0 && (
        <ul className="kc-hits">{hits.map((h) => (
          <li key={h.id}><button className="kc-hit" onClick={() => { onPick(h.id); setQ(""); setHits(null); }} title={h.hint}>
            {h.id}{h.hint && <span className="kc-dim"> {h.hint}</span>}
          </button></li>
        ))}</ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ export / update

function ExportSection() {
  const k = useKicad();
  const project = useProject((s) => s.project);
  const update = useProject((s) => s.update);
  const [existing, setExisting] = useState<{ exists: boolean; hasPcb: boolean; generator?: string } | null>(null);
  const dir = k.folder || project.kicad.projectPath || "";

  useEffect(() => {
    if (!dir || !k.name) { setExisting(null); return; }
    kicadApi.inspect(dir, k.name).then(setExisting).catch(() => setExisting(null));
  }, [dir, k.name, k.lastExport]);

  const choose = async () => {
    const r = await kicadApi.chooseFolder(dir || undefined);
    if (r) k.set({ folder: r.dir, ...(r.existingName ? { name: r.existingName } : {}) });
  };
  const run = async () => {
    k.set({ busy: existing?.exists ? "Updating the KiCad project…" : "Writing the KiCad project…", error: null });
    try {
      const run = await exportToKicad(project, dir, k.name, { pcb: k.pcb, update: !!existing?.exists });
      k.set({ lastExport: run });
      update("Record KiCad export", (d) => { d.kicad.projectPath = dir; d.kicad.lastExport = new Date().toISOString(); });
    } catch (e) { k.set({ error: errMsg(e) }); }
    finally { k.set({ busy: null }); }
  };
  const updating = !!existing?.exists;
  return (
    <section>
      <h3>Export to KiCad</h3>
      <label className="field"><span>Project name</span>
        <input value={k.name} onChange={(e) => k.set({ name: safeName(e.target.value) })} />
      </label>
      <div className="field"><span>Folder</span>
        <div className="kc-inline"><code className="kc-path">{dir || "not chosen"}</code><button className="btn" onClick={choose}>Choose…</button></div>
      </div>
      <label className="kc-check"><input type="checkbox" checked={k.pcb} onChange={(e) => k.set({ pcb: e.target.checked })} disabled={!k.status?.hasPython} />
        {" "}Also {updating && existing?.hasPcb ? "update" : "create"} the PCB (footprints placed as a starting point; not routed)</label>
      {updating && (
        <p className="warn">This folder already has <b>{k.name}.kicad_sch</b>{existing?.generator === "eeschema" ? " (last saved by KiCad)" : ""}. Updating regenerates the schematic from SparkBench:
          edits made to the schematic in KiCad are replaced (a .bak copy is kept), and the change list is shown below.
          {existing?.hasPcb ? " On the PCB, footprints that still exist keep their position, rotation and side; tracks and zones are left as they are; removed parts are deleted and new parts are placed beside the board." : ""}</p>
      )}
      <button className="btn primary" disabled={!dir || !k.name || !!k.busy} onClick={run}>{updating ? "Update KiCad project" : "Export KiCad project"}</button>
      {k.busy && <p className="hint" role="status">{k.busy} KiCad's own checks (ERC, netlist{k.pcb ? ", DRC" : ""}) run afterwards.</p>}
      {k.lastExport && <ExportResult r={k.lastExport.result} name={k.name} notes={k.lastExport.ex.notes} diags={k.lastExport.ex.diagnostics} />}
    </section>
  );
}

function ViolationList({ items, max = 15 }: { items: Violation[]; max?: number }) {
  const groups = useMemo(() => {
    const m = new Map<string, Violation[]>();
    for (const v of items) m.set(v.description, [...(m.get(v.description) ?? []), v]);
    return [...m.entries()];
  }, [items]);
  return (
    <ul className="kc-viol">
      {groups.slice(0, max).map(([desc, vs]) => (
        <li key={desc} className={`diag diag-${vs[0].severity === "error" ? "error" : vs[0].severity === "warning" ? "warning" : "info"}`}>
          {desc}{vs.length > 1 ? ` (×${vs.length})` : ""}
          <div className="fix">{[...new Set(vs.flatMap((v) => v.items.map((i) => i.description)))].slice(0, 6).join("; ")}</div>
        </li>
      ))}
      {groups.length > max && <li className="hint">…and {groups.length - max} more kinds of finding. Run ERC/DRC in KiCad to see them all.</li>}
    </ul>
  );
}

function ExportResult({ r, name, notes, diags }: { r: WriteResult; name: string; notes: string[]; diags: Diagnostic[] }) {
  const conn = r.connectivity;
  const pro = r.files.find((f) => f.endsWith(".kicad_pro"));
  return (
    <div className="kc-result">
      <h4>Result</h4>
      {"error" in conn
        ? <p className="error">Connectivity was not verified: {conn.error}</p>
        : <div className={`diag ${conn.equal ? "diag-info" : "diag-error"}`}>{conn.summary}
            {!conn.equal && <div className="fix">
              {conn.onlyInSparkbench.slice(0, 6).map((g, i) => <div key={i}>SparkBench net: {describeGroup(g)}</div>)}
              {conn.onlyInKicad.slice(0, 6).map((g, i) => <div key={`k${i}`}>KiCad net: {describeGroup(g)}</div>)}
              Fix the mapping problems above (pin maps, symbols) and export again.
            </div>}
          </div>}
      {diags.map((d, i) => <DiagLine key={i} d={d} />)}

      {r.changes && (
        <details open><summary>Changes since the previous schematic</summary>
          {!r.changes.added.length && !r.changes.removed.length && !r.changes.changed.length && !r.changes.rewired.length
            ? <p className="hint">No component or connection changes.</p>
            : <ul className="kc-list">
                {r.changes.added.map((x) => <li key={`a${x}`}>Added {x}</li>)}
                {r.changes.removed.map((x) => <li key={`r${x}`}>Removed {x}</li>)}
                {r.changes.changed.map((x) => <li key={`c${x}`}>{x}</li>)}
                {r.changes.rewired.slice(0, 30).map((x) => <li key={`w${x}`}>{x}</li>)}
              </ul>}
        </details>
      )}

      <details><summary>KiCad ERC: {r.erc.ok ? `${r.erc.errors} error(s), ${r.erc.warnings} warning(s)` : "did not run"}</summary>
        {r.erc.ok ? (r.erc.violations.length ? <ViolationList items={r.erc.violations} /> : <p className="hint">No ERC findings.</p>)
          : <p className="error">{r.erc.cliError}</p>}
      </details>

      {r.pcb && ("error" in r.pcb ? <p className="error">PCB not generated: {r.pcb.error}</p> : (
        <div className="kc-pcb">
          <p className="warn"><b>PCB:</b> footprint placement is only a starting point. Nothing is routed, and SparkBench does not claim the board passes DRC or is ready to manufacture.</p>
          <p>{r.pcb.mode === "update"
            ? `Updated ${name}.kicad_pcb: ${r.pcb.placed.filter((p) => p.kept).length} footprint(s) kept their placement, ${r.pcb.placed.filter((p) => !p.kept).length} new, ${r.pcb.removed.length} removed${r.pcb.replaced.length ? `, ${r.pcb.replaced.length} footprint(s) swapped in place` : ""}; ${r.pcb.keptTracks} existing track/via item(s) left untouched.`
            : `Created ${name}.kicad_pcb with ${r.pcb.placed.length} footprint(s) and ${r.pcb.nets} net(s)${r.pcb.outline ? ` inside a ${r.pcb.outline.w.toFixed(1)} × ${r.pcb.outline.h.toFixed(1)} mm Edge.Cuts outline` : ""}. The ratsnest shows every connection to route.`}</p>
          {r.pcb.skipped.length > 0 && <div className="diag diag-warning">Not on the board: {r.pcb.skipped.map((s) => `${s.ref} (${s.reason})`).join(", ")}.
            <div className="fix">Assign footprints in the mapping review above, then update.</div></div>}
          {r.drc && (r.drc.ok ? (
            <details><summary>KiCad DRC: {r.drc.unconnected.length} unrouted connection(s), {r.drc.violations.length} other finding(s), {r.drc.footprintIssues.length} schematic-parity issue(s)</summary>
              <p className="hint">Unrouted connections are expected until you route the board in KiCad.</p>
              {r.drc.violations.length > 0 && <ViolationList items={r.drc.violations} />}
              {r.drc.footprintIssues.length > 0 && <ViolationList items={r.drc.footprintIssues} />}
            </details>
          ) : <p className="error">DRC did not run: {r.drc.cliError}</p>)}
        </div>
      ))}

      {notes.length + r.notes.length > 0 && (
        <details><summary>What was and wasn't transferred</summary><ul className="kc-list">{[...notes, ...r.notes].map((n, i) => <li key={i}>{n}</li>)}</ul></details>
      )}
      {r.backups.length > 0 && <p className="hint">Backups: {r.backups.map((b) => b.split(/[\\/]/).pop()).join(", ")}</p>}
      <div className="kc-inline">
        {pro && <button className="btn" onClick={() => kicadApi.openInKicad(pro).catch((e) => useKicad.getState().set({ error: errMsg(e) }))}>Open in KiCad</button>}
        <button className="btn" onClick={() => kicadApi.showFolder(r.dir)}>Show folder</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ import

function ImportSection() {
  const k = useKicad();
  const run = async () => {
    const st = useProject.getState();
    if (st.dirty && !window.confirm("Importing replaces the current project. Unsaved changes will be lost. Continue?")) return;
    k.set({ busy: "Importing…", error: null });
    try {
      const r = await importFromKicad();
      if (r) {
        useProject.getState().load(r.project, null);
        k.set({ lastImport: { ...r.report, path: r.path } });
      }
    } catch (e) { k.set({ error: `Import failed: ${errMsg(e)}` }); }
    finally { k.set({ busy: null }); }
  };
  const r = k.lastImport;
  return (
    <section>
      <h3>Import from KiCad</h3>
      <p className="hint">Opens a .kicad_sch as a new SparkBench project. Parts are matched to SparkBench parts by their KiCad symbol; anything without a match is listed, not guessed. Hierarchical sheets and buses are not supported.</p>
      <button className="btn" onClick={run} disabled={!!k.busy}>Import KiCad schematic…</button>
      {r && (
        <div className="kc-result">
          <h4>Import report: {r.path.split(/[\\/]/).pop()}</h4>
          <p>Imported {r.imported.length} part(s), {r.power.length} power symbol(s), {r.counts.wires} wire(s), {r.counts.labels} label(s){r.simulation ? `, simulation command ${r.simulation}` : ""}.</p>
          {r.notImported.length > 0 && <div className="diag diag-error">Not imported ({r.notImported.length}):
            <ul className="kc-list">{r.notImported.map((n, i) => <li key={i}><b>{n.ref}</b> {n.libId}: {n.reason}</li>)}</ul>
            <div className="fix">Their connections are missing in SparkBench. Add equivalent SparkBench parts by hand if you need to simulate them.</div></div>}
          {r.warnings.map((w, i) => <div key={i} className="diag diag-warning">{w}</div>)}
          {r.unsupported.map((w, i) => <div key={i} className="diag diag-info">{w}</div>)}
          <details><summary>Imported parts</summary><ul className="kc-list">{r.imported.map((p) => (
            <li key={p.ref}><b>{p.ref}</b> → {p.part} ({p.how === "lib_id" ? p.libId : `${p.libId}, matched by symbol name and pins`}){p.notes.length ? `: ${p.notes.join("; ")}` : ""}</li>
          ))}</ul></details>
        </div>
      )}
    </section>
  );
}
