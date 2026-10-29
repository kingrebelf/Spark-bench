// Design checks run before every simulation, export and AI proposal.
// They name the affected parts so messages are actionable; ngspice only knows node names.
import { computeConnectivity, type Connectivity } from "./connectivity";
import { getPart } from "./library";
import type { ComponentDef, Diagnostic, Project } from "./types";

export function runChecks(
  project: Project,
  lookup: (id: string) => ComponentDef | undefined = getPart,
  conn: Connectivity = computeConnectivity(project, lookup),
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const comps = project.schematic.components;
  const byId = new Map(comps.map((c) => [c.id, c]));
  const simParts = comps.filter((c) => { const d = lookup(c.type); return d && !d.role && d.spice; });

  if (simParts.length === 0) {
    out.push({ severity: "error", code: "empty", source: "check",
      message: "There is nothing to simulate yet.",
      fix: "Drag a source, a few parts and a ground symbol from the library onto the canvas and wire them." });
    return out;
  }

  for (const c of conn.unknownParts) {
    out.push({ severity: "error", code: "unknown-part", source: "check", componentIds: [c.id],
      message: `${c.ref} uses the part type "${c.type}", which is not in the library.`,
      fix: "Replace it with a library part." });
  }

  // Duplicate references.
  const refs = new Map<string, string[]>();
  for (const c of comps) { const d = lookup(c.type); if (d?.role) continue; refs.set(c.ref, [...(refs.get(c.ref) ?? []), c.id]); }
  for (const [ref, ids] of refs) if (ids.length > 1) {
    out.push({ severity: "error", code: "duplicate-ref", source: "check", componentIds: ids,
      message: `${ids.length} parts share the reference ${ref}.`,
      fix: "Give each part a unique reference (Edit → Annotate, or edit the Reference field)." });
  }

  // Ground.
  if (!conn.nets.some((n) => n.isGround)) {
    out.push({ severity: "error", code: "no-ground", source: "check",
      message: "The circuit has no ground reference.",
      fix: "Place a Ground symbol and wire it to the negative side of your supply. SPICE measures every voltage relative to ground (node 0)." });
  }

  // Floating / single-connection pins.
  for (const net of conn.nets) {
    const simPins = net.pins.filter((p) => { const c = byId.get(p.componentId); const d = c && lookup(c.type); return d && !d.role; });
    if (simPins.length === 1 && !net.isGround) {
      const c = byId.get(simPins[0].componentId)!;
      const d = lookup(c.type)!;
      const pinName = d.pins.find((p) => p.id === simPins[0].pinId)?.name ?? simPins[0].pinId;
      const hasLabel = net.labelNames.length > 0;
      out.push({ severity: "error", code: "floating-pin", source: "check", componentIds: [c.id], wireIds: net.wireIds, netNames: [net.name],
        message: `${c.ref} pin ${pinName} is not connected to anything${hasLabel ? ` else (label "${net.labelNames[0]}" has no other connections)` : ""}.`,
        fix: `Wire ${c.ref} pin ${pinName} to the rest of the circuit, or delete the part if it is unused.` });
    }
  }
  for (const c of simParts) {
    const d = lookup(c.type)!;
    for (const pin of d.pins) {
      if (!conn.pinNet.has(`${c.id}:${pin.id}`)) {
        out.push({ severity: "error", code: "floating-pin", source: "check", componentIds: [c.id],
          message: `${c.ref} pin ${pin.name} is not connected.`, fix: `Wire ${c.ref} pin ${pin.name}.` });
      }
    }
  }

  // DC path to ground: nets reachable from ground through DC-conducting pin pairs.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b); adj.get(b)!.add(a);
  };
  for (const c of simParts) {
    const d = lookup(c.type)!;
    const pairs = d.dcPaths ?? d.pins.flatMap((p, i) => d.pins.slice(i + 1).map((q) => [p.id, q.id] as [string, string]));
    for (const [a, b] of pairs) {
      const na = conn.pinNet.get(`${c.id}:${a}`), nb = conn.pinNet.get(`${c.id}:${b}`);
      if (na && nb) link(na, nb);
    }
  }
  if (conn.nets.some((n) => n.isGround)) {
    const seen = new Set<string>(["0"]);
    const stack = ["0"];
    while (stack.length) { const n = stack.pop()!; for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); stack.push(m); } }
    for (const net of conn.nets) {
      if (seen.has(net.name)) continue;
      const simPins = net.pins.filter((p) => { const c = byId.get(p.componentId); const d = c && lookup(c.type); return d && !d.role; });
      if (simPins.length < 2) continue; // already reported as floating
      const ids = [...new Set(simPins.map((p) => p.componentId))];
      out.push({ severity: "error", code: "no-dc-path", source: "check", componentIds: ids, netNames: [net.name], wireIds: net.wireIds,
        message: `Net ${net.name} (${ids.map((i) => byId.get(i)!.ref).join(", ")}) has no DC path to ground, so its voltage is undefined.`,
        fix: "Connect it to ground through a resistor (a 10 MΩ bleeder works if it should be isolated), or check for a missing wire." });
    }
  }

  // Wires that touch nothing.
  for (const net of conn.nets) {
    if (net.pins.length === 0 && net.wireIds.length && net.labelNames.length === 0) {
      out.push({ severity: "warning", code: "dangling-wire", source: "check", wireIds: net.wireIds,
        message: "A wire is not connected to any part.", fix: "Delete it or extend it to a pin." });
    }
  }
  return out;
}

export const hasErrors = (d: Diagnostic[]) => d.some((x) => x.severity === "error");
