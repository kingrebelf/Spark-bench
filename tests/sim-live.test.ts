import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { Builder, engine } from "./helpers";
import { generateNetlist } from "../src/core/netlist";
import { runSimulation } from "../src/sim/run";
import { interpolate } from "../src/scope/measure";
import { autoRate, livePlan, recordChange, toPwl, valueAt, niceRate, defaultRate, RATES } from "../src/sim/live";
import type { Project, SimResult } from "../src/core/types";
import type { EngineOutput, SpiceEngine } from "../src/core/simulate";
import { useProject } from "../src/core/store";
import { setSimEngine, usePlayback, useSim } from "../src/sim/store";

/** 5 V -> R1 330 -> SW1 -> LED -> gnd, joined by labels. */
function ledSwitch(part: "switch_spst" | "push_button" = "switch_spst") {
  const b = new Builder();
  const V = b.place("vdc", "V1", 0, 10, { value: "5" });
  const R = b.place("resistor", "R1", 10, 10, { value: "330" });
  const S = b.place(part, "SW1", 30, 10);
  const D = b.place("led", "D1", 50, 10, { color: "red" });
  const G = b.place("ground", "#PWR1", 70, 10);
  b.label("vcc", b.pin(V, "1")).label("vcc", b.pin(R, "1"));
  b.label("a", b.pin(R, "2")).label("a", b.pin(S, "1"));
  b.label("b", b.pin(S, "2")).label("b", b.pin(D, "A"));
  b.label("gnd", b.pin(D, "K")).label("gnd", b.pin(V, "2")).label("gnd", b.pin(G, "1"));
  b.project.simulation.tran = { stop: "10m", step: "10u" };
  return { b, S, D };
}

/** 10 V across RV1 (pin 1 top, pin 3 gnd); wiper = out. */
function potDivider(position = "50") {
  const b = new Builder();
  const V = b.place("vdc", "V1", 0, 10, { value: "10" });
  const P = b.place("potentiometer", "RV1", 20, 10, { value: "10k", position });
  const G = b.place("ground", "#PWR1", 40, 10);
  const L = b.place("resistor", "RL", 60, 10, { value: "1G" }); // a probe-like load, so "out" is connected
  b.label("top", b.pin(V, "1")).label("top", b.pin(P, "1"));
  b.label("out", b.pin(P, "2")).label("out", b.pin(L, "1")).label("gnd", b.pin(L, "2"));
  b.label("gnd", b.pin(P, "3")).label("gnd", b.pin(V, "2")).label("gnd", b.pin(G, "1"));
  b.project.simulation.tran = { stop: "10m", step: "10u" };
  return { b, P };
}

const at = (r: SimResult, name: (n: string) => boolean, t: number) => {
  const v = r.vectors.find((x) => name(x.name.toLowerCase()))!;
  expect(v, "vector").toBeTruthy();
  return r.x ? interpolate(r.x.real, v.real, t) : v.real[0];
};
const ledI = (r: SimResult, t: number) => at(r, (n) => n.includes("@d1[id]"), t);

