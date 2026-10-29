import { useState } from "react";
import { getPart } from "../core/library";
import { formatSI } from "../core/units";
import type { Diagnostic } from "../core/types";
import { STAGE_LABEL } from "./validate";
import { reviewStage, useAssistant, type Review } from "./store";

function Diags({ list }: { list: Diagnostic[] }) {
  if (!list.length) return null;
  return <ul className="diags">{list.map((d, i) => <li key={i} className={`diag diag-${d.severity}`}>{d.message}{d.fix ? <><br /><small>{d.fix}</small></> : null}</li>)}</ul>;
}

const fmtVal = (v: number | null, unit: string) => (v === null ? "—" : unit === "dB" ? `${v.toFixed(2)} dB` : formatSI(v, unit, 4));
const range = (min: number | null, max: number | null, unit: string) =>
  min !== null && max !== null ? `${fmtVal(min, unit)} … ${fmtVal(max, unit)}` : min !== null ? `≥ ${fmtVal(min, unit)}` : max !== null ? `≤ ${fmtVal(max, unit)}` : "any";
const unitOf = (m: string) => (m === "gain_db_at" ? "dB" : m === "f_3db" ? "Hz" : "V");

function Simulations({ r }: { r: Review }) {
  const { simulateReview } = useAssistant();
  const p = r.proposal;
  if (!p.simulations.length) return <p className="hint">The assistant suggested no simulations.</p>;
  return (
    <>
      {!r.sims.length && (
        <p>
          <button className="btn" onClick={() => simulateReview()} disabled={r.simRunning || !r.checks?.ok}>{r.simRunning ? "Simulating…" : "Run suggested simulations"}</button>
          {!r.checks?.ok && <span className="hint"> Fix the design-check errors first.</span>}
        </p>
      )}
      {p.simulations.map((s, i) => {
        const res = r.sims[i];
        return (
          <div key={i}>
            <p><b>{s.analysis.toUpperCase()}</b> {s.tran ? `0 → ${s.tran.stop} (step ${s.tran.step})` : ""}{s.ac ? `${s.ac.start} Hz → ${s.ac.stop} Hz, ${s.ac.pointsPerDecade}/decade` : ""} · {s.description}
              {res && <> · <span className={res.result.ok ? "ai-pass" : "ai-fail"}>{res.result.ok ? `ngspice ran in ${res.result.elapsedMs} ms` : "ngspice failed"}</span></>}</p>
            {res && !res.result.ok && <Diags list={res.result.diagnostics.filter((d) => d.severity !== "info")} />}
            {s.expectations.length > 0 && (
              <table>
                <thead><tr><th>Expectation (AI)</th><th>Net</th><th>Expected</th><th>Measured (ngspice)</th><th>Result</th></tr></thead>
                <tbody>
                  {s.expectations.map((e, j) => {
                    const x = res?.expectations[j];
                    return (
                      <tr key={j}>
                        <td>{e.description}<br /><small className="hint">{e.measure}{e.frequency ? ` @ ${formatSI(e.frequency, "Hz")}` : ""}</small></td>
                        <td>{e.net}</td>
                        <td>{range(e.min, e.max, unitOf(e.measure))}</td>
                        <td>{x ? (x.measured !== null ? fmtVal(x.measured, x.unit) : <span className="ai-na">{x.note}</span>) : <span className="ai-na">not run</span>}</td>
                        <td>{!x ? "" : x.pass === true ? <span className="ai-pass">matches</span> : x.pass === false ? <span className="ai-fail">doesn't match</span> : <span className="ai-na">not measured</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </>
  );
}

export function ReviewDialog() {
  const { review: r, apply, reject, closeReview, setApplySimSettings } = useAssistant();
  const [feedback, setFeedback] = useState("");
  if (!r) return null;
  const p = r.proposal;
  const stage = reviewStage(r);
  const byRef = new Map(p.parts.map((x) => [x.ref, x]));
  const disconnected = r.diff.pinMoves.filter((m) => m.kind === "disconnected");
  const warnings = r.check.diagnostics.filter((d) => d.severity !== "error");
  const fps = p.parts.filter((x) => x.kicadFootprint);

  return (
    <div className="ai-modal-bg">
      <div className="ai-modal" role="dialog" aria-label="Review AI proposal">
        <header>
          <h2>{p.title || "AI proposal"}</h2>
          <span className={`ai-stage ${stage}`} title="Validation status">{STAGE_LABEL[stage]}</span>
          <button className="btn" onClick={closeReview} title="Close without deciding (you can reopen it from the chat)">Close</button>
        </header>
        <div className="body">
          {r.rebased && <p className="warn">Your circuit changed while this proposal was open, so it was laid out again on the current circuit. Review it once more before applying.</p>}
          <p>{p.summary}</p>
          <p className="hint">Laid out {r.layout.style === "wired" ? "with wires and net labels" : "with net labels on the pins (automatic wiring was not possible)"}; existing parts keep their positions. Connections were verified against the proposal's nets.</p>

          <div className="ai-grid2">
            <div>
              <h3>Assumptions made by the AI</h3>
              {p.assumptions.length ? <ul className="ai-assume">{p.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul> : <p className="hint">None stated.</p>}
            </div>
            <div>
              <h3>Design checks</h3>
              {!r.checks ? <p className="hint">Running…</p> : r.checks.ok ? <p className="ai-pass">No errors.</p> : null}
              {r.checks && <Diags list={r.checks.diagnostics} />}
              {warnings.length > 0 && <Diags list={warnings} />}
            </div>
          </div>

          <h3>Parts</h3>
          {r.diff.parts.length === 0 ? <p className="hint">No part changes.</p> : (
            <table>
              <thead><tr><th>Change</th><th>Ref</th><th>Part</th><th>Values</th><th>Role (AI)</th></tr></thead>
              <tbody>
                {r.diff.parts.map((c) => {
                  const pp = byRef.get(c.ref);
                  const prov = getPart(c.type)?.provenance;
                  return (
                    <tr key={c.ref} className={pp?.uncertain ? "ai-uncertain" : ""}>
                      <td className={`k-${c.kind}`}>{c.kind}</td>
                      <td>{c.ref}</td>
                      <td>{c.name}{prov && <><br /><small className={`prov prov-${prov}`}>{prov}</small></>}</td>
                      <td>{c.props.filter((x) => x.to !== "" || x.from).map((x) => <div key={x.key}>{x.label}: {c.kind === "changed" ? <>{x.from ?? "—"} → <b>{x.to ?? "—"}</b></> : x.to}</div>)}</td>
                      <td>{pp?.role}{pp?.uncertain && <div className="ai-flag">⚠ uncertain: {pp.uncertaintyNote || "confirm this value"}</div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {p.parts.filter((x) => x.uncertain && !r.diff.parts.some((c) => c.ref === x.ref)).map((x) => <p key={x.ref} className="ai-flag">⚠ {x.ref} (unchanged) is marked uncertain: {x.uncertaintyNote}</p>)}

          <h3>Connections</h3>
          {disconnected.length > 0 && <p className="error">⚠ These existing pins lose all their connections: {disconnected.map((m) => `${m.pin} (was on ${m.from})`).join(", ")}. If that is not intended, ask the assistant to fix it.</p>}
          {r.diff.nets.length === 0 ? <p className="hint">No connection changes.</p> : (
            <table>
              <thead><tr><th>Change</th><th>Net</th><th>Joins</th><th>Leaves</th></tr></thead>
              <tbody>{r.diff.nets.map((n, i) => <tr key={i}><td className={`k-${n.kind}`}>{n.kind}</td><td>{n.name}</td><td>{n.joined.join(" ")}</td><td>{n.left.join(" ")}</td></tr>)}</tbody>
            </table>
          )}
          {r.diff.pinMoves.filter((m) => m.kind === "moved").length > 0 && <p className="warn">Moved pins: {r.diff.pinMoves.filter((m) => m.kind === "moved").map((m) => `${m.pin}: ${m.from} → ${m.to}`).join(", ")}</p>}

          <h3>Suggested simulations</h3>
          <Simulations r={r} />

          {(fps.length > 0 || p.kicadNotes.length > 0) && <>
            <h3>KiCad</h3>
            {fps.length > 0 && <table><thead><tr><th>Ref</th><th>Footprint</th><th>In installed KiCad libraries</th></tr></thead><tbody>
              {fps.map((x) => { const st = r.footprints[x.kicadFootprint!]; return <tr key={x.ref}><td>{x.ref}</td><td><code>{x.kicadFootprint}</code></td><td className={st === "found" ? "ai-pass" : st === "missing" ? "ai-fail" : "ai-na"}>{st === "found" ? "found" : st === "missing" ? "not found: check the name" : "could not check"}</td></tr>; })}
            </tbody></table>}
            {p.kicadNotes.length > 0 && <ul>{p.kicadNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </>}
        </div>
        <footer>
          {p.simulations.length > 0 && <label><input type="checkbox" checked={r.applySimSettings} onChange={(e) => setApplySimSettings(e.target.checked)} /> Also set the simulation to the first suggested analysis</label>}
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={apply} disabled={!r.checks || r.simRunning} title="One undoable step (Ctrl+Z)">Apply</button>
          <button className="btn" onClick={() => reject()}>Reject</button>
        </footer>
        <footer>
          <input type="text" placeholder="Ask for changes (e.g. use 12 V, fewer parts)…" value={feedback} onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && feedback.trim()) { void reject(feedback); setFeedback(""); } }} aria-label="Requested changes" />
          <button className="btn" disabled={!feedback.trim()} onClick={() => { void reject(feedback); setFeedback(""); }}>Send back to the assistant</button>
        </footer>
      </div>
    </div>
  );
}
