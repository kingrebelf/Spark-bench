import { memo } from "react";
import type { ComponentDef, Shape } from "../core/types";
import { defBounds, symbolBounds } from "./ops";

export { symbolBounds };

/**
 * Renders library symbol shapes in grid units (the parent <g> applies scale/rotation).
 * Strokes use non-scaling widths in screen pixels so symbols stay crisp at every zoom;
 * the width comes from the `--sym-w` CSS variable (see editor.css) unless given.
 */
export const SymbolShapes = memo(function SymbolShapes({ shapes, stroke = "currentColor", width }: { shapes: Shape[]; stroke?: string; width?: number }) {
  const common = { stroke, fill: "none", vectorEffect: "non-scaling-stroke" as const, className: "sym-stroke", strokeWidth: width, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <>
      {shapes.map((s, i) => {
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
          case "text": return <text key={i} x={s.x} y={s.y} fontSize={s.size ?? 1.2} textAnchor={s.anchor ?? "start"} fill={stroke} stroke="none" dominantBaseline="central">{s.text}</text>;
        }
      })}
    </>
  );
});

/** Standalone, auto-framed symbol preview (library list, details). */
export function SymbolPreview({ def, size = 40 }: { def: ComponentDef; size?: number }) {
  const b = defBounds(def);
  const pad = 0.8;
  const w = Math.max(b.w, 2) + pad * 2, h = Math.max(b.h, 2) + pad * 2;
  const side = Math.max(w, h);
  const x = b.x + b.w / 2 - side / 2, y = b.y + b.h / 2 - side / 2;
  return (
    <svg className="sym-preview" viewBox={`${x} ${y} ${side} ${side}`} width={size} height={size} color="var(--symbol)" aria-hidden="true">
      <SymbolShapes shapes={def.symbol} width={size >= 80 ? 2 : 1.4} />
      {def.pins.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={side * 0.025} fill="var(--accent)" />)}
    </svg>
  );
}
