// Simulation controls and results (first version: analysis settings, run/stop, diagnostics,
// operating-point table, basic plot).
import { useProject } from "../core/store";
import type { AnalysisKind, SimResult } from "../core/types";
import { formatSI } from "../core/units";
import { useResultStale, useSim } from "./store";

export function SimPanel() {
  const { project, update, setSelection } = useProject();
  const { status, result, run, stop } = useSim();
  const stale = useResultStale();
  const s = project.simulation;
  const setSim = (fn: (d: typeof s) => void) => update("Simulation settings", (d) => fn(d.simulation), { merge: true });

  return (
    <section className="panel sim" aria-label="Simulation">
      <div className="sim-bar">
        <select value={s.analysis} onChange={(e) => setSim((d) => { d.analysis = e.target.value as AnalysisKind; })} aria-label="Analysis">
          <option value="op">DC operating point</option>
          <option value="tran">Transient</option>
          <option value="ac">AC sweep</option>
        </select>
        {s.analysis === "tran" && <>
          <label>Stop <input value={s.tran.stop} onChange={(e) => setSim((d) => { d.tran.stop = e.target.value; })} size={6} /></label>
          <label>Max step <input value={s.tran.step} onChange={(e) => setSim((d) => { d.tran.step = e.target.value; })} size={6} /></label>
        </>}
        {s.analysis === "ac" && <>
          <label>From <input value={s.ac.start} onChange={(e) => setSim((d) => { d.ac.start = e.target.value; })} size={6} /></label>
          <label>To <input value={s.ac.stop} onChange={(e) => setSim((d) => { d.ac.stop = e.target.value; })} size={6} /></label>
          <label>Points/decade <input type="number" value={s.ac.points} onChange={(e) => setSim((d) => { d.ac.points = Number(e.target.value); })} style={{ width: 60 }} /></label>
        </>}
        {status === "running"
          ? <button className="btn danger" onClick={stop}>■ Stop</button>
          : <button className="btn primary" onClick={() => run()}>▶ Run</button>}
        <span className={`status status-${status}`}>{status === "running" ? "Simulating…" : status === "done" ? `Done in ${result?.elapsedMs} ms` : status === "failed" ? "Failed, see below" : status === "stopped" ? "Stopped" : "Ready"}</span>
        {stale && <span className="stale">Schematic changed since this result. Run again to update.</span>}
      </div>
      <div className="sim-body">
        {result && result.diagnostics.length > 0 && (
          <ul className="diags">
            {result.diagnostics.map((d, i) => (
              <li key={i} className={`diag diag-${d.severity}`} onClick={() => d.componentIds?.length && setSelection([...d.componentIds, ...(d.wireIds ?? [])])}>
                <b>{d.severity === "error" ? "Error" : d.severity === "warning" ? "Warning" : "Info"}:</b> {d.message}
                {d.fix && <div className="fix">How to fix: {d.fix}</div>}
              </li>
            ))}
          </ul>
        )}
        {result?.ok && result.analysis === "op" && <OpTable result={result} />}
        {result?.ok && result.analysis !== "op" && <MiniPlot result={result} />}
      </div>
    </section>
  );
}

function OpTable({ result }: { result: SimResult }) {
  const comps = useProject((s) => s.project.schematic.components);
  return (
    <table className="op-table">
      <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
      <tbody>
        {result.vectors.map((v) => (
          <tr key={v.name}>
            <td>{v.kind === "voltage" ? `V(${v.netName})` : v.kind === "current" ? `I(${comps.find((c) => c.id === v.componentId)?.ref ?? v.name})` : v.name}</td>
            <td>{formatSI(v.real[0], v.unit)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MiniPlot({ result }: { result: SimResult }) {
  const x = result.x!;
  const traces = result.vectors.filter((v) => v.kind === "voltage" && v.netName !== "0");
  const W = 800, H = 220;
  const mag = (v: (typeof traces)[number]) => v.imag ? v.real.map((r, i) => 20 * Math.log10(Math.hypot(r, v.imag![i]) || 1e-30)) : v.real;
  const ys = traces.map(mag);
  const isAc = result.analysis === "ac";
  const xs = isAc ? x.real.map((f) => Math.log10(f)) : x.real;
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const all = ys.flat(); const ymin = Math.min(...all), ymax = Math.max(...all);
  const pad = (ymax - ymin) * 0.08 || 1;
  const sx = (v: number) => ((v - xmin) / (xmax - xmin || 1)) * W;
  const sy = (v: number) => H - ((v - (ymin - pad)) / (ymax - ymin + 2 * pad)) * H;
  const colors = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176"];
  return (
    <div className="miniplot">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H}>
        {ys.map((y, k) => <polyline key={k} fill="none" stroke={colors[k % colors.length]} strokeWidth={1.5} vectorEffect="non-scaling-stroke"
          points={y.map((v, i) => `${sx(xs[i])},${sy(v)}`).join(" ")} />)}
      </svg>
      <div className="legend">
        {traces.map((t, k) => <span key={t.name} style={{ color: colors[k % colors.length] }}>■ V({t.netName}){isAc ? " dB" : ""}</span>)}
        <span className="axis">x: {formatSI(isAc ? x.real[0] : xmin, x.unit)} … {formatSI(isAc ? x.real[x.real.length - 1] : xmax, x.unit)} · y: {formatSI(ymin, isAc ? "dB" : "V")} … {formatSI(ymax, isAc ? "dB" : "V")}</span>
      </div>
    </div>
  );
}
