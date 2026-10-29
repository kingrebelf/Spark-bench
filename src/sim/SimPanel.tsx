// Simulation panel: analysis setup, Run/Stop/Reset, probes, transient playback, scope / Bode /
// operating-point views, grouped diagnostics, netlist + log, and exports.
import { useEffect, useMemo, useRef, useState } from "react";
import { computeConnectivity } from "../core/connectivity";
import { keyOf, pinWorldPosition } from "../core/geometry";
import { getPart } from "../core/library";
import { generateNetlist } from "../core/netlist";
import { newId } from "../core/project";
import { useProject } from "../core/store";
import type { AnalysisKind, Diagnostic, Probe, Project, SimResult } from "../core/types";
import { formatSI } from "../core/units";
import { interpolate } from "../scope/measure";
import { Plot, type PaneSpec, type PlotHandle, type PlotSeries } from "../scope/Plot";
import { resultToCsv, safeFileName, saveText, savePng } from "./exporting";
import { addSaves, planCurrentSaves, PROBE_COLORS } from "./probes";
import { autoRate, defaultRate, displayLimit, hasLiveParts, RATES } from "./live";
import { acSources, sourceFrequencies, suggestAc, suggestTran, validateSetup } from "./setup";
import { HISTORY_SECONDS, usePlayback, useRunProject, useSim, useStaleness, useValidUntil } from "./store";
import { damageText, stressTracks } from "./stress";
import { allTraces, magDb, phaseDeg, probeTraces, type Trace } from "./traces";
import "./sim.css";

const HEIGHT_KEY = "sparkbench.simPanelHeight";
const SIDE_KEY = "sparkbench.simSideHidden";
const readHeight = () => { try { return Number(localStorage.getItem(HEIGHT_KEY)) || 360; } catch { return 360; } };
const readSide = () => { try { return localStorage.getItem(SIDE_KEY) === "1"; } catch { return false; } };

