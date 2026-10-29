// Every failure path ends in ok:false with no data, never a plot.
import { describe, expect, it } from "vitest";
import { divider } from "./helpers";
import { runSimulation } from "../src/sim/run";
import type { EngineOutput, SpiceEngine } from "../src/core/simulate";

const fake = (run: (netlist: string) => Promise<EngineOutput>): SpiceEngine => ({ run });
const expectNoData = (r: Awaited<ReturnType<typeof runSimulation>>, code: string) => {
  expect(r.ok).toBe(false);
  expect(r.vectors).toEqual([]);
  expect(r.x).toBeUndefined();
  expect(r.diagnostics.some((d) => d.code === code && d.severity === "error")).toBe(true);
};

describe("failure paths", () => {
  it("engine crash", async () => {
    const r = await runSimulation(divider().b.project, fake(() => Promise.reject(new Error("worker died"))), "op");
    expectNoData(r, "engine-crash");
  });

  it("stop (worker terminated) is an engine-crash result the store discards", async () => {
    const r = await runSimulation(divider().b.project, fake(() => Promise.reject(new Error("Simulation stopped by user"))), "tran");
    expectNoData(r, "engine-crash");
  });

  it("no data", async () => {
    const r = await runSimulation(divider().b.project, fake(async () => ({ dataType: "real", variableNames: [], data: [], numPoints: 0, messages: [] })), "op");
    expectNoData(r, "spice-no-data");
  });

  it("convergence failure", async () => {
    const r = await runSimulation(divider().b.project, fake(async () => ({ dataType: "real", variableNames: ["time", "v(out)"], numPoints: 1,
      data: [{ name: "time", type: "time", values: [0] }, { name: "v(out)", type: "voltage", values: [0] }], messages: ["doAnalyses: TRAN:  Timestep too small; time = 1e-9"] })), "tran");
    expectNoData(r, "spice-timestep");
  });

  it("a previous run's plot returned for an AC request is refused", async () => {
    const { b } = divider("10", "1k", "1k");
    b.project.schematic.components[0].props.acmag = "1";
    const r = await runSimulation(b.project, fake(async () => ({ dataType: "real", variableNames: ["time", "v(out)"], numPoints: 2,
      data: [{ name: "time", type: "time", values: [0, 1] }, { name: "v(out)", type: "voltage", values: [5, 5] }], messages: [] })), "ac");
    expectNoData(r, "spice-wrong-plot");
  });
});
