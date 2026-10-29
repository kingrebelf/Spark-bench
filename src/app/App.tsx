import { useEffect, useState } from "react";
import { useProject } from "../core/store";
import { Canvas } from "../editor/Canvas";
import { LibraryPanel } from "../editor/LibraryPanel";
import { PropertiesPanel } from "../editor/PropertiesPanel";
import { useEditor } from "../editor/store";
import { SimPanel } from "../sim/SimPanel";
import { checkRecovery, newProject, openProject, saveProject, startRecoveryAutosave } from "./fileActions";
import { useApp } from "./store";

// Right-side panels. Feature modules add entries here (e.g. AI assistant, KiCad).
const RIGHT_PANELS: { id: string; label: string; render: () => React.ReactNode }[] = [
  { id: "properties", label: "Properties", render: () => <PropertiesPanel /> },
];

export function App() {
  const { project, dirty, filePath, undo, redo, past, future } = useProject();
  const { tool, setTool } = useEditor();
  const { projectDiagnostics, setProjectDiagnostics, rightPanel, setRightPanel } = useApp();
  const [recovery, setRecovery] = useState<Awaited<ReturnType<typeof checkRecovery>>>(null);

  useEffect(() => {
    checkRecovery().then(setRecovery);
    return startRecoveryAutosave();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); saveProject(e.shiftKey); }
      else if (k === "o") { e.preventDefault(); openProject(); }
      else if (k === "n") { e.preventDefault(); newProject(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { document.title = `${dirty ? "• " : ""}${project.meta.name} · SparkBench`; }, [dirty, project.meta.name]);

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">⚡ SparkBench</span>
        <button className="btn" onClick={newProject} title="New project (Ctrl+N)">New</button>
        <button className="btn" onClick={openProject} title="Open project (Ctrl+O)">Open</button>
        <button className="btn" onClick={() => saveProject()} title="Save (Ctrl+S)">Save</button>
        <button className="btn" onClick={() => saveProject(true)} title="Save as (Ctrl+Shift+S)">Save as</button>
        <span className="sep" />
        <button className="btn" onClick={undo} disabled={!past.length} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button className="btn" onClick={redo} disabled={!future.length} title="Redo (Ctrl+Y)">↷ Redo</button>
        <span className="sep" />
        <button className={`btn ${tool === "select" ? "on" : ""}`} onClick={() => setTool("select")} title="Select (Esc)">Select</button>
        <button className={`btn ${tool === "wire" ? "on" : ""}`} onClick={() => setTool("wire")} title="Wire (W)">Wire</button>
        <button className={`btn ${tool === "label" ? "on" : ""}`} onClick={() => setTool("label")} title="Net label">Label</button>
        <span className="grow" />
        <span className="filename" title={filePath ?? "Not saved yet"}>{project.meta.name}{dirty ? " •" : ""}</span>
      </header>

      {recovery && (
        <div className="banner">
          Unsaved work from {new Date(recovery.modified).toLocaleString()} was found.
          <button className="btn primary" onClick={async () => { await recovery.restore(); setRecovery(null); }}>Restore</button>
          <button className="btn" onClick={async () => { await recovery.discard(); setRecovery(null); }}>Discard</button>
        </div>
      )}
      {projectDiagnostics.length > 0 && (
        <div className="banner">
          {projectDiagnostics.map((d, i) => <div key={i} className={`diag diag-${d.severity}`}>{d.message}{d.fix ? ` ${d.fix}` : ""}</div>)}
          <button className="btn" onClick={() => setProjectDiagnostics([])}>Dismiss</button>
        </div>
      )}

      <main className="workspace">
        <LibraryPanel />
        <div className="center">
          <Canvas />
          <SimPanel />
        </div>
        <div className="right">
          {RIGHT_PANELS.length > 1 && (
            <nav className="tabs">{RIGHT_PANELS.map((p) => <button key={p.id} className={rightPanel === p.id ? "on" : ""} onClick={() => setRightPanel(p.id)}>{p.label}</button>)}</nav>
          )}
          {(RIGHT_PANELS.find((p) => p.id === rightPanel) ?? RIGHT_PANELS[0]).render()}
        </div>
      </main>
    </div>
  );
}
