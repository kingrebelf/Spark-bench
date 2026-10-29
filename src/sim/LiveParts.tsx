// Result-driven looks of parts on the schematic: LED glow from the simulated forward current, switch /
// push button drawn in their state at the playback time, potentiometer wiper position. Rendered in grid
// units inside the canvas's zoomed group (via SimCanvasOverlay). Grab areas of interactive parts get a
// pointer cursor; the canvas routes the actual presses to `liveInput`.
import { getPart } from "../core/library";
import { useProject } from "../core/store";
import { parseSI, formatSI } from "../core/units";
import type { ComponentDef, ComponentInstance, SimResult } from "../core/types";
import { interpolate } from "../scope/measure";
import { displayLimit } from "./live";
import { grabBox, liveEnabled, liveValue, wiperY } from "./interact";
import { usePlayback, useSim, useStaleness, useValidUntil } from "./store";

const LED_RGB: Record<string, string> = {
  red: "#ff3b30", orange: "#ff9500", yellow: "#ffd60a", green: "#30d158", "green (old GaP)": "#8fd14f",
  blue: "#0a84ff", white: "#ffffff", infrared: "#b0306a",
};

function ledCurrent(r: SimResult | null, id: string, t: number | null): number | null {
  if (!r?.ok) return null;
  const v = r.vectors.find((x) => x.kind === "current" && x.componentId === id);
  if (!v) return null;
  if (r.analysis === "op") return v.real[0];
  if (r.analysis !== "tran" || !r.x) return null;
  const x = r.x.real;
  return interpolate(x, v.real, t ?? x[x.length - 1]);
}

const xf = (c: ComponentInstance) => `translate(${c.position.x},${c.position.y}) rotate(${c.rotation}) scale(${c.mirror ? -1 : 1},1)`;

export function LiveParts() {
  const comps = useProject((s) => s.project.schematic.components);
  const result = useSim((s) => s.result);
  useSim((s) => s.session); // re-render when changes are recorded
  const t = usePlayback((s) => s.t);
  const valid = useValidUntil();
  const stale = useStaleness();
  const enabled = liveEnabled();
  // Results are only shown up to the earliest change not yet re-simulated.
  const tShow = result?.analysis === "tran" ? displayLimit(t, valid) : null;

  const parts: { c: ComponentInstance; def: ComponentDef }[] = [];
  for (const c of comps) { const def = getPart(c.type); if (def?.interactive || def?.indicator) parts.push({ c, def: def! }); }
  if (!parts.length) return null;

  return (
    <g className="live-parts">
      <defs>
        {Object.entries(LED_RGB).map(([k, col]) => (
          <radialGradient key={k} id={`sb-glow-${k.replace(/\W/g, "")}`}>
            <stop offset="0%" stopColor={col} stopOpacity={1} />
            <stop offset="45%" stopColor={col} stopOpacity={0.55} />
            <stop offset="100%" stopColor={col} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {parts.map(({ c, def }) => {
        if (def.indicator?.kind === "led") {
          const i = ledCurrent(result, c.id, tShow);
          if (i == null) return null;
          const rated = parseSI(String(c.props.if ?? def.props.find((p) => p.key === "if")?.default ?? "")) || def.indicator.ratedCurrent || 0.02;
          const b = Math.min(1, Math.max(0, i / rated));
          const color = String(c.props[def.indicator.colorProp ?? "color"] ?? "red");
          const key = (LED_RGB[color] ? color : "red").replace(/\W/g, "");
          const tip = `${c.ref}: ${formatSI(i, "A", 3)} forward current (${Math.round(b * 100)} % of ${formatSI(rated, "A")}). Glow shows current, not light output.`;
          return (
            <g key={c.id} opacity={stale.schematic ? 0.4 : 1}>
              {b > 0.005 && <circle cx={c.position.x} cy={c.position.y} r={1.2 + 1.8 * Math.sqrt(b)} fill={`url(#sb-glow-${key})`} opacity={0.25 + 0.75 * b} pointerEvents="none" />}
              <circle cx={c.position.x} cy={c.position.y} r={1.3} fill="transparent" pointerEvents="all"><title>{tip}</title></circle>
            </g>
          );
        }
        const it = def.interactive!;
        const v = liveValue(c, def, enabled ? t : null);
        const box = grabBox(def);
        const hint = it.kind === "toggle" ? "Click to flip it while the simulation plays"
          : it.kind === "momentary" ? "Hold to press while the simulation plays" : "Drag up/down to move the wiper while the simulation plays";
        return (
          <g key={c.id} transform={xf(c)}>
            {it.kind === "toggle" && v >= 0.5 && <>
              <line x1={-1.3} y1={-0.2} x2={2} y2={-1.6} stroke="var(--bg)" strokeWidth={0.45} />
              <line x1={-1.5} y1={0} x2={1.5} y2={0} stroke="var(--accent)" strokeWidth={0.28} strokeLinecap="round" />
            </>}
            {it.kind === "momentary" && v >= 0.5 && <>
              <line x1={-2} y1={-1} x2={2} y2={-1} stroke="var(--bg)" strokeWidth={0.45} />
              <line x1={0} y1={-2.4} x2={0} y2={-1} stroke="var(--bg)" strokeWidth={0.45} />
              <line x1={-0.8} y1={-2.4} x2={0.8} y2={-2.4} stroke="var(--bg)" strokeWidth={0.45} />
              <line x1={-2} y1={-0.35} x2={2} y2={-0.35} stroke="var(--accent)" strokeWidth={0.28} strokeLinecap="round" />
              <line x1={0} y1={-1.6} x2={0} y2={-0.35} stroke="var(--accent)" strokeWidth={0.2} />
              <line x1={-0.8} y1={-1.6} x2={0.8} y2={-1.6} stroke="var(--accent)" strokeWidth={0.2} />
            </>}
            {it.kind === "slider" && enabled && (() => {
              const y = wiperY(v);
              return <>
                <path d={`M 1.0 ${y} L 1.9 ${y - 0.5} L 1.9 ${y + 0.5} Z`} fill="var(--accent)" />
                <text x={-1.2} y={y} fontSize={0.95} dominantBaseline="middle" textAnchor="end" fill="var(--accent)" fontFamily="var(--mono)"
                  transform={c.rotation || c.mirror ? `rotate(${-c.rotation} -1.2 ${y})` : undefined}>{Math.round(v)} %</text>
              </>;
            })()}
            {enabled && (
              <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} rx={0.4} className="live-grab"
                fill="transparent" stroke="var(--accent)" strokeWidth={0.08} strokeDasharray="0.4 0.3" pointerEvents="all"
                style={{ cursor: it.kind === "slider" ? "ns-resize" : "pointer" }}>
                <title>{`${c.ref}: ${hint}. The whole run is re-simulated from 0 s with your change at that time.`}</title>
              </rect>
            )}
          </g>
        );
      })}
    </g>
  );
}
