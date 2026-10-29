// Engine-agnostic simulation run used by the store (Web Worker engine) and tests (Node engine).
// Wraps core `simulate()` with probe current saves and records the netlist that really ran.
import { getPart } from "../core/library";
import { generateNetlist, type NetlistOptions } from "../core/netlist";
import { simulate, type SpiceEngine } from "../core/simulate";
import type { AnalysisKind, Project, SimResult } from "../core/types";
import { currentSaveFor, mapDeviceCurrents, planCurrentSaves, SavingEngine } from "./probes";

/**
 * Run one analysis. `opts.schedules` (live mode) is passed to both netlist passes so element names match.
 * Indicator parts (LEDs) get their current saved automatically except in AC, where ngspice-WASM can't
 * write device currents.
 */
export async function runSimulation(project: Project, engine: SpiceEngine, analysis: AnalysisKind = project.simulation.analysis, opts: NetlistOptions = {}): Promise<SimResult> {
  const nl = generateNetlist(project, analysis, getPart, opts);
  const plan = planCurrentSaves(project, nl, analysis);
  if (analysis !== "ac") {
    for (const c of project.schematic.components) {
      if (!getPart(c.type)?.indicator) continue;
      const save = currentSaveFor(c.id, nl)?.save;
      if (save) plan.saves.push(save);
    }
  }
  const saving = new SavingEngine(engine, plan.saves);
  const result = await simulate(project, saving, analysis, getPart, opts);
  // When the engine ran, show the text it really received (with our .save line).
  if (saving.lastNetlist) result.netlist = saving.lastNetlist;
  mapDeviceCurrents(result, nl);
  result.diagnostics = [...result.diagnostics, ...plan.diagnostics];
  // ngspice-WASM can hand back the previous run's plot when an analysis fails to write output.
  // Never show data whose sweep variable doesn't match the analysis we asked for.
  const want = analysis === "tran" ? "time" : analysis === "ac" ? "frequency" : undefined;
  if (result.ok && (result.x?.kind !== want || (want && !result.x?.real.length))) {
    result.ok = false;
    result.vectors = [];
    result.x = undefined;
    result.diagnostics.push({ severity: "error", code: "spice-wrong-plot", source: "spice",
      message: `ngspice returned data that does not belong to the ${analysis.toUpperCase()} analysis that was requested, so it is not shown.`,
      fix: "Press Reset to restart the engine, then run again. If it repeats, check the simulation log and report the netlist." });
  }
  return result;
}
