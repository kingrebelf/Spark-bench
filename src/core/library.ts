// Component registry. Part definitions live in src/library (owned by the library module);
// this file only stores and looks them up so core code never imports UI.
import type { ComponentDef } from "./types";

const registry = new Map<string, ComponentDef>();

export function registerParts(defs: ComponentDef[]): void {
  for (const d of defs) registry.set(d.id, d);
}
export function getPart(id: string): ComponentDef | undefined {
  return registry.get(id);
}
export function allParts(): ComponentDef[] {
  return [...registry.values()];
}
export function partTypes(): Set<string> {
  return new Set(registry.keys());
}
