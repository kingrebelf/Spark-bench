// Project store with undo/redo (immer patches). All edits go through `update`
// so every module (editor, AI apply, KiCad import) gets undo for free.
import { create } from "zustand";
import { applyPatches, enablePatches, produceWithPatches, type Patch } from "immer";
import { createProject } from "./project";
import type { Project } from "./types";

enablePatches();

interface HistoryEntry { label: string; patches: Patch[]; inverse: Patch[] }

export interface ProjectState {
  project: Project;
  filePath: string | null;
  dirty: boolean;
  selection: string[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Apply an undoable edit. `merge` folds into the previous entry with the same label (e.g. dragging). */
  update: (label: string, recipe: (draft: Project) => void, opts?: { merge?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  setSelection: (ids: string[]) => void;
  /** Replace the whole project (open/new/import). Clears history. */
  load: (project: Project, filePath?: string | null) => void;
  markSaved: (filePath: string) => void;
}

const MAX_HISTORY = 200;

export const useProject = create<ProjectState>((set, get) => ({
  project: createProject(),
  filePath: null,
  dirty: false,
  selection: [],
  past: [],
  future: [],
  update: (label, recipe, opts) => {
    const [next, patches, inverse] = produceWithPatches(get().project, recipe);
    if (!patches.length) return;
    const past = [...get().past];
    const last = past[past.length - 1];
    if (opts?.merge && last?.label === label) {
      past[past.length - 1] = { label, patches: [...last.patches, ...patches], inverse: [...inverse, ...last.inverse] };
    } else {
      past.push({ label, patches, inverse });
      if (past.length > MAX_HISTORY) past.shift();
    }
    set({ project: next, past, future: [], dirty: true });
  },
  undo: () => {
    const past = [...get().past];
    const e = past.pop();
    if (!e) return;
    set({ project: applyPatches(get().project, e.inverse), past, future: [e, ...get().future], dirty: true });
  },
  redo: () => {
    const [e, ...future] = get().future;
    if (!e) return;
    set({ project: applyPatches(get().project, e.patches), past: [...get().past, e], future, dirty: true });
  },
  setSelection: (ids) => set({ selection: ids }),
  load: (project, filePath = null) => set({ project, filePath, dirty: false, selection: [], past: [], future: [] }),
  markSaved: (filePath) => set({ filePath, dirty: false }),
}));
