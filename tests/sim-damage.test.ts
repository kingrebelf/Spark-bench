import { describe, expect, it } from "vitest";
import { Builder, engine } from "./helpers";
import { runSimulation } from "../src/sim/run";
import { interpolate } from "../src/scope/measure";
import { detectFailure, ema, firstExceed, stressTracks, STRESS_TAU, type Damage } from "../src/sim/stress";
import type { SimResult } from "../src/core/types";

/** A source straight across a part (V1 + -> part -> gnd), joined by labels. */
function across(type: string, props: Record<string, string>, volts: string, pins: [string, string] = ["1", "2"]) {
  const b = new Builder();
  const V = b.place("vdc", "V1", 0, 10, { value: volts });
  const P = b.place(type, "X1", 20, 10, props);
  const G = b.place("ground", "#PWR1", 40, 10);
  b.label("top", b.pin(V, "1")).label("top", b.pin(P, pins[0]));
  b.label("gnd", b.pin(P, pins[1])).label("gnd", b.pin(V, "2")).label("gnd", b.pin(G, "1"));
  b.project.simulation.tran = { stop: "2", step: "1m" };
  return { b, P };
}
const cur = (r: SimResult, id: string, t: number) => interpolate(r.x!.real, r.vectors.find((v) => v.kind === "current" && v.componentId === id)!.real, t);

describe("damage averaging rule", () => {
  const x = Array.from({ length: 2001 }, (_, i) => i * 1e-3); // 0..2 s, 1 ms grid
  it("a short spike survives, a sustained overload fails", () => {
    const tau = STRESS_TAU.power; // 0.5 s
    const spike = x.map((t) => (t >= 0.5 && t < 0.52 ? 4 : 0.1)); // 4 W for 20 ms on a 1 W part
    expect(firstExceed(x, ema(x, spike, tau), 1)).toBeNull();
    const sustained = x.map((t) => (t >= 0.5 ? 1.44 : 0.1)); // 1.44 W from 0.5 s
    const tf = firstExceed(x, ema(x, sustained, tau), 1)!;
    // y(t) = 1.44 (1 - e^{-(t-0.5)/τ}) crosses 1 at 0.5 + τ ln(1.44/0.44) ≈ 1.093 s (from a ~0.1 start a bit earlier)
    expect(tf).toBeGreaterThan(0.95);
    expect(tf).toBeLessThan(1.1);
  });
  it("a repair resets the average", () => {
    const v = x.map(() => 2);
    const a = ema(x, v, 0.1, [1]);
    expect(a[999]).toBeGreaterThan(1.9);
    expect(a[1000]).toBe(0);
  });
});

describe("burnout in a transient run", () => {
  it("an LED straight on 9 V fails within milliseconds; re-simulated as an open circuit after that", async () => {
    const { b, P } = across("led", { color: "red" }, "9", ["A", "K"]);
    b.project.simulation.tran = { stop: "100m", step: "100u" };
    const r = await runSimulation(b.project, engine(), "tran");
    expect(r.ok).toBe(true);
    expect(cur(r, P.id, 0.05)).toBeGreaterThan(0.3); // ~0.9 A through 8 Ω Rs: way over 30 mA
    const f = detectFailure(b.project, r, {})!;
    expect(f.componentId).toBe(P.id);
    expect(f.t).toBeLessThan(1e-3);
    expect(f.damage.message).toMatch(/X1 carried \d+(\.\d+)? m?A \(max 30 mA\) and failed at/);
    expect(f.damage.fix).toMatch(/series resistor/);
    const damage: Record<string, Damage[]> = { [P.id]: [f.damage] };
    const r2 = await runSimulation(b.project, engine(), "tran", { damage });
    expect(r2.ok, JSON.stringify(r2.diagnostics)).toBe(true);
    expect(r2.netlist).toMatch(/^Ssbf_X1 top sbf_X1 sbfc_X1 0 SBF_SW$/m);
    expect(Math.abs(cur(r2, P.id, 0.05))).toBeLessThan(1e-6);
    expect(detectFailure(b.project, r2, damage)).toBeNull(); // no new failure once it is open
    // and a repair at 60 ms reconnects it (it fails again right after, since nothing changed)
    const repaired = { [P.id]: [{ ...f.damage, repairedAt: 0.06 }] };
    const r3 = await runSimulation(b.project, engine(), "tran", { damage: repaired });
    expect(cur(r3, P.id, 0.065)).toBeGreaterThan(0.3);
    const again = detectFailure(b.project, r3, repaired)!;
    expect(again.t).toBeGreaterThan(0.06);
    expect(again.t).toBeLessThan(0.062);
  }, 60_000);

  it("100 Ω on 12 V (1.44 W) burns a ¼ W resistor after a fraction of a second; 1 kΩ (0.144 W) survives", async () => {
    const hot = across("resistor", { value: "100" }, "12");
    const r = await runSimulation(hot.b.project, engine(), "tran");
    const f = detectFailure(hot.b.project, r, {})!;
    expect(f.t).toBeGreaterThan(0.05);
    expect(f.t).toBeLessThan(0.15); // 0.5 s · ln(1.44 / 1.19) ≈ 0.096 s
    expect(f.damage.message).toMatch(/X1 dissipated 1\.44 W \(rated 250 mW\)/);
    expect(f.damage.fix).toMatch(/≥ 3 W resistor, or at least 860 Ω/);
    const tr = stressTracks(hot.b.project, r)[0];
    expect(tr.avg[tr.avg.length - 1]).toBeCloseTo(1.44 * (1 - Math.exp(-2 / 0.5)), 3);
    const cool = across("resistor", { value: "1k" }, "12");
    expect(detectFailure(cool.b.project, await runSimulation(cool.b.project, engine(), "tran"), {})).toBeNull();
    // a 2 W rating survives the 1.44 W
    const rated = across("resistor", { value: "100", power: "2" }, "12");
    expect(detectFailure(rated.b.project, await runSimulation(rated.b.project, engine(), "tran"), {})).toBeNull();
  }, 60_000);

  it("an electrolytic wired backwards beyond its reverse limit fails; the right way round it is fine", async () => {
    const back = across("capacitor_polarized", { value: "10u" }, "5", ["2", "1"]);
    const f = detectFailure(back.b.project, await runSimulation(back.b.project, engine(), "tran"), {});
    expect(f?.damage.message).toMatch(/reverse limit 1 V/);
    const fwd = across("capacitor_polarized", { value: "10u" }, "5");
    expect(detectFailure(fwd.b.project, await runSimulation(fwd.b.project, engine(), "tran"), {})).toBeNull();
  }, 60_000);

  it("op results give static stress ratios (no averaging, no failure modeling)", async () => {
    const hot = across("resistor", { value: "100" }, "12");
    const r = await runSimulation(hot.b.project, engine(), "op");
    const tr = stressTracks(hot.b.project, r)[0];
    expect(tr.ratio[0]).toBeCloseTo(1.44 / 0.25, 2);
    expect(detectFailure(hot.b.project, r, {})).toBeNull();
  }, 60_000);
});