describe("live schedules", () => {
  it("turns recorded steps into strictly increasing PWL points with short edges", () => {
    expect(toPwl(0, [], 1e-6)).toEqual([[0, 0]]);
    expect(toPwl(0, [[2e-3, 1]], 1e-6)).toEqual([[0, 0], [2e-3, 0], [2e-3 + 1e-6, 1]]);
    // same-value changes are dropped, a change at t=0 sets the starting value, collisions are pushed apart
    const p = toPwl(0, [[0, 1], [1e-3, 1], [1e-3, 0], [1e-3, 1]], 1e-6);
    expect(p[0]).toEqual([0, 1]);
    for (let i = 1; i < p.length; i++) expect(p[i][0]).toBeGreaterThan(p[i - 1][0]);
    expect(p[p.length - 1][1]).toBe(1);
  });

  it("records changes with step semantics and replaces the part's later changes", () => {
    let c = recordChange(undefined, 1, 1);
    c = recordChange(c, 3, 0);
    expect(valueAt(0, c, 0.5)).toBe(0);
    expect(valueAt(0, c, 2)).toBe(1);
    expect(valueAt(0, c, 3.5)).toBe(0);
    c = recordChange(c, 2, 0); // went back to t=2 and changed it: the t=3 change is gone
    expect(c).toEqual([[1, 1], [2, 0]]);
  });

  it("emits a PWL-controlled switch only in live mode; the static netlist is unchanged", () => {
    const { b, S } = ledSwitch();
    const plain = generateNetlist(b.project, "tran").text;
    expect(plain).toMatch(/^RSW1 a b 1e\+9$/m);
    expect(plain).not.toMatch(/PWL|sbl_/);
    const live = generateNetlist(b.project, "tran", undefined, { schedules: new Map([[S.id, toPwl(0, [[5e-3, 1]], 1e-6)]]) }).text;
    expect(live).toMatch(/^SW1 a b sbl_SW1 0 SBL_SW_SW1$/m);
    expect(live).toMatch(/^Vsbl_SW1 sbl_SW1 0 PWL\(0e\+0 0e\+0 5e-3 0e\+0 5\.001e-3 1e\+0\)$/m);
    expect(live).toMatch(/\.model SBL_SW_SW1 SW\(Ron=1e-2 Roff=1e\+9 Vt=0\.5 Vh=0\)/);
  });

  it("re-simulation honors a switch toggle at t: LED current ~0 before, lit after", async () => {
    const { b, S } = ledSwitch();
    const r = await runSimulation(b.project, engine(), "tran", { schedules: new Map([[S.id, toPwl(0, [[5e-3, 1]], 1e-6)]]) });
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
    expect(Math.abs(ledI(r, 4e-3))).toBeLessThan(1e-6);
    expect(ledI(r, 6e-3)).toBeGreaterThan(5e-3);
    expect(ledI(r, 6e-3)).toBeLessThan(15e-3);
    // internal control source/node never pose as circuit signals for the switch
    expect(r.vectors.find((v) => v.componentId === S.id && v.kind === "current")).toBeUndefined();
  }, 60_000);

  it("a held push button conducts only while held", async () => {
    const { b, S } = ledSwitch("push_button");
    const r = await runSimulation(b.project, engine(), "tran", { schedules: new Map([[S.id, toPwl(0, [[3e-3, 1], [6e-3, 0]], 1e-6)]]) });
    expect(r.ok).toBe(true);
    expect(Math.abs(ledI(r, 2e-3))).toBeLessThan(1e-6);
    expect(ledI(r, 4.5e-3)).toBeGreaterThan(5e-3);
    expect(Math.abs(ledI(r, 8e-3))).toBeLessThan(1e-6);
  }, 60_000);

  it("LED current is saved automatically in transient and op, without a probe", async () => {
    const { b } = ledSwitch();
    b.project.schematic.components.find((c) => c.ref === "SW1")!.props.closed = true;
    const op = await runSimulation(b.project, engine(), "op");
    expect(op.ok).toBe(true);
    expect(op.netlist).toMatch(/\.save all .*@d1\[id\]/i);
    expect(ledI(op, 0)).toBeGreaterThan(5e-3);
  }, 60_000);

  it("dragging a pot changes the divider output at the recorded time", async () => {
    const { b, P } = potDivider("50");
    const r = await runSimulation(b.project, engine(), "tran", { schedules: new Map([[P.id, toPwl(50, [[5e-3, 80]], 1e-6)]]) });
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
    const out = (t: number) => at(r, (n) => n === "v(out)", t);
    expect(out(4e-3)).toBeCloseTo(5, 3);
    expect(out(6e-3)).toBeCloseTo(8, 3);
    // end stops behave like the static model (1 mΩ clamp, no division by zero)
    const r0 = await runSimulation(b.project, engine(), "tran", { schedules: new Map([[P.id, toPwl(0, [[5e-3, 100]], 1e-6)]]) });
    expect(r0.ok).toBe(true);
    expect(at(r0, (n) => n === "v(out)", 4e-3)).toBeCloseTo(0, 3);
    expect(at(r0, (n) => n === "v(out)", 6e-3)).toBeCloseTo(10, 3);
  }, 60_000);
});

describe("live time scale", () => {
  const proj = (sources: { f: string }[]): Project => {
    const b = new Builder();
    sources.forEach((s, i) => b.place("vsine", `V${i + 1}`, i * 10, 0, { frequency: s.f }));
    b.project.simulation.tran = { stop: "10m", step: "10u" };
    return b.project;
  };
  it("plays in real time without periodic sources and slows down for fast ones", () => {
    const still = livePlan(proj([]));
    expect(still.rate).toBe(1);
    expect(still.stop).toBe(20);
    expect(still.stop / still.step).toBeLessThanOrEqual(100_001);
    const khz = livePlan(proj([{ f: "1k" }]));
    expect(khz.rate).toBe(2e-3); // two cycles of 1 kHz per second
    expect(khz.step).toBeLessThanOrEqual(1 / (1000 * 50));
    expect(khz.stop).toBeCloseTo(0.04, 12);
    expect(niceRate(0.003)).toBe(0.002);
    expect(defaultRate(5)).toBe(1);
    expect(defaultRate(0.02)).toBe(0.002);
  });
});

