import { create } from "zustand";
import { simulate } from "../core/simulate";
import { useProject } from "../core/store";
import type { AnalysisKind, SimResult } from "../core/types";
import { workerEngine } from "./workerEngine";

export type SimStatus = "idle" | "running" | "done" | "failed" | "stopped";

interface SimState {
  status: SimStatus;
  result: SimResult | null;
  /** Project revision (history length) the result was computed from; results go stale after edits. */
  resultRevision: number | null;
  run: (analysis?: AnalysisKind) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

const revision = () => useProject.getState().past.length + useProject.getState().future.length * 1e6;

export const useSim = create<SimState>((set) => ({
  status: "idle",
  result: null,
  resultRevision: null,
  run: async (analysis) => {
    const project = useProject.getState().project;
    const rev = revision();
    set({ status: "running" });
    const result = await simulate(project, workerEngine, analysis ?? project.simulation.analysis);
    if (result.diagnostics.some((d) => d.code === "engine-crash" && /stopped by user/.test(d.message))) {
      set({ status: "stopped", result: null, resultRevision: null });
      return;
    }
    set({ status: result.ok ? "done" : "failed", result, resultRevision: rev });
  },
  stop: () => { workerEngine.stop(); set({ status: "stopped" }); },
  reset: () => set({ status: "idle", result: null, resultRevision: null }),
}));

/** True when the schematic changed after the shown result was computed. */
export const useResultStale = () => {
  const rr = useSim((s) => s.resultRevision);
  const past = useProject((s) => s.past.length);
  const fut = useProject((s) => s.future.length);
  return rr !== null && rr !== past + fut * 1e6;
};