export function SimPanel() {
  const project = useProject((s) => s.project);
  const { status, result, blocked } = useSim();
  const runProject = useRunProject();
  const stale = useStaleness();
  const [height, setHeight] = useState(readHeight);
  const [notice, setNotice] = useState<string | null>(null);
  const plotRef = useRef<PlotHandle>(null);
  const [showAll, setShowAll] = useState(false);
  const [sideHidden, setSideHidden] = useState(readSide);
  useEffect(() => { try { localStorage.setItem(SIDE_KEY, sideHidden ? "1" : "0"); } catch { /* ignore */ } }, [sideHidden]);

  const traces = useMemo(() => {
    if (!result?.ok) return { traces: [] as Trace[], missing: [] as ReturnType<typeof probeTraces>["missing"] };
    const p = probeTraces(project, result, runProject);
    if (showAll || project.simulation.probes.length === 0) return { traces: allTraces(runProject, result), missing: p.missing };
    return p;
  }, [project, runProject, result, showAll]);

  const onResize = (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.style.userSelect = "none";
    const startY = e.clientY, startH = height;
    const move = (ev: PointerEvent) => setHeight(Math.min(window.innerHeight - 120, Math.max(160, startH + startY - ev.clientY)));
    const up = () => { document.body.style.userSelect = ""; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  useEffect(() => { try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* ignore */ } }, [height]);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice((n) => (n === msg ? null : n)), 4000); };
  const exportCsv = async () => {
    if (!result?.ok) return;
    const name = `${safeFileName(project.meta.name)}-${result.analysis}.csv`;
    const r = await saveText(resultToCsv(result, traces.traces.map((t) => ({ label: t.label, vector: t.vector }))), name, { name: "CSV", extensions: ["csv"] }).catch((e) => { flash(`Export failed: ${e.message}`); return null; });
    if (r) flash(`Saved ${r}`);
  };
  const exportNetlist = async () => {
    // The netlist that actually ran while it matches the schematic; otherwise what Run would send now.
    let text = result && !stale.any ? result.netlist : "";
    if (!text) {
      const nl = generateNetlist(project);
      text = addSaves(nl.text, planCurrentSaves(project, nl, project.simulation.analysis).saves);
    }
    const r = await saveText(text, `${safeFileName(project.meta.name)}.cir`, { name: "SPICE netlist", extensions: ["cir", "sp", "net"] }).catch((e) => { flash(`Export failed: ${e.message}`); return null; });
    if (r) flash(`Saved ${r}`);
  };
  const exportPng = async () => {
    const c = plotRef.current?.toCanvas();
    if (!c) return;
    const r = await savePng(c, `${safeFileName(project.meta.name)}-${result?.analysis}.png`);
    if (r) flash(`Downloaded ${r}`);
  };

  const hasPlot = !!result?.ok && result.analysis !== "op" && traces.traces.length > 0;
  return (
    <section className="panel sim sim2" aria-label="Simulation" style={{ height }}>
      <div className="sim-resize" onPointerDown={onResize} onDoubleClick={() => setHeight((h) => (h < window.innerHeight * 0.55 ? Math.round(window.innerHeight * 0.65) : 360))}
        title="Drag to resize the simulation panel (double-click: tall / normal)" role="separator" aria-orientation="horizontal" />
      <SimBar sideHidden={sideHidden} toggleSide={() => setSideHidden((v) => !v)} />
      <div className="sim-main">
        {!sideHidden && <aside className="sim-side">
          <SetupSection />
          <ProbesSection />
          <div className="sim-exports">
            <span className="sec-title">Export</span>
            <button className="btn sm" onClick={exportCsv} disabled={!result?.ok} title={result?.ok ? "Save the shown traces as CSV" : "Run a simulation first"}>CSV</button>
            <button className="btn sm" onClick={exportNetlist} title={result && !stale.any ? "Save the netlist that was sent to ngspice for the shown result" : "Save the netlist Run would send for the current schematic"}>Netlist .cir</button>
            <button className="btn sm" onClick={exportPng} disabled={!hasPlot} title={hasPlot ? "Download the plot as PNG" : "Needs a transient or AC plot"}>Plot PNG</button>
            {notice && <div className="notice">{notice}</div>}
          </div>
        </aside>}
        <div className="sim-results">
          <ResultArea result={result} status={status} blocked={blocked} traces={traces.traces} missing={traces.missing}
            showAll={showAll} setShowAll={setShowAll} plotRef={plotRef} height={height} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- top bar

function SimBar({ sideHidden, toggleSide }: { sideHidden: boolean; toggleSide: () => void }) {
  const project = useProject((s) => s.project);
  const update = useProject((s) => s.update);
  const { status, result, run, stop, reset, continuous, setContinuous, startedAt, startLive, rerunning } = useSim();
  const stale = useStaleness();
  const [, force] = useState(0);
  useEffect(() => { if (status !== "running") return; const id = setInterval(() => force((n) => n + 1), 250); return () => clearInterval(id); }, [status]);
  const a = project.simulation.analysis;
  // Periodic sources, or a 555 (its op result is only the power-up state).
  const timeVarying = useMemo(() => sourceFrequencies(project).length > 0 || project.schematic.components.some((c) => c.type === "timer555"), [project]);
  const liveParts = useMemo(() => hasLiveParts(project), [project]);
  const operable = useMemo(() => project.schematic.components.some((c) => getPart(c.type)?.interactive), [project]);
  const label = status === "running" ? `Simulating… ${((Date.now() - (startedAt ?? Date.now())) / 1000).toFixed(1)} s`
    : rerunning ? "Re-simulating from 0 s with your changes…"
    : status === "done" ? `Done in ${result?.elapsedMs} ms`
    : status === "failed" ? "Failed: no results (see problems)"
    : status === "stopped" ? "Stopped: engine terminated, no results kept" : "Ready";
  return (
    <div className="sim-bar">
      <button className="btn sm" onClick={toggleSide} aria-pressed={!sideHidden} title={sideHidden ? "Show analysis setup, probes and exports" : "Hide the setup column so the scope gets the full width"}>
        {sideHidden ? "▸ Setup" : "◂ Setup"}
      </button>
      <select value={a} aria-label="Analysis" onChange={(e) => update("Simulation settings", (d) => { d.simulation.analysis = e.target.value as AnalysisKind; }, { merge: true })}>
        <option value="op">DC operating point</option>
        <option value="tran">Transient</option>
        <option value="ac">AC sweep (Bode)</option>
      </select>
      {status === "running"
        ? <button className="btn danger" onClick={stop} title="Terminates the ngspice engine. ngspice can't pause, so a stopped run returns no data.">■ Stop (terminate)</button>
        : <button className="btn primary" onClick={() => run()} title="Simulate the circuit">▶ Run</button>}
      {status !== "running" && (
        <button className="btn live" onClick={() => void startLive()}
          title="Transient run played back in real time (slowed for fast circuits). Click switches and buttons, drag potentiometers while it plays; every change re-simulates the whole run from 0 s with your change at the time you made it.">
          ⚡ Live
        </button>
      )}
      <button className="btn" onClick={reset} title="Clear results and restart the simulation engine">Reset</button>
      <span className={`status status-${status}`} role="status">{label}</span>
      {a === "op" && (
        <label className="chk" title="Re-run the operating point automatically about 0.4 s after each schematic edit">
          <input type="checkbox" checked={continuous} onChange={(e) => setContinuous(e.target.checked)} /> Re-run on edits
        </label>
      )}
      {result && status !== "running" && stale.any && (
        <span className="stale" role="note">
          ⚠ {stale.schematic ? "Schematic changed" : "Analysis settings changed"} since this result. Run again to update.
        </span>
      )}
      {result?.ok && !stale.any && stale.newProbes && <span className="stale">New probes need another run to get values.</span>}
      {a === "op" && (timeVarying || operable) && (
        <span className="hint-op small" role="note">
          {timeVarying ? "This circuit has sources that change over time" : "This circuit has parts you can operate"}; the DC operating point shows one fixed state.{" "}
          <button className="btn sm" onClick={() => update("Simulation settings", (d) => { d.simulation.analysis = "tran"; }, { merge: true })}>Use transient</button>
          {" "}or press ⚡ Live.
        </span>
      )}
      {a === "op" && !timeVarying && !operable && liveParts && result?.ok && result.analysis === "op" && (
        <span className="dim small">LEDs glow from the operating-point current.</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- setup

function Field({ label, value, onChange, help, error, width = 70 }: { label: string; value: string; onChange: (v: string) => void; help?: string; error?: boolean; width?: number }) {
  return (
    <label className="fld" title={help}>
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{ width }} aria-invalid={error || undefined} className={error ? "bad" : ""} />
    </label>
  );
}

function SetupSection() {
  const project = useProject((s) => s.project);
  const update = useProject((s) => s.update);
  const s = project.simulation;
  const set = (fn: (d: Project["simulation"]) => void) => update("Simulation settings", (d) => fn(d.simulation), { merge: true });
  const problems = useMemo(() => validateSetup(project, s.analysis), [project, s.analysis]);
  const bad = (code: string) => problems.some((p) => p.code.startsWith(code) && p.severity === "error");
  const tranHint = useMemo(() => (s.analysis === "tran" ? suggestTran(project) : null), [project, s.analysis]);
  const acHint = useMemo(() => (s.analysis === "ac" ? suggestAc(project) : null), [project, s.analysis]);
  const acSrc = useMemo(() => acSources(project), [project]);

  return (
    <div className="sec">
      <div className="sec-title">Analysis setup</div>
      {s.analysis === "op" && <p className="dim small">Solves the DC bias point: capacitors open, inductors shorted. Values appear on the schematic.</p>}
      {s.analysis === "tran" && <>
        <div className="row">
          <Field label="Stop" value={s.tran.stop} onChange={(v) => set((d) => { d.tran.stop = v; })} error={bad("setup-tran-stop") || bad("setup-tran-window")} help="Simulated time span, e.g. 10m = 10 ms" />
          <Field label="Max step" value={s.tran.step} onChange={(v) => set((d) => { d.tran.step = v; })} error={bad("setup-tran-step") || bad("setup-tran-order")}
            help="Largest internal time step. ngspice uses min(max step, (stop−start)/50) and takes smaller steps at fast edges." />
        </div>
        <div className="row">
          <Field label="Start saving" value={s.tran.start ?? ""} onChange={(v) => set((d) => { d.tran.start = v || undefined; })} error={bad("setup-tran-start")} help="Data before this time is computed but not saved (empty = 0)" />
          <label className="chk" title="Skip the initial operating point and start from capacitor initial voltages (UIC)">
            <input type="checkbox" checked={!!s.tran.uic} onChange={(e) => set((d) => { d.tran.uic = e.target.checked || undefined; })} /> Use initial conditions
          </label>
        </div>
        {tranHint
          ? <div className="hint-row"><button className="btn sm" onClick={() => set((d) => { d.tran.stop = tranHint.stop; d.tran.step = tranHint.step; })}
              disabled={tranHint.stop === s.tran.stop && tranHint.step === s.tran.step}>Use {tranHint.stop}s / {tranHint.step}s</button>
              <span className="dim small">{tranHint.reason}</span></div>
          : <p className="dim small">No periodic sources found; choose a stop time a few times longer than the slowest time constant.</p>}
      </>}
      {s.analysis === "ac" && <>
        <div className="row">
          <label className="fld"><span>Sweep</span>
            <select value={s.ac.sweep} onChange={(e) => set((d) => { d.ac.sweep = e.target.value as "dec" | "oct" | "lin"; })}>
              <option value="dec">Decade (log)</option><option value="oct">Octave (log)</option><option value="lin">Linear</option>
            </select>
          </label>
          <Field label={s.ac.sweep === "lin" ? "Points" : `Points/${s.ac.sweep === "dec" ? "decade" : "octave"}`} value={String(s.ac.points)} width={50}
            onChange={(v) => set((d) => { d.ac.points = v.trim() === "" ? NaN : Number(v); })} error={bad("setup-ac-points")} />
        </div>
        <div className="row">
          <Field label="From" value={s.ac.start} onChange={(v) => set((d) => { d.ac.start = v; })} error={bad("setup-ac-start") || bad("setup-ac-order")} help="Start frequency in Hz, e.g. 10 or 1k" />
          <Field label="To" value={s.ac.stop} onChange={(v) => set((d) => { d.ac.stop = v; })} error={bad("setup-ac-stop") || bad("setup-ac-order")} help="Stop frequency in Hz, e.g. 1MEG" />
        </div>
        {acHint && <div className="hint-row"><button className="btn sm" onClick={() => set((d) => { d.ac.start = acHint.start; d.ac.stop = acHint.stop; })}
          disabled={acHint.start === s.ac.start && acHint.stop === s.ac.stop}>Use {acHint.start}–{acHint.stop} Hz</button><span className="dim small">{acHint.reason}</span></div>}
        <p className="dim small">Driven by sources with a nonzero AC magnitude: {acSrc.ids.length ? project.schematic.components.filter((c) => acSrc.ids.includes(c.id)).map((c) => c.ref).join(", ") : "none"}.</p>
      </>}
      {problems.length > 0 && <DiagnosticList diags={problems} compact />}
    </div>
  );
}

// ---------------------------------------------------------------- probes

function ProbesSection() {
  const project = useProject((s) => s.project);
  const update = useProject((s) => s.update);
  const selection = useProject((s) => s.selection);
  const result = useSim((s) => s.result);
  const tPlay = usePlayback((s) => s.t);
  const valid = useValidUntil();
  const t = displayLimit(tPlay, valid);
  const runProject = useRunProject();
  const conn = useMemo(() => computeConnectivity(project), [project]);
  const refOf = (id: string) => project.schematic.components.find((c) => c.id === id)?.ref ?? "?";

  const nets = useMemo(() => conn.nets.filter((n) => !n.isGround && n.points.length).map((n) => {
    const pins = n.pins.slice(0, 3).map((p) => `${refOf(p.componentId)}.${getPart(project.schematic.components.find((c) => c.id === p.componentId)?.type ?? "")?.pins.find((x) => x.id === p.pinId)?.name ?? p.pinId}`);
    return { name: n.name, labeled: n.labelNames.length > 0, desc: `${n.name}${pins.length ? ` (${pins.join(", ")}${n.pins.length > 3 ? ", …" : ""})` : ""}` };
  }).sort((a, b) => Number(b.labeled) - Number(a.labeled) || a.name.localeCompare(b.name)), [conn]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = project.schematic.components.filter((c) => { const d = getPart(c.type); return d?.spice && !d.role; });

  const nextColor = () => {
    const used = new Set(project.simulation.probes.map((p) => p.color));
    return PROBE_COLORS.find((c) => !used.has(c)) ?? PROBE_COLORS[project.simulation.probes.length % PROBE_COLORS.length];
  };
  const add = (probes: Probe[]) => { if (probes.length) update(probes.length > 1 ? "Add probes" : `Add probe ${probes[0].label}`, (d) => { d.simulation.probes.push(...probes); }); };
  const voltageProbe = (netName: string): Probe | null => {
    const n = conn.nets.find((x) => x.name === netName); if (!n) return null;
    // Anchor to a pin tip or wire vertex so the probe follows the net even if its auto name (N003) changes.
    const pc = n.pins[0] && project.schematic.components.find((x) => x.id === n.pins[0].componentId);
    const pinPt = pc ? pinWorldPosition(pc, getPart(pc.type)!, n.pins[0].pinId) : undefined;
    return { id: newId("p"), kind: "voltage", target: { point: pinPt ?? n.points[0], netName: n.labelNames.length ? n.name : undefined }, label: `V(${n.name})`, color: nextColor() };
  };
  const addVoltage = (netName: string) => { const p = voltageProbe(netName); if (p) add([p]); };
  const addCurrent = (id: string) => add([{ id: newId("p"), kind: "current", target: { componentId: id }, label: `I(${refOf(id)})`, color: nextColor() }]);
  const fromSelection = () => {
    const out: Probe[] = [];
    const used = new Set<string>();
    for (const id of selection) {
      const c = parts.find((x) => x.id === id);
      if (c) { out.push({ id: newId("p"), kind: "current", target: { componentId: c.id }, label: `I(${c.ref})`, color: PROBE_COLORS[(project.simulation.probes.length + out.length) % PROBE_COLORS.length] }); continue; }
      const w = project.schematic.wires.find((x) => x.id === id);
      const net = w && conn.pointNet.get(keyOf(w.points[0]));
      if (w && net && !used.has(net)) { used.add(net); out.push({ id: newId("p"), kind: "voltage", target: { point: w.points[0], netName: conn.nets.find((n) => n.name === net)?.labelNames.length ? net : undefined }, label: `V(${net})`, color: PROBE_COLORS[(project.simulation.probes.length + out.length) % PROBE_COLORS.length] }); }
    }
    add(out);
  };
  const canFromSel = selection.some((id) => parts.some((c) => c.id === id) || project.schematic.wires.some((w) => w.id === id));

  const tr = result?.ok ? probeTraces(project, result, runProject) : null;
  const valueOf = (probeId: string) => {
    const tc = tr?.traces.find((x) => x.probeId === probeId);
    if (!tc || !result) return null;
    if (result.analysis === "op") return formatSI(tc.vector.real[0], tc.vector.unit, 4);
    if (result.analysis === "tran" && result.x) return formatSI(interpolate(result.x.real, tc.vector.real, t ?? result.x.real[result.x.real.length - 1]), tc.vector.unit, 4);
    return null;
  };

  return (
    <div className="sec">
      <div className="sec-title">Probes</div>
      <div className="row">
        <select value="" onChange={(e) => e.target.value && addVoltage(e.target.value)} aria-label="Add voltage probe on a net" disabled={!nets.length}>
          <option value="">+ Voltage on net…</option>
          {nets.map((n) => <option key={n.name} value={n.name}>{n.desc}</option>)}
        </select>
        <select value="" onChange={(e) => e.target.value && addCurrent(e.target.value)} aria-label="Add current probe on a part" disabled={!parts.length}>
          <option value="">+ Current in part…</option>
          {parts.map((c) => <option key={c.id} value={c.id}>{c.ref} ({getPart(c.type)?.name})</option>)}
        </select>
      </div>
      <button className="btn sm" onClick={fromSelection} disabled={!canFromSel} title="Selected parts get current probes, selected wires get voltage probes">Probe selection</button>
      {project.simulation.probes.length === 0
        ? <p className="dim small">No probes: plots show every node voltage and source current.</p>
        : <ul className="probe-list">
          {project.simulation.probes.map((p) => {
            const miss = tr?.missing.find((m) => m.probeId === p.id);
            const label = tr?.traces.find((x) => x.probeId === p.id)?.label ?? miss?.label ?? p.label;
            const v = valueOf(p.id);
            return (
              <li key={p.id}>
                <span className="swatch" style={{ background: p.color ?? "#888" }} />
                <span className="pl">{label}</span>
                <span className="pv">{v ?? (miss ? <span className="warn" title={miss.reason}>no data</span> : "")}</span>
                <button className="x" onClick={() => p.kind === "current" && p.target.componentId ? useProject.getState().setSelection([p.target.componentId]) : undefined}
                  title={p.kind === "current" ? "Select the probed part" : "Voltage probe"} disabled={p.kind !== "current"}>⌖</button>
                <button className="x" onClick={() => update(`Remove probe ${p.label}`, (d) => { d.simulation.probes = d.simulation.probes.filter((x) => x.id !== p.id); })} title="Remove probe" aria-label={`Remove probe ${label}`}>×</button>
              </li>
            );
          })}
        </ul>}
    </div>
  );
}


// ---------------------------------------------------------------- results

interface ResultProps {
  result: SimResult | null;
  status: string;
  blocked: Diagnostic[];
  traces: Trace[];
  missing: { probeId: string; label: string; reason: string }[];
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  plotRef: React.RefObject<PlotHandle | null>;
  height: number;
}

function ResultArea({ result, status, blocked, traces, missing, showAll, setShowAll, plotRef, height }: ResultProps) {
  const probesExist = useProject((s) => s.project.simulation.probes.length > 0);
  if (status === "running") return <div className="sim-msg">Simulating… ngspice computes the whole run before anything is shown. <b>Stop</b> terminates the engine (no partial results).</div>;
  if (blocked.length) return <div className="sim-msg"><b>Not run: fix the analysis setup first.</b><DiagnosticList diags={blocked} /></div>;
  if (status === "stopped") return <div className="sim-msg">Stopped by you. The engine was terminated; ngspice-WASM can't pause or hand back a partial run, so there are no results. Press Run to start over.</div>;
  if (!result) return <div className="sim-msg dim">Press <b>Run</b> to simulate. Add probes to choose what to plot; without probes every node voltage is shown.</div>;

  const plotH = Math.max(140, height - 250 - 20 * traces.length);
  return (
    <div className="result">
      {!result.ok && <div className="sim-fail" role="alert"><b>Simulation failed: no results are shown.</b> {result.diagnostics.find((d) => d.severity === "error")?.message}</div>}
      {result.diagnostics.length > 0 && <DiagnosticList diags={result.diagnostics} />}
      {result.ok && missing.length > 0 && (
        <div className="small warn">{missing.map((m) => <div key={m.probeId}>{m.label}: {m.reason}</div>)}</div>
      )}
      {result.ok && probesExist && (
        <label className="chk small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all signals instead of probes</label>
      )}
      {result.ok && result.analysis === "op" && <OpStress result={result} />}
      {result.ok && result.analysis === "op" && <OpTable traces={traces} />}
      {result.ok && result.analysis !== "op" && traces.length === 0 && <div className="sim-msg">The run produced no plottable signals for the selected probes.</div>}
      {result.ok && result.analysis === "tran" && traces.length > 0 && <TranView result={result} traces={traces} plotRef={plotRef} height={plotH} />}
      {result.ok && result.analysis === "ac" && traces.length > 0 && <BodeView result={result} traces={traces} plotRef={plotRef} height={plotH} />}
      <details className="raw">
        <summary>Netlist sent to ngspice</summary>
        <pre>{result.netlist || "(not generated: the run stopped at the design checks)"}</pre>
      </details>
      <details className="raw">
        <summary>ngspice log ({result.log.filter((l) => l.trim()).length} lines)</summary>
        <pre>{result.log.filter((l) => l.trim()).join("\n") || "(empty)"}</pre>
      </details>
    </div>
  );
}

const SEVERITY: { key: Diagnostic["severity"]; title: string }[] = [
  { key: "error", title: "Errors" }, { key: "warning", title: "Warnings" }, { key: "info", title: "Notes" },
];

export function DiagnosticList({ diags, compact }: { diags: Diagnostic[]; compact?: boolean }) {
  const setSelection = useProject((s) => s.setSelection);
  const comps = useProject((s) => s.project.schematic.components);
  return (
    <div className={`diag-groups${compact ? " compact" : ""}`}>
      {SEVERITY.map(({ key, title }) => {
        const list = diags.filter((d) => d.severity === key);
        if (!list.length) return null;
        return (
          <div key={key}>
            {!compact && <div className={`diag-head diag-head-${key}`}>{title} ({list.length})</div>}
            <ul className="diags">
              {list.map((d, i) => {
                const ids = [...(d.componentIds ?? []), ...(d.wireIds ?? [])];
                const refs = (d.componentIds ?? []).map((id) => comps.find((c) => c.id === id)?.ref).filter(Boolean);
                return (
                  <li key={i} className={`diag diag-${d.severity}${ids.length ? "" : " noclick"}`} onClick={() => ids.length && setSelection(ids)}
                    title={ids.length ? "Click to select the affected parts" : undefined}>
                    <b>{key === "error" ? "Error" : key === "warning" ? "Warning" : "Note"}:</b> {d.message}
                    {refs.length > 0 && <span className="dim"> [{refs.join(", ")}]</span>}
                    {d.fix && <div className="fix">How to fix: {d.fix}</div>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function OpTable({ traces }: { traces: Trace[] }) {
  return (
    <table className="op-table">
      <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
      <tbody>
        {traces.map((t) => <tr key={t.id}><td><span className="swatch" style={{ background: t.color }} />{t.label}</td><td>{formatSI(t.vector.real[0], t.vector.unit)}</td></tr>)}
      </tbody>
    </table>
  );
}

/** Scope divisions across the plot width in playback. */
const DIVS = 10;

function TranView({ result, traces, plotRef, height }: { result: SimResult; traces: Trace[]; plotRef: React.RefObject<PlotHandle | null>; height: number }) {
  const t = usePlayback((s) => s.t);
  const seek = usePlayback((s) => s.seek);
  const rate = usePlayback((s) => s.rate);
  const valid = useValidUntil();
  const basis = useSim((s) => s.basis); // replaced only by a fresh Run/Live, not by live re-runs
  const [div, setDiv] = useState<number | "auto">("auto");
  const x = result.x!.real;
  const t1 = usePlayback((s) => s.t1);
  useEffect(() => { if (t1 !== x[x.length - 1]) usePlayback.getState().adopt(result); }, [result, x, t1]);
  const series: PlotSeries[] = useMemo(() => traces.map((tr) => ({
    id: tr.id, label: tr.label, color: tr.color, x, y: tr.vector.real, pane: 0, axis: tr.vector.unit === "A" ? "right" : "left", unit: tr.vector.unit,
  })), [traces, x]);
  const hasV = series.some((s) => s.axis === "left"), hasA = series.some((s) => s.axis === "right");
  const panes: PaneSpec[] = [{ left: hasV ? { unit: "V", label: "Voltage (V)" } : undefined, right: hasA ? { unit: "A", label: "Current (A)" } : undefined }];
  // Auto: one division per second of playback, so the trace crosses the screen in 10 s at any time scale.
  const perDiv = div === "auto" ? rate : div;
  return (
    <>
      <PlaybackBar />
      <div className="scope-row">
        <label className="fld" title="Horizontal scale of the scope while playing. Auto ties it to the time scale: 1 division = 1 second of playback.">
          <span>Time/div</span>
          <select value={String(div)} onChange={(e) => setDiv(e.target.value === "auto" ? "auto" : Number(e.target.value))} aria-label="Time per division">
            <option value="auto">Auto ({formatSI(rate, "s", 3)})</option>
            {RATES.map((r) => <option key={r} value={r}>{formatSI(r, "s", 3)}</option>)}
          </select>
        </label>
        <span className="dim small">{t != null ? `Scrolling: ${DIVS} divisions = ${formatSI(DIVS * perDiv, "s", 3)} on screen` : "Showing the whole run (playback off)"}</span>
      </div>
      <Plot handle={plotRef} series={series} panes={panes} xUnit="s" xLabel="time" playhead={t} onSeek={(v) => seek(v)} measurements height={height}
        hideAfter={displayLimit(t, valid)} pendingFrom={valid} follow={t != null ? DIVS * perDiv : null} xDiv={t != null ? perDiv : undefined} resetKey={basis} />
    </>
  );
}

/** Index of a rate on the dial (RATES), nearest preset. */
const rateIndex = (r: number) => RATES.reduce((best, v, i) => (Math.abs(Math.log(v / r)) < Math.abs(Math.log(RATES[best] / r)) ? i : best), 0);

function TimeDial() {
  const rate = usePlayback((s) => s.rate);
  const setRate = usePlayback((s) => s.setRate);
  const t0 = usePlayback((s) => s.t0), t1 = usePlayback((s) => s.t1);
  const session = useSim((s) => s.session);
  const project = useRunProject();
  const auto = useMemo(() => {
    if (session?.live) return session.plan.rate;
    const a = autoRate(project), span = defaultRate(t1 - t0);
    return a != null ? Math.min(a, span) : span;
  }, [session, project, t0, t1]);
  const idx = rateIndex(rate), realIdx = RATES.indexOf(1);
  const factor = rate === 1 ? "real time" : rate < 1 ? `${Number((1 / rate).toPrecision(3)).toLocaleString()}× slower than real` : `${Number(rate.toPrecision(3))}× faster than real`;
  return (
    <div className="dial" role="group" aria-label="Time scale">
      <span className="dial-title" title="How much circuit time passes per second of playback. Changing it never changes the simulation, only how fast you watch it.">Time scale</span>
      <input type="range" min={0} max={RATES.length - 1} step={1} value={idx} list="sb-rate-ticks" aria-label="Circuit time per second"
        aria-valuetext={`${formatSI(rate, "s", 3)} per second`} onChange={(e) => setRate(RATES[Number(e.target.value)])} />
      <datalist id="sb-rate-ticks">{RATES.map((r, i) => (Math.log10(r) % 1 === 0 ? <option key={r} value={i} /> : null))}</datalist>
      <span className="dial-value mono">{formatSI(rate, "s", 3)}<span className="dim"> / s</span></span>
      <span className="dim small">{factor}</span>
      <button className={`btn sm${rate === 1 ? " on" : ""}`} onClick={() => setRate(RATES[realIdx])} title="1 s of circuit time per second">Real time</button>
      <button className={`btn sm${rate === auto ? " on" : ""}`} onClick={() => setRate(auto)} title="Chosen from the source frequencies or RC time constants so the action is visible">Auto ({formatSI(auto, "s", 3)}/s)</button>
    </div>
  );
}

function PlaybackBar() {
  const { t, playing, t0, t1, waiting, play, pause, seek, exit } = usePlayback();
  const session = useSim((s) => s.session);
  const rerunning = useSim((s) => s.rerunning);
  const { clearChanges, extend, repairAll } = useSim.getState();
  const operable = useProject((s) => s.project.schematic.components.some((c) => getPart(c.type)?.interactive));
  const stale = useStaleness();
  const span = t1 - t0;
  const pos = t ?? t1;
  const nChanges = session ? Object.values(session.changes).reduce((n, c) => n + c.length, 0) : 0;
  // Failures that have happened by the playback time.
  const damage: Diagnostic[] = [];
  for (const [id, list] of Object.entries(session?.damage ?? {})) {
    for (const d of list) if (d.t <= pos) damage.push({ severity: "warning", code: "part-damaged", source: "check", componentIds: [id], message: d.repairedAt != null && d.repairedAt <= pos ? `${d.message} (repaired at ${formatSI(d.repairedAt, "s", 4)})` : d.message, fix: d.fix });
  }
  const broken = Object.values(session?.damage ?? {}).some((l) => l.some((d) => d.repairedAt == null && d.t <= pos));
  return (
    <div className="playback-wrap">
      <div className="playback" aria-label="Playback of the computed result">
        {playing ? <button className="btn sm" onClick={pause} title="Pause playback">❚❚ Pause</button>
          : <button className="btn sm" onClick={play} title="Play the computed waveform and the values on the schematic">▶ Play</button>}
        <input type="range" min={0} max={1000} value={span > 0 ? Math.round((pos - t0) / span * 1000) : 0} aria-label="Playback position"
          onChange={(e) => seek(t0 + Number(e.target.value) / 1000 * span)} />
        <span className="mono small">{formatSI(pos, "s", 4)} / {formatSI(t1, "s", 4)}</span>
        {t != null && <button className="btn sm" onClick={exit} title="Show the end-of-run values">Exit playback</button>}
        {session && !session.live && t != null && t >= t1 && <button className="btn sm" onClick={extend} title="Re-simulate from 0 s with a longer stop time (your changes included)">Simulate further</button>}
      </div>
      <TimeDial />
      <div className="playback-notes small">
        {session?.live
          ? <span className="dim" title="Every extension re-simulates the whole run from 0 s with your changes; only the recent part is kept for display.">
              Live: ngspice computes ahead of the playhead and keeps going until you pause. The last {HISTORY_SECONDS} s of playback are kept for the scope.
            </span>
          : <span className="dim" title="ngspice computes a run before it is shown; playback only replays it.">Playback of a finished ngspice run.</span>}
        {session && operable && !stale.any && nChanges === 0 && <span>Click switches and buttons, drag potentiometers on the schematic while it plays.</span>}
        {session && operable && stale.any && <span className="warn">The schematic changed: run again to operate parts.</span>}
        {nChanges > 0 && <span className="live-note">
          Re-simulated from 0 s with your changes at the times you made them ({nChanges} change{nChanges > 1 ? "s" : ""}).{" "}
          <button className="btn sm" onClick={clearChanges} title="Forget the recorded changes and re-simulate with the parts' own settings">Clear changes</button>
        </span>}
        {rerunning && !waiting && <span className="live-note">Re-simulating from 0 s… nothing after your change is shown until it finishes.</span>}
        {waiting && <span className="live-note" role="status">Computing… (the simulation can't keep up at this speed; playback waits for it)</span>}
      </div>
      {damage.length > 0 && (
        <div className="damage" role="alert">
          <div className="damage-head">
            <b>💥 Component damage</b>
            <span className="dim small">Failed parts are modeled as open circuits from the failure time; real failures vary.</span>
            {broken && <button className="btn sm" onClick={repairAll} title="Replace the failed parts at the current playback time and re-simulate (they fail again if nothing changes)">Repair all parts</button>}
          </div>
          <DiagnosticList diags={damage} compact />
        </div>
      )}
    </div>
  );
}

/** Operating point: parts above their rating (static values, no averaging or failure modeling). */
function OpStress({ result }: { result: SimResult }) {
  const project = useRunProject();
  const diags = useMemo(() => stressTracks(project, result).filter((tr) => tr.ratio[0] > 1).map((tr): Diagnostic => ({
    severity: "warning", code: "part-overstress", source: "check", componentIds: [tr.componentId],
    message: `${tr.ref} is at ${Math.round(tr.ratio[0] * 100)} % of its ${tr.kind === "reverse-voltage" ? "reverse-voltage limit" : `${tr.kind} rating`} (${formatSI(tr.avg[0], tr.kind === "power" ? "W" : tr.kind === "current" ? "A" : "V", 3)} vs ${formatSI(tr.limit, tr.kind === "power" ? "W" : tr.kind === "current" ? "A" : "V", 3)}). It would fail; press ⚡ Live to watch when.`,
    fix: damageText(project, tr, 0).fix,
  })), [project, result]);
  return diags.length ? <DiagnosticList diags={diags} /> : null;
}

function BodeView({ result, traces, plotRef, height }: { result: SimResult; traces: Trace[]; plotRef: React.RefObject<PlotHandle | null>; height: number }) {
  const f = result.x!.real;
  const series: PlotSeries[] = useMemo(() => traces.flatMap((tr) => {
    const axis = tr.vector.unit === "A" ? "right" : "left";
    return [
      { id: `${tr.id}:mag`, label: `|${tr.label}| dB${tr.vector.unit}`, color: tr.color, x: f, y: magDb(tr.vector), pane: 0, axis, unit: "dB" },
      { id: `${tr.id}:ph`, label: `∠${tr.label}`, color: tr.color, x: f, y: phaseDeg(tr.vector), pane: 1, axis: "left", unit: "°" },
    ] as PlotSeries[];
  }), [traces, f]);
  const hasV = traces.some((t) => t.vector.unit !== "A"), hasA = traces.some((t) => t.vector.unit === "A");
  const panes: PaneSpec[] = [
    { left: hasV ? { unit: "dB", label: "Magnitude (dBV)" } : undefined, right: hasA ? { unit: "dB", label: "Magnitude (dBA)" } : undefined },
    { left: { unit: "°", label: "Phase (°)" } },
  ];
  const linear = useProject((s) => s.project.simulation.ac.sweep) === "lin";
  return <Plot handle={plotRef} series={series} panes={panes} xUnit="Hz" xLabel="frequency" xLog={!linear && f[0] > 0} height={Math.max(200, height + 30)} />;
}
