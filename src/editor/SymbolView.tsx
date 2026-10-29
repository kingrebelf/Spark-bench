import type { Shape } from "../core/types";

/** Renders library symbol shapes in grid units (parent <g> applies scale/rotation). */
export function SymbolShapes({ shapes, stroke = "currentColor" }: { shapes: Shape[]; stroke?: string }) {
  return (
    <>
      {shapes.map((s, i) => {
        const common = { stroke, strokeWidth: 0.15, fill: "none", vectorEffect: "non-scaling-stroke" as const };
        switch (s.kind) {
          case "line": return <line key={i} {...common} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />;
          case "rect": return <rect key={i} {...common} x={s.x} y={s.y} width={s.w} height={s.h} fill={s.fill ? stroke : "var(--symbol-fill)"} />;
          case "circle": return <circle key={i} {...common} cx={s.cx} cy={s.cy} r={s.r} fill={s.fill ? stroke : "var(--symbol-fill)"} />;
          case "polyline": {
            const pts = s.points.map((p) => `${p.x},${p.y}`).join(" ");
            return s.closed
              ? <polygon key={i} {...common} points={pts} fill={s.fill ? stroke : "var(--symbol-fill)"} />
              : <polyline key={i} {...common} points={pts} />;
          }
          case "arc": return <path key={i} {...common} d={`M${s.x1},${s.y1} A${s.r},${s.r} 0 0 ${s.sweep ? 1 : 0} ${s.x2},${s.y2}`} />;
          case "text": return <text key={i} x={s.x} y={s.y} fontSize={s.size ?? 1.2} textAnchor={s.anchor ?? "start"} fill={stroke} stroke="none" dominantBaseline="middle">{s.text}</text>;
        }
      })}
    </>
  );
}

export function symbolBounds(shapes: Shape[], pins: { x: number; y: number }[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of pins) add(p.x, p.y);
  for (const s of shapes) {
    if (s.kind === "line") { add(s.x1, s.y1); add(s.x2, s.y2); }
    else if (s.kind === "rect") { add(s.x, s.y); add(s.x + s.w, s.y + s.h); }
    else if (s.kind === "circle") { add(s.cx - s.r, s.cy - s.r); add(s.cx + s.r, s.cy + s.r); }
    else if (s.kind === "polyline") s.points.forEach((p) => add(p.x, p.y));
    else if (s.kind === "arc") { add(s.x1 - s.r, s.y1 - s.r); add(s.x2 + s.r, s.y2 + s.r); }
    else if (s.kind === "text") add(s.x, s.y);
  }
  if (!Number.isFinite(x0)) return { x: -1, y: -1, w: 2, h: 2 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
