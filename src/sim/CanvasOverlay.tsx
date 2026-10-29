// On-canvas probe markers with live values. The schematic canvas mounts this inside its
// zoomed/panned <g> (grid units), e.g. `<SimCanvasOverlay />` right after the op-voltage labels.
// It shows probe values at the playback time (or the end of the run) for transient results and the
// operating point for op results. AC sweeps have no single value per probe, so only the marker is drawn.
import { useMemo } from "react";
import { computeConnectivity } from "../core/connectivity";
import { useProject } from "../core/store";
import { formatSI } from "../core/units";
import { interpolate } from "../scope/measure";
import { resolveProbes, vectorForProbe } from "./probes";
import { usePlayback, useSim, useStaleness } from "./store";
import { probeLabel } from "./traces";

export function SimCanvasOverlay() {
  const project = useProject((s) => s.project);
  const result = useSim((s) => s.result);
  const t = usePlayback((s) => s.t);
  const stale = useStaleness();
  const conn = useMemo(() => computeConnectivity(project), [project]);
  const probes = useMemo(() => resolveProbes(project, conn), [project, conn]);
  if (!probes.length) return null;

  // Labels stack upward when they would overlap an earlier one.
  const placed: { x: number; y: number; w: number }[] = [];
  return (
    <g className="sim-overlay" pointerEvents="none">
      {probes.map((r) => {
        let at = r.probe.target.point;
        if (!at && r.netName) at = conn.nets.find((n) => n.name === r.netName)?.points[0];
        if (r.componentId) {
          const c = project.schematic.components.find((x) => x.id === r.componentId);
          if (c) at = { x: c.position.x + 1.2, y: c.position.y - 1 };
        }
        if (!at) return null;
        const label = probeLabel(r, project);
        let value: string | null = null;
        const v = result?.ok ? vectorForProbe(r, result) : undefined;
        if (v && result) {
          if (result.analysis === "op") value = formatSI(v.real[0], v.unit, 3);
          else if (result.analysis === "tran" && result.x) {
            const time = t ?? result.x.real[result.x.real.length - 1];
            value = formatSI(interpolate(result.x.real, v.real, time), v.unit, 3) + (t == null ? " (end)" : "");
          }
        }
        if (r.problem) value = "no target";
        const text = (value ? `${label} = ${value}` : label) + (stale.schematic && value ? " (stale)" : "");
        const w = text.length * 0.56 + 1;
        let ly = at.y - 2.1;
        const lx = at.x + 0.7;
        while (placed.some((p) => lx < p.x + p.w && p.x < lx + w && Math.abs(p.y - ly) < 1.6)) ly -= 1.7;
        placed.push({ x: lx, y: ly, w });
        return (
          <g key={r.probe.id} opacity={stale.schematic ? 0.5 : 1}>
            {r.probe.kind === "voltage"
              ? <circle cx={at.x} cy={at.y} r={0.45} fill={r.color} stroke="var(--bg)" strokeWidth={0.12} />
              : <path d={`M ${at.x - 0.5} ${at.y - 0.6} L ${at.x + 0.5} ${at.y} L ${at.x - 0.5} ${at.y + 0.6} Z`} fill={r.color} stroke="var(--bg)" strokeWidth={0.12} />}
            <rect x={lx} y={ly} width={w} height={1.5} rx={0.3} fill="var(--panel)" stroke={r.color} strokeWidth={0.1} opacity={0.92} />
            <text x={lx + 0.4} y={ly + 0.75} fontSize={0.95} fill={r.problem ? "var(--error)" : "var(--text)"} dominantBaseline="middle" fontFamily="var(--mono)">
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}
