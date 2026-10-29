import { describe, expect, it } from "vitest";
import { Builder, engine } from "./helpers";
import { generateNetlist } from "../src/core/netlist";
import { runSimulation } from "../src/sim/run";
import { interpolate } from "../src/scope/measure";
import { displayLimit, livePlan, recordChange, toPwl, validUntil, valueAt, niceRate, defaultRate } from "../src/sim/live";
import type { Project, SimResult } from "../src/core/types";

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
    expect(op.netlist).toMatch(/\.save all @d1\[id\]/i);
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
    expect(still.stop / still.step).toBeLessThanOrEqual(100_000);
    const khz = livePlan(proj([{ f: "1k" }]));
    expect(khz.rate).toBe(1e-3);
    expect(khz.step).toBeLessThanOrEqual(1 / (1000 * 50));
    expect(khz.cap).toBeGreaterThan(khz.stop);
    expect(niceRate(0.003)).toBe(0.002);
    expect(defaultRate(5)).toBe(1);
    expect(defaultRate(0.02)).toBe(0.002);
  });
});
