// What the model sees: a compact library catalog, the current circuit as nets, and instructions.
// Kept short on purpose (one line per part) so small local models with little context still fit.
import { computeConnectivity } from "../core/connectivity";
import { allParts, getPart } from "../core/library";
import type { ComponentDef, Diagnostic, Project, SimResult } from "../core/types";

type Lookup = (id: string) => ComponentDef | undefined;

/** One line per simulatable/schematic part. Role parts (ground, labels, probes) are expressed differently. */
export function catalogText(parts: ComponentDef[] = allParts()): string {
  return parts
    .filter((d) => !d.role)
    .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
    .map((d) => {
      const pins = d.pins.map((p) => (p.name && p.name !== p.id ? `${p.id}(${p.name})` : p.id)).join(",");
      const props = d.props.map((p) => `${p.key}${p.unit ? `[${p.unit}]` : ""}=${p.default === "" ? "\"\"" : p.default}${p.options ? `{${p.options.join("|")}}` : ""}`).join(" ");
      const an = d.analyses ? Object.entries(d.analyses).filter(([, v]) => v === false).map(([k]) => `no-${k}`).join(",") : "";
      const sim = d.spice ? "" : " schematic-only";
      return `${d.id} | ${d.name} | ${d.refPrefix} | pins ${pins} | ${props || "no props"} | ${d.provenance}${sim}${an ? ` ${an}` : ""}`;
    })
    .join("\n");
}

/** Current circuit: parts with values, then nets as REF.PIN lists (ground net marked). */
export function circuitText(project: Project, lookup: Lookup = getPart): string {
  const comps = project.schematic.components.filter((c) => { const d = lookup(c.type); return d && !d.role; });
  if (!comps.length) return "(empty: no parts placed yet)";
  const conn = computeConnectivity(project, lookup);
  const byId = new Map(project.schematic.components.map((c) => [c.id, c]));
  const partLines = comps.map((c) => {
    const d = lookup(c.type)!;
    const vals = d.props.map((p) => `${p.key}=${c.props[p.key] ?? p.default}`).filter((s) => !s.endsWith("=")).join(" ");
    const fp = c.kicad?.footprint ? ` footprint=${c.kicad.footprint}` : "";
    return `${c.ref} ${c.type} ${vals}${fp}`.trim();
  });
  const netLines: string[] = [];
  const seen = new Set<string>();
  for (const n of conn.nets) {
    const pins = n.pins.filter((p) => !lookup(byId.get(p.componentId)!.type)?.role).map((p) => `${byId.get(p.componentId)!.ref}.${p.pinId}`);
    pins.forEach((p) => seen.add(p));
    if (!pins.length) continue;
    netLines.push(`${n.isGround ? "GND (ground)" : n.name}: ${pins.join(" ")}`);
  }
  const unconnected: string[] = [];
  for (const c of comps) for (const p of lookup(c.type)!.pins) if (!seen.has(`${c.ref}.${p.id}`)) unconnected.push(`${c.ref}.${p.id}`);
  if (unconnected.length) netLines.push(`(unconnected): ${unconnected.join(" ")}`);
  for (const c of conn.unknownParts) partLines.push(`${c.ref} ${c.type} (NOT IN LIBRARY; pins unknown)`);
  return `Parts:\n${partLines.join("\n")}\nNets:\n${netLines.join("\n")}`;
}

export function systemPrompt(catalog = catalogText()): string {
  return `You are the circuit-design assistant inside SparkBench, a schematic editor that simulates with ngspice.
Reply with JSON only, matching the provided schema.

How to work:
- If a requirement that changes the design is missing (supply voltage, load, signal levels, timing/frequency, operating conditions), ask in "questions" and set "proposal" to null. Do not guess what matters; state minor assumptions in "assumptions".
- Use only part ids from the catalog below. Never invent ids, pins or property keys. If the library lacks a needed part, say so in "message" and propose the closest honest alternative (or none).
- Describe connections as nets (lists of REF.PIN using pin ids), never coordinates. Every pin of every part appears in exactly one net. Mark exactly one net "ground": true; ground symbols are added automatically.
- When the user already has a circuit, "parts" must list every part that remains (existing parts by their current ref; include only the values you change), "remove" lists refs to delete, and "nets" is the full connectivity after the change. Existing parts stay where they are.
- Values are SI strings. Here "M" and "MEG" mean mega and "m" means milli; prefer "MEG" for 1e6. Examples: 4.7k, 100n, 2.2u, 1MEG, 10m.
- Explain each part's role. Set "uncertain": true when a value depends on information you do not have, and say why.
- Parts are labelled ideal / generic / behavioral / vendor / none. Never claim a generic or behavioral model behaves like a specific real device.
- Suggest simulations that verify the design with numeric expected ranges (min/max) on named nets; SparkBench runs them and compares.
- KiCad: when asked to prepare for KiCad, ask about footprint choices (SMD size or through-hole, ratings) before choosing; put footprints in kicadFootprint as KiCad lib_ids (e.g. Resistor_SMD:R_0805_2012Metric).
- Keep "message" short and plain; no markdown tables.

Catalog (id | name | ref prefix | pins id(name) | props key[unit]=default | provenance):
${catalog}`;
}

export type AssistantAction = "chat" | "diagnose" | "tests" | "kicad";

/** The user turn sent to the model: the request plus the circuit as it is right now. */
export function userTurn(action: AssistantAction, text: string, project: Project, extra?: { diagnostics?: Diagnostic[]; sim?: SimResult | null }, lookup: Lookup = getPart): string {
  const circuit = circuitText(project, lookup);
  const head: Record<AssistantAction, string> = {
    chat: text,
    diagnose: `Diagnose my circuit. Explain each problem in plain language and propose a fix (as a proposal) if one is clear.${text ? `\nMore context: ${text}` : ""}`,
    tests: `Suggest simulations that test my current circuit, with numeric expected results. Keep the circuit unchanged (proposal with the same parts and nets, empty "remove").${text ? `\nFocus: ${text}` : ""}`,
    kicad: `Prepare my circuit for KiCad PCB layout. Ask me about footprint choices first if you need to (SMD size vs through-hole, power ratings, connectors); otherwise propose kicadFootprint for every part, keeping parts and nets unchanged.${text ? `\nPreferences: ${text}` : ""}`,
  };
  let s = `${head[action]}\n\nCurrent circuit:\n${circuit}`;
  const d = extra?.diagnostics ?? [];
  if (d.length) s += `\n\nCurrent diagnostics:\n${d.map((x) => `- [${x.severity}] ${x.message}${x.fix ? ` (suggested fix: ${x.fix})` : ""}`).join("\n")}`;
  const sim = extra?.sim;
  if (sim) {
    s += `\n\nLast simulation (${sim.analysis}, ${sim.ok ? "succeeded" : "failed"}):`;
    if (sim.ok && sim.analysis === "op") s += "\n" + sim.vectors.filter((v) => v.kind === "voltage").slice(0, 40).map((v) => `V(${v.netName}) = ${v.real[0]?.toPrecision(4)} V`).join("\n");
    if (sim.diagnostics.length) s += "\n" + sim.diagnostics.map((x) => `- [${x.severity}] ${x.message}`).join("\n");
  }
  return s;
}
