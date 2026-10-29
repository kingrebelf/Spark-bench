// New / open / save / recovery. Works in Electron; in a plain browser falls back to download/upload.
import { host } from "../core/host";
import { partTypes } from "../core/library";
import { createProject, parseProject, serializeProject } from "../core/project";
import { useProject } from "../core/store";
import type { Diagnostic } from "../core/types";
import { useSim } from "../sim/store";
import { useApp } from "./store";

const fileName = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.sbproj$/i, "");

export async function newProject() {
  if (!(await confirmDiscard())) return;
  useProject.getState().load(createProject());
  useSim.getState().reset();
}

export async function openProjectText(text: string, path: string | null) {
  const { project, diagnostics } = parseProject(text, partTypes());
  useApp.getState().setProjectDiagnostics(diagnostics);
  if (!project) return false;
  useProject.getState().load(project, path);
  useSim.getState().reset();
  return true;
}

export async function openProject() {
  if (!(await confirmDiscard())) return;
  if (host.available) {
    const r = await host.invoke<{ path: string; text: string } | null>("sb:file:open");
    if (r) await openProjectText(r.text, r.path);
    return;
  }
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".sbproj,application/json";
  input.onchange = async () => { const f = input.files?.[0]; if (f) await openProjectText(await f.text(), null); };
  input.click();
}

export async function saveProject(saveAs = false) {
  const st = useProject.getState();
  const text = serializeProject(st.project);
  if (host.available) {
    const r = await host.invoke<{ path: string } | null>("sb:file:save", {
      path: saveAs ? null : st.filePath, text, defaultName: `${st.project.meta.name || "untitled"}.sbproj` });
    if (!r) return false;
    st.markSaved(r.path);
    const name = fileName(r.path);
    if (st.project.meta.name !== name) useProject.setState((s) => ({ project: { ...s.project, meta: { ...s.project.meta, name } } }));
    await host.invoke("sb:recovery:clear");
    return true;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = `${st.project.meta.name || "untitled"}.sbproj`;
  a.click();
  st.markSaved(a.download);
  return true;
}

async function confirmDiscard(): Promise<boolean> {
  if (!useProject.getState().dirty) return true;
  return window.confirm("You have unsaved changes. Discard them?");
}

/** Autosave to the recovery slot every few seconds while there are unsaved edits. */
export function startRecoveryAutosave(): () => void {
  if (!host.available) return () => {};
  let last = "";
  const t = setInterval(() => {
    const st = useProject.getState();
    if (!st.dirty) return;
    const text = serializeProject(st.project);
    if (text !== last) { last = text; host.invoke("sb:recovery:write", JSON.stringify({ filePath: st.filePath, project: text })).catch(() => {}); }
  }, 5000);
  return () => clearInterval(t);
}

export async function checkRecovery(): Promise<{ modified: string; restore: () => Promise<void>; discard: () => Promise<void> } | null> {
  if (!host.available) return null;
  const r = await host.invoke<{ text: string; modified: string } | null>("sb:recovery:read");
  if (!r) return null;
  let parsed: { filePath: string | null; project: string };
  try { parsed = JSON.parse(r.text); } catch { return null; }
  return {
    modified: r.modified,
    restore: async () => {
      await openProjectText(parsed.project, parsed.filePath);
      useProject.setState({ dirty: true });
      const d: Diagnostic = { severity: "info", code: "recovered", source: "project", message: "Recovered unsaved work from the last session. Save it to keep it." };
      useApp.getState().setProjectDiagnostics([d, ...useApp.getState().projectDiagnostics]);
    },
    discard: async () => { await host.invoke("sb:recovery:clear"); },
  };
}
