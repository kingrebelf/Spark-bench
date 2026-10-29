import { create } from "zustand";
import type { ExportRun, KicadStatus } from "./client";
import type { ImportReport } from "./importSch";
import type { MappingRow } from "./mapping";

/** KiCad panel state that survives switching side panels. */
interface KicadState {
  status: KicadStatus | null;
  rows: MappingRow[] | null;
  reviewedAt: number;
  folder: string;
  name: string;
  pcb: boolean;
  busy: string | null;
  error: string | null;
  lastExport: ExportRun | null;
  lastImport: (ImportReport & { path: string }) | null;
  set: (p: Partial<KicadState>) => void;
}

export const useKicad = create<KicadState>((set) => ({
  status: null, rows: null, reviewedAt: 0, folder: "", name: "", pcb: true, busy: null, error: null, lastExport: null, lastImport: null,
  set: (p) => set(p),
}));
