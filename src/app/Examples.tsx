// Examples menu. Example projects are bundled at build time so they work in the browser and the packaged app.
import { useEffect, useRef, useState } from "react";
import { useProject } from "../core/store";
import { useEditor } from "../editor/store";
import { openProjectText } from "./fileActions";

const files = import.meta.glob("../../examples/*.sbproj", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

interface Example { file: string; name: string; description: string; text: string }

const EXAMPLES: Example[] = Object.entries(files).map(([path, text]) => {
  let name = path.split("/").pop()!.replace(/\.sbproj$/, ""), description = "";
  try { const p = JSON.parse(text); name = p.meta?.name ?? name; description = p.meta?.description ?? ""; } catch { /* listed by file name */ }
  return { file: path, name, description, text };
}).sort((a, b) => a.name.localeCompare(b.name));

export function ExamplesMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (!EXAMPLES.length) return null;

  const load = async (ex: Example) => {
    setOpen(false);
    if (useProject.getState().dirty && !window.confirm("You have unsaved changes. Discard them and open this example?")) return;
    if (await openProjectText(ex.text, null)) useEditor.getState().requestFit();
  };

  return (
    <div className="menu" ref={ref}>
      <button className={`btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Open an example circuit">Examples ▾</button>
      {open && (
        <div className="menu-list" role="menu">
          {EXAMPLES.map((ex) => (
            <button key={ex.file} role="menuitem" className="menu-item" onClick={() => load(ex)}>
              <b>{ex.name}</b>{ex.description && <small>{ex.description}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
