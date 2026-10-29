import { create } from "zustand";

export type Tool = "select" | "wire" | "label" | { place: string };

export const useEditor = create<{ tool: Tool; setTool: (t: Tool) => void }>((set) => ({
  tool: "select",
  setTool: (tool) => set({ tool }),
}));
