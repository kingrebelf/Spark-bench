// Component library: search (ranked), collapsible categories, recently used, keyboard navigation,
// details for the focused part, click-to-place and drag-and-drop onto the canvas.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { allParts, getPart } from "../core/library";
import type { ComponentDef } from "../core/types";
import { SymbolPreview } from "./SymbolView";
import { PART_MIME, useEditor, usePointer } from "./store";

export const PROV_TEXT: Record<string, string> = {
  ideal: "Ideal element: exact within SPICE's ideal model.",
  generic: "Generic model with typical parameters, not a specific manufacturer part.",
  behavioral: "Behavioral macromodel: reproduces the function, not device physics.",
  vendor: "Manufacturer-supplied model.",
  none: "Schematic only: not simulated.",
};

/** Search score; 0 = no match. Name hits beat keyword hits beat description hits. */
export function partScore(p: ComponentDef, q: string): number {
  if (!q) return 1;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const t of terms) {
    const name = p.name.toLowerCase();
    let s = 0;
    if (name.startsWith(t)) s = 100;
    else if (name.split(/[\s(/-]+/).some((w) => w.startsWith(t))) s = 80;
    else if (name.includes(t)) s = 60;
    else if ((p.keywords ?? []).some((k) => k.toLowerCase().startsWith(t))) s = 50;
    else if (p.refPrefix.toLowerCase() === t || p.id.toLowerCase().includes(t)) s = 40;
    else if (p.category.toLowerCase().includes(t)) s = 30;
    else if ((p.keywords ?? []).some((k) => k.toLowerCase().includes(t))) s = 25;
    else if (p.description.toLowerCase().includes(t)) s = 10;
    if (!s) return 0;
    total += s;
  }
  return total;
}

const COLLAPSE_KEY = "sparkbench.library.collapsed";

