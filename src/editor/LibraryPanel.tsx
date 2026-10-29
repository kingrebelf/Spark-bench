import { useMemo, useState } from "react";
import { allParts } from "../core/library";
import { SymbolShapes, symbolBounds } from "./SymbolView";
import { useEditor } from "./store";

export function LibraryPanel() {
  const [q, setQ] = useState("");
  const { tool, setTool } = useEditor();
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const parts = allParts().filter((p) => !s || [p.name, p.description, p.category, ...(p.keywords ?? [])].join(" ").toLowerCase().includes(s));
    const m = new Map<string, typeof parts>();
    for (const p of parts) m.set(p.category, [...(m.get(p.category) ?? []), p]);
    return [...m];
  }, [q]);
  return (
    <aside className="panel library" aria-label="Component library">
      <input className="search" placeholder="Search parts…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parts" />
      <div className="lib-scroll">
        {groups.map(([cat, parts]) => (
          <section key={cat}>
            <h3>{cat}</h3>
            {parts.map((p) => {
              const b = symbolBounds(p.symbol, p.pins);
              const active = typeof tool === "object" && tool.place === p.id;
              return (
                <button key={p.id} className={`lib-item ${active ? "active" : ""}`} title={p.description}
                  onClick={() => setTool(active ? "select" : { place: p.id })}>
                  <svg viewBox={`${b.x - 1} ${b.y - 1} ${b.w + 2} ${b.h + 2}`} width={34} height={34} color="var(--symbol)"><SymbolShapes shapes={p.symbol} /></svg>
                  <span>{p.name}<small className={`prov prov-${p.provenance}`}>{p.provenance}</small></span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
