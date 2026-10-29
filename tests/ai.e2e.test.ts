import { describe, expect, it } from "vitest";
import { engine, divider } from "./helpers";
import { createProject } from "../src/core/project";
import { checkProposal, parseAiResponse, type Proposal } from "../src/ai/proposal";
import { layoutProposal } from "../src/ai/layout";
import { computeDiff } from "../src/ai/diff";
import { checkDesign, runSuggestedSimulation, stageOf } from "../src/ai/validate";
import { dividerWithDiode, rcLowPass, reply } from "./aiFixtures";

async function pipeline(text: string, base = createProject()) {
  const parsed = parseAiResponse(text);
  expect(parsed.diagnostics).toEqual([]);
  const p = parsed.response!.proposal!;
  const c = checkProposal(p, base);
  expect(c.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const lay = layoutProposal(base, p, c.nets);
  expect(lay.ok).toBe(true);
  const checks = checkDesign(lay.project);
  const sims = [];
  for (const s of p.simulations) sims.push(await runSuggestedSimulation(lay.project, s, lay.netNames, engine()));
  return { p, lay, checks, sims, stage: stageOf(checks.ok, sims) };
}

describe("end to end: canned model reply -> placed circuit -> checks -> ngspice", () => {
  it("RC low-pass: corner frequency and passband gain match the AI's expectation", async () => {
    const r = await pipeline(JSON.stringify(reply(rcLowPass)));
    expect(r.checks.ok).toBe(true);
    const s = r.sims[0];
    expect(s.result.ok).toBe(true);
    const f3 = s.expectations[0];
    expect(f3.measured!).toBeGreaterThan(1500);
    expect(f3.measured!).toBeLessThan(1700); // 1/(2π·1k·100n) = 1591.5 Hz
    expect(s.expectations.every((e) => e.pass)).toBe(true);
    expect(r.stage).toBe("sim-match");
  }, 60_000);

  it("divider with diode clamp: operating point matches", async () => {
    const r = await pipeline(JSON.stringify(reply(dividerWithDiode)));
    expect(r.sims[0].expectations[0].pass).toBe(true);
    expect(r.stage).toBe("sim-match");
  }, 60_000);

  it("a wrong AI expectation is reported as a mismatch with the measured value", async () => {
    const bad: Proposal = structuredClone(rcLowPass);
    bad.simulations[0].expectations[0].min = 10_000; bad.simulations[0].expectations[0].max = 20_000;
    const r = await pipeline(JSON.stringify(reply(bad)));
    expect(r.sims[0].expectations[0].pass).toBe(false);
    expect(r.sims[0].expectations[0].measured).toBeCloseTo(1591, -1);
    expect(r.stage).toBe("sim-mismatch");
  }, 60_000);

  it("an expectation on a net the proposal doesn't have cannot be measured (no fake pass)", async () => {
    const bad: Proposal = structuredClone(dividerWithDiode);
    bad.simulations[0].expectations[0].net = "NOPE";
    const r = await pipeline(JSON.stringify(reply(bad)));
    expect(r.sims[0].expectations[0].pass).toBeNull();
    expect(r.stage).toBe("sim-mismatch");
  }, 60_000);

  it("a design that fails checks is labelled so and not simulated as valid", async () => {
    const bad: Proposal = structuredClone(dividerWithDiode);
    // Leave D1.K out of every net: the clamp diode floats.
    bad.nets[2].pins = bad.nets[2].pins.filter((p) => p !== "D1.K");
    const c = checkProposal(bad, createProject());
    const lay = layoutProposal(createProject(), bad, c.nets);
    const checks = checkDesign(lay.project);
    expect(checks.ok).toBe(false);
    expect(stageOf(checks.ok, [])).toBe("checks-failed");
  });
});

describe("diff", () => {
  it("new circuit: everything is added", () => {
    const base = createProject();
    const c = checkProposal(rcLowPass, base);
    const lay = layoutProposal(base, rcLowPass, c.nets);
    const d = computeDiff(base, lay.project);
    expect(d.parts.map((p) => `${p.kind}:${p.ref}`).sort()).toEqual(["added:C1", "added:R1", "added:V1"]);
    expect(d.nets.every((n) => n.kind === "added")).toBe(true);
    expect(d.nets).toHaveLength(3);
  });

  it("edit: value change, added part, and a pin that silently leaves its net is flagged", () => {
    const { b } = divider();
    const base = b.project;
    const proposal: Proposal = {
      ...structuredClone(dividerWithDiode),
      parts: [
        { ...dividerWithDiode.parts[0], values: [] },
        { ...dividerWithDiode.parts[1], values: [] },
        { ...dividerWithDiode.parts[2], values: [{ key: "value", value: "2k" }] },
        dividerWithDiode.parts[3],
      ],
      // The model "forgot" R2.1 in the midpoint net.
      nets: [
        { name: "VIN", ground: false, pins: ["V1.1", "R1.1"] },
        { name: "MID", ground: false, pins: ["R1.2", "D1.A"] },
        { name: "GND", ground: true, pins: ["V1.2", "R2.2", "D1.K"] },
      ],
    };
    const c = checkProposal(proposal, base);
    expect(c.diagnostics.some((x) => x.code === "ai-unconnected-pin" && x.message.includes("R2"))).toBe(true);
    const lay = layoutProposal(base, proposal, c.nets);
    expect(lay.ok).toBe(true);
    const names = new Map([...lay.netNames].map(([k, v]) => [v, k]));
    const d = computeDiff(base, lay.project, undefined, names);
    expect(d.parts.find((p) => p.ref === "R2")).toMatchObject({ kind: "changed", props: [{ key: "value", from: "1k", to: "2k" }] });
    expect(d.parts.find((p) => p.ref === "D1")?.kind).toBe("added");
    expect(d.pinMoves).toContainEqual(expect.objectContaining({ pin: "R2.1", kind: "disconnected" }));
    const mid = d.nets.find((n) => n.name === "MID")!;
    expect(mid.joined).toContain("D1.A");
    expect(mid.left).toContain("R2.1");
  });

  it("no-op proposal (e.g. suggested tests only) yields an empty diff", () => {
    const { b } = divider();
    const proposal: Proposal = {
      ...structuredClone(rcLowPass),
      parts: [
        { ...rcLowPass.parts[1], ref: "V1", type: "vdc", values: [] },
        { ...rcLowPass.parts[1], ref: "R1", values: [] },
        { ...rcLowPass.parts[1], ref: "R2", values: [] },
      ],
      nets: [
        { name: "VIN", ground: false, pins: ["V1.1", "R1.1"] },
        { name: "out", ground: false, pins: ["R1.2", "R2.1"] },
        { name: "GND", ground: true, pins: ["V1.2", "R2.2"] },
      ],
    };
    const c = checkProposal(proposal, b.project);
    const lay = layoutProposal(b.project, proposal, c.nets);
    const d = computeDiff(b.project, lay.project);
    expect(d.empty).toBe(true);
    expect(lay.project.schematic.wires.length).toBe(b.project.schematic.wires.length);
  });
});
