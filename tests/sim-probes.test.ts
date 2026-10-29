import { describe, expect, it } from "vitest";
import { Builder, divider, engine } from "./helpers";
import { runSimulation } from "../src/sim/run";
import { addSaves, resolveProbes, vectorForProbe } from "../src/sim/probes";
import type { Project } from "../src/core/types";

const addProbe = (p: Project, probe: Project["simulation"]["probes"][number]) => { p.simulation.probes.push(probe); };

function rc(acmag = "1") {
  const b = new Builder();
  const V = b.place("vsine", "V1", 0, 10, { amplitude: "1", frequency: "1k", acmag });
  const R = b.place("resistor", "R1", 10, 3, { value: "1k" });
  const C = b.place("capacitor", "C1", 10, 13, { value: "100n" });
  const G = b.place("ground", "#PWR1", 0, 20);
  b.connect(b.pin(V, "1"), b.pin(R, "1")); b.wire(b.pin(R, "2"), b.pin(C, "1"));
  b.label("vc", b.pin(C, "1"));
  b.connect(b.pin(C, "2"), b.pin(G, "1")); b.wire(b.pin(V, "2"), b.pin(G, "1"));
  return { b, V, R, C };
}

describe("probe mapping", () => {
  it("adds .save all before the analysis card", () => {
    const t = addSaves("* x\nR1 a 0 1k\n.op\n.end\n", ["@r1[i]", "@r1[i]"]);
    expect(t).toBe("* x\nR1 a 0 1k\n.save all @r1[i]\n.op\n.end\n");
    expect(addSaves("a\n.end", [])).toBe("a\n.end");
  });

  it("op: resistor current probe returns I = V/R and keeps node voltages", async () => {
    const { b, R1 } = divider();
    addProbe(b.project, { id: "p1", kind: "current", target: { componentId: R1.id }, label: "I(R1)" });
    addProbe(b.project, { id: "p2", kind: "voltage", target: { point: b.pin(R1, "2") }, label: "out" });
    const r = await runSimulation(b.project, engine(), "op");
    expect(r.ok).toBe(true);
    expect(r.netlist).toMatch(/\.save all @r1\[i\]/i);
    const [pi, pv] = resolveProbes(b.project);
    expect(vectorForProbe(pi, r)!.real[0]).toBeCloseTo(0.005, 6);
    expect(pv.netName).toBe("out");
    expect(vectorForProbe(pv, r)!.real[0]).toBeCloseTo(5, 6);
  }, 60_000);

  it("tran: capacitor current probe is reported over time", async () => {
    const { b, C } = rc();
    b.project.simulation.tran = { stop: "2m", step: "10u" };
    addProbe(b.project, { id: "p1", kind: "current", target: { componentId: C.id }, label: "I(C1)" });
    const r = await runSimulation(b.project, engine(), "tran");
    expect(r.ok).toBe(true);
    const v = vectorForProbe(resolveProbes(b.project)[0], r)!;
    expect(v.real.length).toBe(r.x!.real.length);
    expect(Math.max(...v.real.map(Math.abs))).toBeGreaterThan(1e-5);
  }, 60_000);

  it("ac: device currents are refused with a diagnostic, source currents still work", async () => {
    const { b, R, V } = rc();
    b.project.simulation.ac = { sweep: "dec", points: 5, start: "10", stop: "100k" };
    addProbe(b.project, { id: "p1", kind: "current", target: { componentId: R.id }, label: "I(R1)" });
    addProbe(b.project, { id: "p2", kind: "current", target: { componentId: V.id }, label: "I(V1)" });
    const r = await runSimulation(b.project, engine(), "ac");
    expect(r.ok).toBe(true);
    expect(r.netlist).not.toMatch(/\.save/);
    expect(r.diagnostics.find((d) => d.code === "probe-current-ac")?.componentIds).toEqual([R.id]);
    const [pr, pv] = resolveProbes(b.project);
    expect(vectorForProbe(pr, r)).toBeUndefined();
    const iv = vectorForProbe(pv, r)!;
    // At high frequency the cap is a short: |I| -> 1 V / 1 kΩ.
    const n = iv.real.length - 1;
    expect(Math.hypot(iv.real[n], iv.imag![n])).toBeCloseTo(1e-3, 4);
  }, 60_000);

  it("flags a probe whose part was removed instead of showing a value", () => {
    const { b, R1 } = divider();
    addProbe(b.project, { id: "p1", kind: "current", target: { componentId: R1.id }, label: "I(R1)" });
    b.project.schematic.components = b.project.schematic.components.filter((c) => c.id !== R1.id);
    expect(resolveProbes(b.project)[0].problem).toMatch(/removed/);
  });
});
