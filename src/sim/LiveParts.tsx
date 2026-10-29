// Result-driven looks of parts on the schematic: LED glow from the simulated forward current, switch /
// push button drawn in their state at the playback time, potentiometer wiper position. Rendered in grid
// units inside the canvas's zoomed group (via SimCanvasOverlay). Grab areas of interactive parts get a
// pointer cursor; the canvas routes the actual presses to `liveInput`.
import { useMemo } from "react";
import { getPart } from "../core/library";
import { useProject } from "../core/store";
import { parseSI, formatSI } from "../core/units";
import type { ComponentDef, ComponentInstance, SimResult } from "../core/types";
import { interpolate } from "../scope/measure";
import { displayLimit } from "./live";
import { grabBox, liveEnabled, liveValue, wiperY } from "./interact";
import { usePlayback, useRunProject, useSim, useStaleness, useValidUntil } from "./store";
import { failedAt, stressTracks, WARN_FRACTION } from "./stress";

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
  if (!parts.length) return <StressMarks />;

  return (
    <g className="live-parts">
      <StressMarks />
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

/**
 * Over-stress on the schematic at the playback time: an amber-to-red glow as a part's averaged stress nears its
 * rating, then (transient only) a short flash and smoke puff when it fails, and a charred mark while it is open.
 */
function StressMarks() {
  const result = useSim((s) => s.result);
  const damage = useSim((s) => s.session?.damage);
  const runProject = useRunProject();
  const comps = useProject((s) => s.project.schematic.components);
  const t = usePlayback((s) => s.t);
  const rate = usePlayback((s) => s.rate);
  const valid = useValidUntil();
  const tracks = useMemo(() => (result?.ok ? stressTracks(runProject, result, damage ?? {}) : []), [runProject, result, damage]);
  if (!tracks.length && !damage) return null;
  const x = result?.analysis === "tran" ? result.x?.real : undefined;
  const tShow = x ? displayLimit(t, valid) ?? x[x.length - 1] : 0;
  const worst = new Map<string, { ratio: number; ref: string; kind: string }>();
  for (const tr of tracks) {
    const r = x ? interpolate(x, tr.ratio, tShow) : tr.ratio[0];
    const w = worst.get(tr.componentId);
    if (!w || r > w.ratio) worst.set(tr.componentId, { ratio: r, ref: tr.ref, kind: tr.kind });
  }
  return (
    <g className="stress-marks">
      {comps.map((c) => {
        const failed = x ? failedAt(damage?.[c.id], tShow) : undefined;
        const w = worst.get(c.id);
        const { x: cx, y: cy } = c.position;
        if (failed) {
          const p = (tShow - failed.t) / Math.max(rate, 1e-12); // seconds of playback since the failure
          return (
            <g key={c.id}>
              {p < 0.35 && <circle cx={cx} cy={cy} r={1.5 + 4 * p} fill="#ffb300" opacity={0.8 * (1 - p / 0.35)} pointerEvents="none" />}
              {p < 2.5 && [0, 1, 2].map((i) => {
                const q = Math.max(0, p - i * 0.25);
                return <circle key={i} cx={cx + (i - 1) * 0.6 + q * 0.4} cy={cy - 1 - q * 2.6} r={0.6 + q * 0.7} fill="#9e9e9e" opacity={Math.max(0, 0.55 * (1 - q / 2.2))} pointerEvents="none" />;
              })}
              <circle cx={cx} cy={cy} r={1.5} fill="#2b2118" opacity={0.75} stroke="#ff5722" strokeWidth={0.12} pointerEvents="all">
                <title>{failed.message}</title>
              </circle>
              <text x={cx} y={cy} fontSize={1.4} textAnchor="middle" dominantBaseline="central" fill="#ff7043" pointerEvents="none">✕</text>
            </g>
          );
        }
        if (!w || w.ratio < WARN_FRACTION) return null;
        const k = Math.min(1, (w.ratio - WARN_FRACTION) / (1 - WARN_FRACTION));
        const over = w.ratio >= 1;
        return (
          <circle key={c.id} cx={cx} cy={cy} r={2.2 + 0.6 * k} fill="none" stroke={over ? "#ff3d00" : "#ffa000"} strokeWidth={0.25 + 0.35 * k}
            opacity={0.35 + 0.55 * k} strokeDasharray={over ? undefined : "0.6 0.4"} pointerEvents="all">
            <title>{`${w.ref}: ${Math.round(w.ratio * 100)} % of its ${w.kind === "reverse-voltage" ? "reverse-voltage limit" : `${w.kind} rating`}${x ? " (averaged)" : ""}.${over && x ? " It fails when the average stays above 100 %." : ""}`}</title>
          </circle>
        );
      })}
    </g>
  );
}