/** Node engine that counts runs and terminations (a drag must never terminate the worker). */
class CountingEngine implements SpiceEngine {
  runs = 0;
  stops = 0;
  async run(netlist: string): Promise<EngineOutput> { this.runs++; return engine().run(netlist); }
  stop() { this.stops++; }
}

/** Wait until no chunk is being computed for a few polls. */
async function settle() {
  let quiet = 0;
  for (let i = 0; i < 1000 && quiet < 4; i++) {
    await new Promise((r) => setTimeout(r, 15));
    quiet = useSim.getState().computing || useSim.getState().status === "running" ? 0 : quiet + 1;
  }
}
const endOf = () => { const x = useSim.getState().result!.x!.real; return x[x.length - 1]; };

describe("chunked live session in the store", () => {
  it("a toggle continues from the last real timepoint at or before the playhead; earlier data is untouched", async () => {
    const { b, S } = ledSwitch();
    useProject.getState().load(b.project);
    setSimEngine(engine());
    await useSim.getState().run("tran");
    usePlayback.getState().pause();
    await settle();
    const first = useSim.getState().result!;
    const x0 = first.x!.real;
    expect(ledI(first, 8e-3)).toBeLessThan(1e-6);
    usePlayback.getState().seek(5e-3);
    useSim.getState().change(S.id, 1);
    // cut at once at a sample of the old run, no later than the playhead
    const s = useSim.getState().session!;
    expect(s.lastChange!.t).toBeLessThanOrEqual(5e-3);
    expect(x0).toContain(s.lastChange!.t);
    expect(endOf()).toBe(s.lastChange!.t);
    await settle();
    const r = useSim.getState().result!;
    expect(endOf()).toBeCloseTo(10e-3, 9);
    expect(ledI(r, 3e-3)).toBe(ledI(first, 3e-3)); // the past is not recomputed
    expect(Math.abs(ledI(r, 4.9e-3))).toBeLessThan(1e-6);
    expect(ledI(r, 6e-3)).toBeGreaterThan(5e-3);
    expect(useSim.getState().session!.lastChange!.latencyMs).toBeGreaterThanOrEqual(0);
    useSim.getState().reset();
  }, 60_000);

  it("a live session keeps computing ahead of the playhead while it plays, with no gaps", async () => {
    const { b } = ledSwitch();
    useProject.getState().load(b.project);
    setSimEngine(engine());
    await useSim.getState().startLive();
    await new Promise((r) => setTimeout(r, 2500));
    const t = usePlayback.getState().t!;
    usePlayback.getState().pause();
    await settle();
    expect(t).toBeGreaterThan(1.5); // real time
    expect(endOf()).toBeGreaterThan(t);
    const x = useSim.getState().result!.x!.real;
    for (let i = 1; i < x.length; i++) expect(x[i]).toBeGreaterThan(x[i - 1]);
    useSim.getState().reset();
  }, 60_000);

  it("a burst of pot changes is coalesced, never terminates the engine, and the latest value wins", async () => {
    const { b, P } = potDivider("50");
    useProject.getState().load(b.project);
    const eng = new CountingEngine();
    setSimEngine(eng);
    await useSim.getState().startLive();
    usePlayback.getState().pause();
    await settle();
    usePlayback.getState().seek(0.5);
    for (let v = 55; v <= 90; v += 5) useSim.getState().change(P.id, v);
    await settle();
    expect(eng.stops).toBe(0);
    const r = useSim.getState().result!;
    const tk = useSim.getState().session!.lastChange!.t;
    expect(at(r, (n) => n === "v(out)", tk / 2)).toBeCloseTo(5, 2);
    expect(at(r, (n) => n === "v(out)", tk + 0.05)).toBeCloseTo(9, 2);
    useSim.getState().reset();
  }, 60_000);

  it("damage averages carry across chunks: a sustained overload fails at the same time as in one run", async () => {
    // 12 V -> SW1 -> 100 Ω rated 0.85 W: closed, 1.44 W fails after 0.5 s · ln(1.44 / 0.59) ≈ 0.45 s,
    // longer than any one chunk (a per-chunk average would never reach the limit).
    const bld = new Builder();
    const V = bld.place("vdc", "V1", 0, 10, { value: "12" });
    const S = bld.place("switch_spst", "SW1", 20, 10);
    const R = bld.place("resistor", "R1", 40, 10, { value: "100", power: "0.85" });
    const G = bld.place("ground", "#PWR1", 60, 10);
    bld.label("top", bld.pin(V, "1")).label("top", bld.pin(S, "1")).label("a", bld.pin(S, "2")).label("a", bld.pin(R, "1"));
    bld.label("gnd", bld.pin(R, "2")).label("gnd", bld.pin(V, "2")).label("gnd", bld.pin(G, "1"));
    useProject.getState().load(bld.project);
    setSimEngine(engine());
    await useSim.getState().startLive();
    usePlayback.getState().pause();
    await settle();
    usePlayback.getState().seek(0.3);
    useSim.getState().change(S.id, 1);
    const tClose = useSim.getState().session!.lastChange!.t;
    // advance the playhead so the session computes well past the failure
    for (const t of [0.6, 0.9, 1.2]) { usePlayback.getState().seek(Math.min(t, endOf())); await settle(); usePlayback.getState().play(); usePlayback.getState().pause(); }
    await settle();
    const d = useSim.getState().session!.damage[R.id];
    expect(d, "R1 failed").toHaveLength(1);
    expect(d[0].t - tClose).toBeGreaterThan(0.43);
    expect(d[0].t - tClose).toBeLessThan(0.47);
    expect(d[0].message).toMatch(/R1 dissipated 1\.44 W \(rated 850 mW\)/);
    useSim.getState().reset();
  }, 60_000);

  it("an LED straight on 9 V burns out, stays open, and Repair all reconnects it at the playhead", async () => {
    const bld = new Builder();
    const V = bld.place("vdc", "V1", 0, 10, { value: "9" });
    const D = bld.place("led", "D1", 20, 10, { color: "red" });
    const G = bld.place("ground", "#PWR1", 40, 10);
    bld.label("top", bld.pin(V, "1")).label("top", bld.pin(D, "A"));
    bld.label("gnd", bld.pin(D, "K")).label("gnd", bld.pin(V, "2")).label("gnd", bld.pin(G, "1"));
    bld.project.simulation.tran = { stop: "100m", step: "100u" };
    useProject.getState().load(bld.project);
    setSimEngine(engine());
    await useSim.getState().run("tran");
    usePlayback.getState().pause();
    await settle();
    let st = useSim.getState();
    expect(endOf()).toBeCloseTo(0.1, 9);
    const dmg = st.session!.damage[D.id];
    expect(dmg).toHaveLength(1);
    expect(dmg[0].t).toBeLessThan(1e-3);
    const i = (t: number) => interpolate(st.result!.x!.real, st.result!.vectors.find((v) => v.componentId === D.id && v.kind === "current")!.real, t);
    expect(Math.abs(i(0.05))).toBeLessThan(1e-6);

    usePlayback.getState().seek(0.05);
    useSim.getState().repairAll();
    await settle();
    st = useSim.getState();
    const list = st.session!.damage[D.id];
    expect(list[0].repairedAt).toBeLessThanOrEqual(0.05);
    expect(list).toHaveLength(2); // fails again right after the repair: nothing limits the current
    expect(list[1].t).toBeGreaterThan(list[0].repairedAt!);
    expect(list[1].t - list[0].repairedAt!).toBeLessThan(2e-3);
    useSim.getState().reset();
  }, 60_000);
});

describe("time-scale dial", () => {
  const sine = (f: string) => { const b = new Builder(); b.place("vsine", "V1", 0, 0, { frequency: f }); return b.project; };
  it("defaults to about two source periods per second, real time for a ~1 Hz 555, and offers 1-2-5 steps", () => {
    expect(autoRate(sine("1k"))).toBe(2e-3);
    expect(autoRate(sine("50"))).toBe(0.02);
    expect(autoRate(sine("0.01"))).toBe(10); // capped
    const blinker = JSON.parse(readFileSync("examples/555-astable-blinker.sbproj", "utf8"));
    expect(autoRate(blinker)).toBe(1);
    expect(autoRate(new Builder().project)).toBeNull();
    expect(RATES).toContain(1);
    expect(RATES).toContain(1e-6);
    expect(RATES[RATES.length - 1]).toBe(10);
    for (let i = 1; i < RATES.length; i++) expect(RATES[i] / RATES[i - 1]).toBeLessThanOrEqual(2.5 + 1e-9);
  });
});
