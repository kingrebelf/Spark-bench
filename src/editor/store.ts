// Editor UI state (not part of the project file): active tool, view, placement ghost,
// clipboard, recent parts. Fast-changing pointer state lives in `usePointer` so that
// mouse moves only re-render the overlay, not the whole scene.
import { create } from "zustand";
import type { Point, Rotation } from "../core/types";
import type { Clip } from "./ops";

export type Tool = "select" | "wire" | "label" | { place: string };

export interface View { x: number; y: number; zoom: number }

const RECENT_KEY = "sparkbench.editor.recent";
const loadRecent = (): string[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").filter((x: unknown) => typeof x === "string").slice(0, 6); }
  catch { return []; }
};

interface EditorState {
  tool: Tool;
  setTool: (t: Tool) => void;
  /** Rotation / mirror applied to the next placed part (R / X while placing). */
  placeRotation: Rotation;
  placeMirror: boolean;
  rotatePlacement: () => void;
  mirrorPlacement: () => void;
  view: View;
  setView: (v: View | ((v: View) => View)) => void;
  /** Bumped to ask the canvas to zoom to fit. */
  fitToken: number;
  requestFit: () => void;
  clipboard: Clip | null;
  setClipboard: (c: Clip | null) => void;
  recent: string[];
  noteRecent: (partId: string) => void;
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  tool: "select",
  setTool: (tool) => set(typeof tool === "object" && typeof get().tool === "object" && (get().tool as { place: string }).place === tool.place
    ? { tool } : { tool, placeRotation: 0, placeMirror: false }),
  placeRotation: 0,
  placeMirror: false,
  rotatePlacement: () => set((s) => ({ placeRotation: ((s.placeRotation + 90) % 360) as Rotation })),
  mirrorPlacement: () => set((s) => ({ placeMirror: !s.placeMirror })),
  view: { x: -30, y: -20, zoom: 1.4 },
  setView: (v) => set((s) => ({ view: typeof v === "function" ? v(s.view) : v })),
  fitToken: 0,
  requestFit: () => set((s) => ({ fitToken: s.fitToken + 1 })),
  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard }),
  recent: loadRecent(),
  noteRecent: (id) => {
    const recent = [id, ...get().recent.filter((x) => x !== id)].slice(0, 6);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* storage unavailable: keep in memory */ }
    set({ recent });
  },
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
}));

export type Hover =
  | { kind: "pin"; id: string; pinId: string }
  | { kind: "wire"; id: string }
  | { kind: "component"; id: string }
  | { kind: "label"; id: string };

interface PointerState {
  /** Snapped cursor in grid units; null when the pointer is outside the canvas. */
  cursor: Point | null;
  hover: Hover | null;
  /** In-progress wire vertices (wire tool). */
  wire: Point[];
  /** Route the next wire leg horizontally first. */
  horizontalFirst: boolean;
  /** Marquee rectangle corners in grid units (unsnapped). */
  marquee: { a: Point; b: Point } | null;
  /** Part being dragged in from the library (HTML drag and drop). */
  dropPart: string | null;
  set: (p: Partial<Omit<PointerState, "set">>) => void;
}

export const usePointer = create<PointerState>((set) => ({
  cursor: null,
  hover: null,
  wire: [],
  horizontalFirst: true,
  marquee: null,
  dropPart: null,
  set: (p) => set(p),
}));

/** MIME type used when dragging a part from the library onto the canvas. */
export const PART_MIME = "application/x-sparkbench-part";
