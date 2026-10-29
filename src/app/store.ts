import { create } from "zustand";
import type { Diagnostic } from "../core/types";

/** App-level UI state: project-open diagnostics and which side panel is shown. */
interface AppState {
  projectDiagnostics: Diagnostic[];
  setProjectDiagnostics: (d: Diagnostic[]) => void;
  rightPanel: string;
  setRightPanel: (p: string) => void;
}

export const useApp = create<AppState>((set) => ({
  projectDiagnostics: [],
  setProjectDiagnostics: (projectDiagnostics) => set({ projectDiagnostics }),
  rightPanel: "properties",
  setRightPanel: (rightPanel) => set({ rightPanel }),
}));
