import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { Builder, engine } from "./helpers";
import { generateNetlist } from "../src/core/netlist";
import { runSimulation } from "../src/sim/run";
import { interpolate } from "../src/scope/measure";
import { autoRate, displayLimit, livePlan, recordChange, toPwl, validUntil, valueAt, niceRate, defaultRate, RATES } from "../src/sim/live";
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

  it("never lets data past an unapplied change be displayed", () => {
    const log = [{ seq: 1, t: 0.004 }, { seq: 2, t: 0.002 }, { seq: 3, t: 0.007 }];
    expect(validUntil(log, 3)).toBeNull();
    expect(validUntil(log, 1)).toBe(0.002); // result computed with change 1 only: changes 2, 3 pending
    expect(validUntil(log, 2)).toBe(0.007);
    expect(displayLimit(0.009, validUntil(log, 1))).toBe(0.002);
    expect(displayLimit(0.001, validUntil(log, 1))).toBe(0.001);
    expect(displayLimit(null, null)).toBeNull();
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

/** Node engine whose runs wait for `release()`, to look at the store while a re-run is in flight. */
class GatedEngine implements SpiceEngine {
  gate: Promise<void> = Promise.resolve();
  private open: () => void = () => {};
  hold() { this.gate = new Promise((r) => { this.open = r; }); }
  release() { this.open(); }
  async run(netlist: string): Promise<EngineOutput> { await this.gate; return engine().run(netlist); }
  stop() { /* nothing to terminate in Node */ }
}

describe("live session in the store", () => {
  it("records a toggle at the playhead, hides data past it until the re-run lands, then shows the new run", async () => {
    const { b, S } = ledSwitch();
    useProject.getState().load(b.project);
    const eng = new GatedEngine();
    setSimEngine(eng);
    await useSim.getState().run("tran");
    usePlayback.getState().pause();
    const first = useSim.getState().result!;
    expect(first.ok).toBe(true);
    expect(useSim.getState().session?.live).toBe(false);
    expect(ledI(first, 8e-3)).toBeLessThan(1e-6);

    usePlayback.getState().seek(5e-3);
    eng.hold();
    useSim.getState().change(S.id, 1);
    let st = useSim.getState();
    expect(st.rerunning).toBe(true);
    expect(st.result).toBe(first); // the old run stays shown…
    const valid = validUntil(st.session!.log, st.resultSeq);
    expect(valid).toBeCloseTo(5e-3, 12); // …but only up to the change
    expect(displayLimit(9e-3, valid)).toBeCloseTo(5e-3, 12);

    eng.release();
    await new Promise<void>((r) => { const u = useSim.subscribe((x) => { if (!x.rerunning) { u(); r(); } }); });
    st = useSim.getState();
    expect(validUntil(st.session!.log, st.resultSeq)).toBeNull();
    expect(st.result).not.toBe(first);
    expect(Math.abs(ledI(st.result!, 4e-3))).toBeLessThan(1e-6);
    expect(ledI(st.result!, 6e-3)).toBeGreaterThan(5e-3);
    expect(st.result!.netlist).toMatch(/PWL\(/);
    expect(usePlayback.getState().t).toBeCloseTo(5e-3, 12); // playback position kept
    useSim.getState().reset();
  }, 60_000);

  it("a change at the end of the run extends the stop time", async () => {
    const { b, S } = ledSwitch();
    useProject.getState().load(b.project);
    setSimEngine(engine());
    await useSim.getState().run("tran");
    usePlayback.getState().pause();
    const t1 = usePlayback.getState().t1;
    usePlayback.getState().seek(t1);
    useSim.getState().change(S.id, 1);
    expect(useSim.getState().session!.stop).toBeGreaterThan(t1);
    await new Promise<void>((r) => { const u = useSim.subscribe((x) => { if (!x.rerunning) { u(); r(); } }); });
    const r = useSim.getState().result!;
    expect(r.x!.real[r.x!.real.length - 1]).toBeGreaterThan(t1 * 1.5);
    expect(ledI(r, t1 * 1.4)).toBeGreaterThan(5e-3);
    useSim.getState().reset();
  }, 60_000);
});

/** Wait until no re-run is in flight or pending for a few polls. */
async function settle() {
  let quiet = 0;
  for (let i = 0; i < 500 && quiet < 4; i++) {
    await new Promise((r) => setTimeout(r, 20));
    quiet = useSim.getState().rerunning ? 0 : quiet + 1;
  }
}

describe("session extension and damage in the store", () => {
  it("extending the run keeps the recorded schedule (re-simulated from 0 s, longer)", async () => {
    const { b, S } = ledSwitch();
    useProject.getState().load(b.project);
    setSimEngine(engine());
    await useSim.getState().run("tran");
    usePlayback.getState().pause();
    usePlayback.getState().seek(5e-3);
    useSim.getState().change(S.id, 1);
    await settle();
    useSim.getState().extend();
    await settle();
    const r = useSim.getState().result!;
    expect(r.x!.real[r.x!.real.length - 1]).toBeCloseTo(20e-3, 6);
    expect(Math.abs(ledI(r, 4e-3))).toBeLessThan(1e-6);
    expect(ledI(r, 15e-3)).toBeGreaterThan(5e-3); // still closed in the extended part
    useSim.getState().reset();
  }, 60_000);

  it("an LED straight on 9 V burns out, is re-simulated as open, and Repair all reconnects it at the playhead", async () => {
    const b = new Builder();
    const V = b.place("vdc", "V1", 0, 10, { value: "9" });
    const D = b.place("led", "D1", 20, 10, { color: "red" });
    const G = b.place("ground", "#PWR1", 40, 10);
    b.label("top", b.pin(V, "1")).label("top", b.pin(D, "A"));
    b.label("gnd", b.pin(D, "K")).label("gnd", b.pin(V, "2")).label("gnd", b.pin(G, "1"));
    b.project.simulation.tran = { stop: "100m", step: "100u" };
    useProject.getState().load(b.project);
    setSimEngine(engine());
    await useSim.getState().run("tran");
    usePlayback.getState().pause();
    await settle();
    let st = useSim.getState();
    const dmg = st.session!.damage[D.id];
    expect(dmg).toHaveLength(1);
    expect(dmg[0].t).toBeLessThan(1e-3);
    expect(validUntil(st.session!.log, st.resultSeq)).toBeNull();
    const i = (t: number) => interpolate(st.result!.x!.real, st.result!.vectors.find((v) => v.componentId === D.id && v.kind === "current")!.real, t);
    expect(Math.abs(i(0.05))).toBeLessThan(1e-6);

    usePlayback.getState().seek(0.05);
    useSim.getState().repairAll();
    await settle();
    st = useSim.getState();
    const list = st.session!.damage[D.id];
    expect(list[0].repairedAt).toBeCloseTo(0.05, 9);
    expect(list).toHaveLength(2); // fails again right after the repair: nothing limits the current
    expect(list[1].t).toBeGreaterThan(0.05);
    expect(list[1].t).toBeLessThan(0.052);
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