export const LibraryPanel = memo(function LibraryPanel() {
  const [q, setQ] = useState("");
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const recent = useEditor((s) => s.recent);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]")); } catch { return new Set(); }
  });
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const parts = allParts();

  const sections = useMemo(() => {
    const s = q.trim();
    if (s) {
      const hits = parts.map((p) => [p, partScore(p, s)] as const).filter(([, sc]) => sc > 0)
        .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name)).map(([p]) => p);
      return [{ key: "results", title: `${hits.length} result${hits.length === 1 ? "" : "s"}`, parts: hits, collapsible: false }];
    }
    const out: { key: string; title: string; parts: ComponentDef[]; collapsible: boolean }[] = [];
    const rec = recent.map((id) => getPart(id)).filter((p): p is ComponentDef => !!p);
    if (rec.length) out.push({ key: "recent", title: "Recently used", parts: rec, collapsible: true });
    const cats = new Map<string, ComponentDef[]>();
    for (const p of parts) cats.set(p.category, [...(cats.get(p.category) ?? []), p]);
    for (const [cat, ps] of cats) out.push({ key: `cat:${cat}`, title: cat, parts: ps, collapsible: true });
    return out;
  }, [q, parts.length, recent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat navigation order: (section, part) pairs that are visible.
  const flat = useMemo(() => sections.flatMap((sec) => (collapsed.has(sec.key) && sec.collapsible ? [] : sec.parts.map((p) => ({ sec: sec.key, p })))), [sections, collapsed]);
  const focusKey = (sec: string, id: string) => `${sec}/${id}`;
  const [focusSec, setFocusSec] = useState<string | null>(null);
  const focusIdx = flat.findIndex((x) => x.p.id === focusId && x.sec === focusSec);

  useEffect(() => {
    if (q.trim() && flat.length) { setFocusId(flat[0].p.id); setFocusSec(flat[0].sec); }
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveFocus = (i: number, focusDom = true) => {
    if (!flat.length) return;
    const n = Math.max(0, Math.min(flat.length - 1, i));
    setFocusId(flat[n].p.id); setFocusSec(flat[n].sec);
    if (focusDom) {
      const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(focusKey(flat[n].sec, flat[n].p.id))}"]`);
      el?.focus(); el?.scrollIntoView({ block: "nearest" });
    }
  };

  const activate = (p: ComponentDef) => {
    const active = typeof tool === "object" && tool.place === p.id;
    setTool(active ? "select" : { place: p.id });
    if (!active) useEditor.getState().noteRecent(p.id);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(focusIdx + 1); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (focusIdx <= 0) searchRef.current?.focus(); else moveFocus(focusIdx - 1);
    }
    else if (e.key === "Home") { e.preventDefault(); moveFocus(0); }
    else if (e.key === "End") { e.preventDefault(); moveFocus(flat.length - 1); }
    else if (e.key === "Escape") { e.preventDefault(); if (typeof tool === "object") setTool("select"); else searchRef.current?.focus(); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !(typeof tool === "object" && /^[rx]$/i.test(e.key))) {
      // type-to-search from the list
      e.preventDefault(); searchRef.current?.focus(); setQ((s) => s + e.key);
    }
  };

  const toggleSection = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key); else next.add(key);
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* not persisted */ }
  };

  const shown = (focusId && getPart(focusId)) || (typeof tool === "object" ? getPart(tool.place) : undefined);

  return (
    <aside className="panel library" aria-label="Component library">
      <div className="search-row">
        <input ref={searchRef} className="search" placeholder="Search parts (e.g. resistor, 1k, led)…" value={q} type="search"
          onChange={(e) => setQ(e.target.value)} aria-label="Search parts" aria-controls="sb-lib-list"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(focusIdx < 0 ? 0 : focusIdx); }
            else if (e.key === "Enter" && flat.length) { e.preventDefault(); activate(flat[Math.max(0, focusIdx)].p); }
            else if (e.key === "Escape") { if (q) { e.preventDefault(); setQ(""); } }
          }} />
      </div>
      <div className="lib-scroll" id="sb-lib-list" ref={listRef} role="listbox" aria-label="Parts" onKeyDown={onListKey}>
        {sections.map((sec) => {
          const isCollapsed = sec.collapsible && collapsed.has(sec.key);
          return (
            <section key={sec.key} aria-label={sec.title}>
              {sec.collapsible
                ? <button className="cat" onClick={() => toggleSection(sec.key)} aria-expanded={!isCollapsed}>
                    <span className="chev" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span><h3>{sec.title}</h3><span className="count">{sec.parts.length}</span>
                  </button>
                : <h3>{sec.title}</h3>}
              {!isCollapsed && sec.parts.map((p) => {
                const active = typeof tool === "object" && tool.place === p.id;
                const focused = p.id === focusId && sec.key === focusSec;
                return (
                  <button key={p.id} data-key={focusKey(sec.key, p.id)} role="option" aria-selected={active}
                    className={`lib-item ${active ? "active" : ""} ${focused ? "focus" : ""}`}
                    tabIndex={focused || (focusIdx < 0 && p === flat[0]?.p && sec.key === flat[0]?.sec) ? 0 : -1}
                    title={`${p.description}\n\nClick to place, or drag onto the canvas.`}
                    onFocus={() => { setFocusId(p.id); setFocusSec(sec.key); }}
                    onMouseEnter={() => { setFocusId(p.id); setFocusSec(sec.key); }}
                    onClick={(e) => {
                      activate(p);
                      // after a mouse click, keys like R / X / Esc should reach the canvas, not the list
                      if (e.detail > 0) document.querySelector<HTMLElement>(".sb-editor")?.focus({ preventScroll: true });
                    }}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PART_MIME, p.id);
                      e.dataTransfer.setData("text/plain", p.name);
                      e.dataTransfer.effectAllowed = "copy";
                      usePointer.getState().set({ dropPart: p.id });
                    }}
                    onDragEnd={() => usePointer.getState().set({ dropPart: null })}>
                    <SymbolPreview def={p} size={38} />
                    <span className="name"><b>{p.name}</b><small className={`prov prov-${p.provenance}`}>{p.provenance === "none" ? "schematic only" : p.provenance}</small></span>
                  </button>
                );
              })}
            </section>
          );
        })}
        {flat.length === 0 && sections.every((s) => !s.parts.length) && (
          <p className="lib-empty">No parts match “{q}”. Try a shorter word, a category (Sources, Passive) or a reference letter (R, C, D).</p>
        )}
      </div>
      {shown && <PartDetails def={shown} />}
    </aside>
  );
});

function PartDetails({ def }: { def: ComponentDef }) {
  const unsupported = Object.entries(def.analyses ?? {}).filter(([, ok]) => ok === false).map(([a]) => a.toUpperCase());
  return (
    <div className="lib-details" aria-live="polite">
      <div className="preview"><SymbolPreview def={def} size={84} /></div>
      <h4>{def.name}</h4>
      <div className="meta">
        <span className={`prov prov-${def.provenance}`}>{def.provenance === "none" ? "schematic only" : def.provenance}</span>
        <span>{def.pins.length} pin{def.pins.length === 1 ? "" : "s"}</span>
        <span>ref {def.refPrefix}</span>
        {def.kicad && <span title="KiCad symbol">{def.kicad.symbol}</span>}
      </div>
      <p>{def.description}</p>
      <p>{PROV_TEXT[def.provenance]}{def.accuracyNote ? ` ${def.accuracyNote}` : ""}</p>
      {unsupported.length > 0 && <p className="warn">Not available in {unsupported.join(", ")} analysis.</p>}
      <p className="tip">Click to place (repeatable, Esc to stop) or drag onto the canvas. R rotates, X mirrors while placing.</p>
    </div>
  );
}
