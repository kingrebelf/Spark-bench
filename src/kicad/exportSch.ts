// SparkBench project → KiCad 10 schematic (.kicad_sch) and project file (.kicad_pro).
// Token layout follows files written by KiCad 10.0 itself (demo schematics re-saved with
// `kicad-cli sch upgrade`). Connectivity is made explicit so KiCad sees exactly SparkBench's nets:
// every wire is split at each connection point lying on it (all connections are endpoint-to-endpoint),
// and any pin whose KiCad position differs from SparkBench's is bridged with net labels.
import { computeConnectivity } from "../core/connectivity";
import { pinWorldPosition, onSegment } from "../core/geometry";
import { getPart } from "../core/library";
import type { ComponentDef, ComponentInstance, Diagnostic, Point, Project } from "../core/types";
import { canonicalOrient, gridToMm, kicadTransform, ORIENTS, ptKey, resolveMapping, roundMm, sbToKicadOrient, stableUuid, type KicadOrient, type ResolvedMapping } from "./common";
import { arg, child, children, clone, list, num, str, sym, write, type SExpr, type SList } from "./sexpr";
import { simMapping } from "./simfields";
import { symbolInfo, unitPins, type SymbolInfo } from "./symbols";

export const SCH_VERSION = "20260306";
export const GENERATOR = "sparkbench";
export const GENERATOR_VERSION = "0.1";

export interface SymbolProvider {
  /** Embedded form of a library symbol ("Lib:Name"), or undefined when not installed. */
  symbol(libId: string): SList | undefined;
}

export interface ExportInput {
  project: Project;
  /** File stem shared by .kicad_pro / .kicad_sch / .kicad_pcb. */
  name: string;
  symbols: SymbolProvider;
  lookup?: (type: string) => ComponentDef | undefined;
  /** Keep the root sheet UUID of an existing schematic when updating it. */
  rootUuid?: string;
  eol?: "\n" | "\r\n";
}

export interface ExportedPart {
  componentId: string;
  ref: string;
  libId: string;
  footprint: string;
  /** SparkBench pin id → KiCad pin number. */
  pinMap: Record<string, string>;
  units: number[];
  symbolUuid: string;
  onBoard: boolean;
  simulatable: boolean;
  power: boolean;
  /** Set for simulation-only symbols (on_board=no), which KiCad leaves out of its board netlist. */
  simOnly?: { device: string; simPins: string };
}

export interface SchExport {
  text: string;
  rootUuid: string;
  parts: ExportedPart[];
  /** Expected KiCad connectivity: one entry per SparkBench net, as sorted "REF:pin" lists (power symbols omitted). */
  expectedNets: string[][];
  diagnostics: Diagnostic[];
  /** What was and wasn't carried over, in plain language. */
  notes: string[];
}

const SIM_DIRECTIVE = (p: Project): string => {
  const s = p.simulation;
  if (s.analysis === "tran") return `.tran ${s.tran.step} ${s.tran.stop}${s.tran.start && s.tran.start !== "0" ? ` ${s.tran.start}` : ""}${s.tran.uic ? " uic" : ""}`;
  if (s.analysis === "ac") return `.ac ${s.ac.sweep} ${s.ac.points} ${s.ac.start} ${s.ac.stop}`;
  return ".op";
};

const font = (size = 1.27) => list("font", list("size", num(size), num(size)));
const yesno = (b: boolean) => sym(b ? "yes" : "no");
const PAPERS: [string, number, number][] = [["A4", 297, 210], ["A3", 420, 297], ["A2", 594, 420], ["A1", 841, 594], ["A0", 1189, 841]];

interface PlacedPin { componentId: string; pinId: string; at: Point /* grid */ }

export function exportSchematic(input: ExportInput): SchExport {
  const { project } = input;
  const lookup = input.lookup ?? getPart;
  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];
  const conn = computeConnectivity(project, lookup);
  const seed = `${project.meta.created}|${project.meta.name}`;
  const rootUuid = input.rootUuid ?? stableUuid(`${seed}|root`);
  const projName = input.name;

  // ---------------------------------------------------------------- extents → sheet offset / paper
  const pts: Point[] = [];
  for (const c of project.schematic.components) {
    pts.push(c.position);
    const def = lookup(c.type);
    for (const p of def?.pins ?? []) pts.push(pinWorldPosition(c, def!, p.id)!);
  }
  for (const w of project.schematic.wires) pts.push(...w.points);
  for (const l of project.schematic.labels) pts.push(l.position);
  const minX = pts.length ? Math.min(...pts.map((p) => p.x)) : 0;
  const minY = pts.length ? Math.min(...pts.map((p) => p.y)) : 0;
  const maxX = pts.length ? Math.max(...pts.map((p) => p.x)) : 0;
  const maxY = pts.length ? Math.max(...pts.map((p) => p.y)) : 0;
  // Whole grid units so every pin stays on KiCad's 1.27 mm grid.
  const off = { x: 20 - minX, y: 20 - minY };
  const mm = (p: Point) => ({ x: gridToMm(p.x + off.x), y: gridToMm(p.y + off.y) });
  let extraX = maxX + 20; // free column for extra units (power units of multi-unit parts)
  const extraY = minY;

  // ---------------------------------------------------------------- symbols
  const libSymbols = new Map<string, SList>();
  const infos = new Map<string, SymbolInfo>();
  const getSym = (libId: string) => {
    if (!libSymbols.has(libId)) {
      const s = input.symbols.symbol(libId);
      if (!s) return undefined;
      libSymbols.set(libId, s);
      infos.set(libId, symbolInfo(s));
    }
    return { node: libSymbols.get(libId)!, info: infos.get(libId)! };
  };

  const symbolsOut: SList[] = [];
  const labelsOut: SList[] = [];
  const parts: ExportedPart[] = [];
  const placedPins: PlacedPin[] = []; // SparkBench pins whose KiCad pin lands on the same point
  const bridges: { at: Point /* mm */; net: string; ground: boolean; why: string }[] = [];
  let pwrCount = 0;
  const usedRefs = new Set<string>();
  const refCounters = new Map<string, number>();
  for (const c of project.schematic.components) usedRefs.add(c.ref);
  const seenRefs = new Set<string>();

  const groundSymbolId = "power:GND";
  const placePower = (libId: string, at: { x: number; y: number }, o: KicadOrient, uuidSeed: string, value?: string): boolean => {
    const s = getSym(libId);
    if (!s) return false;
    pwrCount++;
    const ref = `#PWR0${String(pwrCount).padStart(2, "0")}`;
    const uuid = stableUuid(uuidSeed);
    symbolsOut.push(placedSymbol({ libId, info: s.info, node: s.node, at, o, unit: 1, ref, value: value ?? s.info.props.Value ?? "", footprint: "",
      extraFields: {}, uuid, rootUuid, projName, inBom: s.info.inBom, onBoard: s.info.onBoard, excludeFromSim: false, pinUuidSeed: uuid }));
    return true;
  };

  for (const inst of project.schematic.components) {
    const def = lookup(inst.type);
    if (!def) {
      diagnostics.push({ severity: "error", code: "kicad-unknown-part", source: "kicad", componentIds: [inst.id],
        message: `${inst.ref} uses part type "${inst.type}", which this installation does not have, so it was not exported to KiCad.`,
        fix: "Install the library that provides it or replace the part, then export again." });
      continue;
    }
    if (def.role === "netlabel") { notes.push(`${inst.ref}: net-label part exported as nothing (it carries no connection in SparkBench).`); continue; }
    const m = resolveMapping(inst, def);
    if (!m.symbol) {
      diagnostics.push({ severity: "error", code: "kicad-no-symbol", source: "kicad", componentIds: [inst.id],
        message: `${inst.ref} (${def.name}) has no KiCad symbol, so it was not exported.`,
        fix: "Choose a KiCad symbol for it in the KiCad panel's mapping review." });
      continue;
    }
    const s = getSym(m.symbol);
    if (!s) {
      diagnostics.push({ severity: "error", code: "kicad-symbol-missing", source: "kicad", componentIds: [inst.id],
        message: `${inst.ref}: KiCad symbol "${m.symbol}" is not in the installed KiCad libraries, so it was not exported.`,
        fix: "Pick an installed symbol in the KiCad panel's mapping review." });
      continue;
    }
    const at = mm(inst.position);

    if (def.role === "ground") {
      const o = bestOrient(inst, def, m, s.info, m.unit, at, mm);
      placePower(m.symbol, at, o.orient, `${seed}|${inst.id}|sym`, s.info.props.Value || "GND");
      for (const p of def.pins) placedPins.push({ componentId: inst.id, pinId: p.id, at: pinWorldPosition(inst, def, p.id)! });
      continue;
    }

    // Reference: keep unless empty, duplicated or unusable in KiCad.
    let ref = inst.ref.trim();
    if (!ref || seenRefs.has(ref) || /[\s"]/.test(ref) || ref.endsWith("?")) {
      const prefix = def.refPrefix || "U";
      let n = refCounters.get(prefix) ?? 1;
      while (usedRefs.has(`${prefix}${n}`) || seenRefs.has(`${prefix}${n}`)) n++;
      refCounters.set(prefix, n + 1);
      const nr = `${prefix}${n}`;
      diagnostics.push({ severity: "warning", code: "kicad-ref-renamed", source: "kicad", componentIds: [inst.id],
        message: `${inst.ref || "(no reference)"} is ${ref ? "used twice" : "empty"}; exported to KiCad as ${nr}.`,
        fix: "Give every part a unique reference (e.g. R1, R2) so KiCad and SparkBench names match." });
      ref = nr;
    }
    seenRefs.add(ref);

    const sim = simMapping(def, inst, s.info.props, m.symbol);
    if (sim.note) notes.push(`${ref}: ${sim.note}`);
    const simOnly = !m.footprint && /^Simulation_SPICE:/.test(m.symbol);
    // A part with a footprint goes on the board even if its library symbol is marked simulation-only.
    const onBoard = m.footprint ? true : simOnly ? false : s.info.onBoard;
    const inBom = m.footprint ? true : simOnly ? false : s.info.inBom;
    if (simOnly) notes.push(`${ref}: simulation source; excluded from the board and BOM.`);
    const uuid = stableUuid(`${seed}|${inst.id}|sym`);
    const fields = { ...sim.fields, ...m.fields };
    const o = bestOrient(inst, def, m, s.info, m.unit, at, mm);
    const units = [m.unit, ...m.extraUnits.filter((u) => u !== m.unit)];
    symbolsOut.push(placedSymbol({ libId: m.symbol, info: s.info, node: s.node, at, o: o.orient, unit: m.unit, ref, value: sim.value,
      footprint: m.footprint, extraFields: fields, uuid, rootUuid, projName, inBom, onBoard,
      excludeFromSim: def.provenance === "none", pinUuidSeed: uuid }));

    const mainNumbers = new Set(unitPins(s.info, m.unit).map((p) => p.number));
    for (const p of def.pins) {
      const sbAt = pinWorldPosition(inst, def, p.id)!;
      const num = m.pinMap[p.id];
      const net = conn.pinNet.get(`${inst.id}:${p.id}`);
      const netObj = conn.nets.find((n) => n.name === net);
      if (num === undefined || !s.info.pins.some((x) => x.number === num)) {
        diagnostics.push({ severity: "error", code: "kicad-pin-unmapped", source: "kicad", componentIds: [inst.id],
          message: `${ref} pin "${p.name}" has no matching pin in KiCad symbol ${m.symbol}${num !== undefined ? ` (expected pin ${num})` : ""}; that connection is missing in KiCad.`,
          fix: "Choose a KiCad symbol whose pins match this part, or fix the part's KiCad pin map." });
        continue;
      }
      if (mainNumbers.has(num) && o.matched.has(p.id)) { placedPins.push({ componentId: inst.id, pinId: p.id, at: sbAt }); continue; }
      // Pin is elsewhere in KiCad (another unit or different geometry): bridge it with labels.
      const needsNet = !!netObj && (netObj.pins.length > 1 || netObj.wireIds.length > 0 || netObj.labelNames.length > 0);
      if (needsNet && !mainNumbers.has(num)) continue; // handled when the extra unit is placed
      if (needsNet) {
        const kp = unitPins(s.info, m.unit).find((x) => x.number === num)!;
        const t = kicadTransform(kp.x, kp.y, o.orient);
        bridges.push({ at: { x: roundMm(at.x + t.x), y: roundMm(at.y + t.y) }, net: net!, ground: !!netObj?.isGround, why: `${ref} pin ${num}` });
        bridges.push({ at: mm(sbAt), net: net!, ground: !!netObj?.isGround, why: `${ref} pin ${num} (SparkBench position)` });
        diagnostics.push({ severity: "warning", code: "kicad-pin-geometry", source: "kicad", componentIds: [inst.id],
          message: `${ref} pin ${num} sits at a different place in KiCad symbol ${m.symbol} than in SparkBench; it is connected with net labels "${net}" instead of a wire.`,
          fix: "Usually harmless. To get a clean drawing, use a part whose pin positions match the KiCad symbol." });
      }
    }

    // Extra units (e.g. op-amp power unit): placed beside the drawing, pins tied with net labels.
    for (const u of units.slice(1)) {
      if (u > s.info.unitCount) {
        diagnostics.push({ severity: "error", code: "kicad-unit-missing", source: "kicad", componentIds: [inst.id],
          message: `${ref}: KiCad symbol ${m.symbol} has no unit ${u}.`, fix: "Fix the part's KiCad unit settings." });
        continue;
      }
      const uat = { x: gridToMm(extraX + off.x), y: gridToMm(extraY + off.y) };
      extraX += 12;
      const uo: KicadOrient = { angle: 0, mirror: "" };
      symbolsOut.push(placedSymbol({ libId: m.symbol, info: s.info, node: s.node, at: uat, o: uo, unit: u, ref, value: sim.value,
        footprint: m.footprint, extraFields: fields, uuid: stableUuid(`${seed}|${inst.id}|unit${u}`), rootUuid, projName, inBom, onBoard,
        excludeFromSim: def.provenance === "none", pinUuidSeed: uuid }));
      const uNums = new Set(s.info.pins.filter((x) => x.unit === u).map((x) => x.number));
      for (const p of def.pins) {
        const num = m.pinMap[p.id];
        if (!num || !uNums.has(num) || mainNumbers.has(num)) continue;
        const net = conn.pinNet.get(`${inst.id}:${p.id}`)!;
        const netObj = conn.nets.find((n) => n.name === net);
        if (!netObj || (netObj.pins.length <= 1 && !netObj.wireIds.length && !netObj.labelNames.length)) continue;
        const kp = s.info.pins.find((x) => x.unit === u && x.number === num)!;
        const t = kicadTransform(kp.x, kp.y, uo);
        bridges.push({ at: { x: roundMm(uat.x + t.x), y: roundMm(uat.y + t.y) }, net, ground: netObj.isGround, why: `${ref} unit ${u} pin ${num}` });
        bridges.push({ at: mm(pinWorldPosition(inst, def, p.id)!), net, ground: netObj.isGround, why: `${ref} pin ${num}` });
      }
    }
    parts.push({ componentId: inst.id, ref, libId: m.symbol, footprint: m.footprint, pinMap: m.pinMap, units, symbolUuid: uuid,
      onBoard, simulatable: sim.simulatable, power: s.info.power,
      simOnly: onBoard ? undefined : { device: fields["Sim.Device"] ?? s.info.props["Sim.Device"] ?? "", simPins: fields["Sim.Pins"] ?? s.info.props["Sim.Pins"] ?? "" } });
  }

  // ---------------------------------------------------------------- labels (ground-named labels become GND symbols)
  for (const l of project.schematic.labels) {
    const at = mm(l.position);
    const n = l.name.trim();
    if (/^(gnd|0)$/i.test(n)) {
      if (!placePower(groundSymbolId, at, { angle: 0, mirror: "" }, `${seed}|${l.id}|gnd`, "GND"))
        diagnostics.push({ severity: "error", code: "kicad-symbol-missing", source: "kicad", message: "The KiCad power:GND symbol is not installed; ground labels were not exported.", fix: "Repair the KiCad installation." });
      continue;
    }
    labelsOut.push(labelNode(n, at, ((360 - l.rotation) % 360), stableUuid(`${seed}|${l.id}|label`)));
  }
  const bridgeSeen = new Set<string>();
  for (const b of bridges) {
    const k = `${b.at.x},${b.at.y}|${b.net}`;
    if (bridgeSeen.has(k)) continue;
    bridgeSeen.add(k);
    if (b.ground) placePower(groundSymbolId, b.at, { angle: 0, mirror: "" }, `${seed}|bridge|${k}`, "GND");
    else labelsOut.push(labelNode(b.net, b.at, 0, stableUuid(`${seed}|bridge|${k}`)));
  }

  // ---------------------------------------------------------------- wires, split at every connection point
  const connPts = new Map<string, Point>();
  const addPt = (p: Point) => connPts.set(ptKey(p), p);
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    if (!def || def.role === "netlabel") continue;
    for (const p of def.pins) addPt(pinWorldPosition(c, def, p.id)!);
  }
  for (const w of project.schematic.wires) w.points.forEach(addPt);
  for (const l of project.schematic.labels) addPt(l.position);
  const allPts = [...connPts.values()];
  const wiresOut: SList[] = [];
  const wireEnds = new Map<string, number>();
  const pinAt = new Map<string, number>();
  for (const pp of placedPins) pinAt.set(ptKey(pp.at), (pinAt.get(ptKey(pp.at)) ?? 0) + 1);
  for (const w of project.schematic.wires) {
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1], b = w.points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const inner = allPts.filter((p) => onSegment(p, a, b) && ptKey(p) !== ptKey(a) && ptKey(p) !== ptKey(b))
        .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
      const chain = [a, ...inner, b];
      for (let j = 1; j < chain.length; j++) {
        const p = chain[j - 1], q = chain[j];
        wireEnds.set(ptKey(p), (wireEnds.get(ptKey(p)) ?? 0) + 1);
        wireEnds.set(ptKey(q), (wireEnds.get(ptKey(q)) ?? 0) + 1);
        const mp = mm(p), mq = mm(q);
        wiresOut.push(list("wire",
          list("pts", list("xy", num(mp.x), num(mp.y)), list("xy", num(mq.x), num(mq.y))),
          list("stroke", list("width", num(0)), list("type", "default")),
          list("uuid", str(stableUuid(`${seed}|${w.id}|${i}|${j}`)))));
      }
    }
  }
  const junctionsOut: SList[] = [];
  for (const [k, n] of wireEnds) {
    const pins = pinAt.get(k) ?? 0;
    if (n >= 3 || (n >= 2 && pins >= 1)) {
      const [x, y] = k.split(",").map(Number);
      const p = mm({ x, y });
      junctionsOut.push(list("junction", list("at", num(p.x), num(p.y)), list("diameter", num(0)), list("color", num(0), num(0), num(0), num(0)),
        list("uuid", str(stableUuid(`${seed}|junction|${k}`)))));
    }
  }

  // ---------------------------------------------------------------- simulation directive
  const textsOut: SList[] = [];
  const dir = SIM_DIRECTIVE(project);
  textsOut.push(list("text", str(dir), list("exclude_from_sim", "no"), list("at", num(gridToMm(off.x + minX)), num(gridToMm(off.y + minY) - 7.62), num(0)),
    list("effects", font(), list("justify", "left", "bottom")), list("uuid", str(stableUuid(`${seed}|simdirective`)))));
  notes.push(`Simulation command written as a schematic text directive: ${dir}`);
  if (project.simulation.probes.length) notes.push("Probes and plot settings are SparkBench-only and are not transferred.");
  if (project.models.length) notes.push(`${project.models.length} imported SPICE model(s) are not copied into the KiCad project; parts that use them need Sim.Library set in KiCad.`);

  // ---------------------------------------------------------------- paper and file assembly
  const wMm = gridToMm(Math.max(extraX, maxX) - minX + 40), hMm = gridToMm(maxY - minY + 40);
  const paper = PAPERS.find(([, w, h]) => wMm <= w && hMm <= h)?.[0] ?? "A0";
  const byUuid = (a: SList, b: SList) => (arg(child(a, "uuid")) ?? "").localeCompare(arg(child(b, "uuid")) ?? "");
  const libSorted = [...libSymbols.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
  const root = list("kicad_sch",
    list("version", SCH_VERSION),
    list("generator", str(GENERATOR)),
    list("generator_version", str(GENERATOR_VERSION)),
    list("uuid", str(rootUuid)),
    list("paper", str(paper)),
    list("title_block", list("title", str(project.meta.name)), list("comment", num(1), str("Exported from SparkBench"))),
    list("lib_symbols", ...libSorted),
    ...textsOut.sort(byUuid),
    ...junctionsOut.sort(byUuid),
    ...wiresOut.sort(byUuid),
    ...labelsOut.sort(byUuid),
    ...symbolsOut.sort(byUuid),
    list("sheet_instances", list("path", str("/"), list("page", str("1")))),
  );

  // Expected connectivity for verification against KiCad's own netlist.
  const partByComp = new Map(parts.map((p) => [p.componentId, p]));
  const expectedNets: string[][] = [];
  for (const n of conn.nets) {
    const nodes = new Set<string>();
    for (const pr of n.pins) {
      const p = partByComp.get(pr.componentId);
      if (!p || p.power) continue;
      const k = p.pinMap[pr.pinId];
      if (k !== undefined) nodes.add(`${p.ref}:${k}`);
    }
    if (nodes.size) expectedNets.push([...nodes].sort());
  }
  return { text: write(root, input.eol), rootUuid, parts, expectedNets, diagnostics, notes };
}

/** Pick the KiCad orientation that puts the most mapped pins exactly where SparkBench has them. */
function bestOrient(inst: ComponentInstance, def: ComponentDef, m: ResolvedMapping, info: SymbolInfo, unit: number,
  at: { x: number; y: number }, mm: (p: Point) => { x: number; y: number }): { orient: KicadOrient; matched: Set<string> } {
  const pins = unitPins(info, unit);
  const pref = sbToKicadOrient(inst.rotation, inst.mirror);
  const order = [pref, ...ORIENTS.filter((o) => o.angle !== pref.angle || o.mirror !== pref.mirror)];
  let best = { orient: pref, matched: new Set<string>() };
  for (const o of order) {
    const matched = new Set<string>();
    for (const p of def.pins) {
      const kp = pins.find((x) => x.number === m.pinMap[p.id]);
      if (!kp) continue;
      const t = kicadTransform(kp.x, kp.y, o);
      const want = mm(pinWorldPosition(inst, def, p.id)!);
      if (Math.abs(at.x + t.x - want.x) < 1e-3 && Math.abs(at.y + t.y - want.y) < 1e-3) matched.add(p.id);
    }
    if (matched.size > best.matched.size) best = { orient: o, matched };
    if (matched.size === def.pins.length) break;
  }
  return best;
}

function labelNode(name: string, at: { x: number; y: number }, angle: number, uuid: string): SList {
  return list("label", str(name), list("at", num(at.x), num(at.y), num(angle)),
    list("effects", font(), list("justify", angle === 180 || angle === 270 ? "right" : "left", "bottom")),
    list("uuid", str(uuid)));
}

interface PlaceArgs {
  libId: string; info: SymbolInfo; node: SList; at: { x: number; y: number }; o: KicadOrient; unit: number;
  ref: string; value: string; footprint: string; extraFields: Record<string, string>; uuid: string; rootUuid: string; projName: string;
  inBom: boolean; onBoard: boolean; excludeFromSim: boolean; pinUuidSeed: string;
}

function placedSymbol(a: PlaceArgs): SList {
  const canon = canonicalOrient(a.o);
  const libProps = children(a.node, "property");
  const values: Record<string, string> = {};
  for (const p of libProps) values[arg(p)!] = arg(p, 2) ?? "";
  values.Reference = a.ref;
  values.Value = a.value;
  values.Footprint = a.footprint;
  const order: string[] = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
  for (const p of libProps) { const k = arg(p)!; if (!order.includes(k) && !k.startsWith("ki_")) order.push(k); }
  for (const k of Object.keys(a.extraFields)) if (!order.includes(k)) order.push(k);
  const props: SList[] = [];
  for (const k of order) {
    const lp = libProps.find((p) => arg(p) === k);
    const v = k in a.extraFields ? a.extraFields[k] : values[k] ?? "";
    const lat = child(lp, "at");
    const lx = lat ? Number(arg(lat, 1)) : 0, ly = lat ? Number(arg(lat, 2)) : 0, la = lat ? Number(arg(lat, 3) ?? 0) : 0;
    const t = kicadTransform(lx, ly, a.o);
    const angle = (la + a.o.angle) % 180;
    const hidden = lp ? (child(lp, "hide") ? arg(child(lp, "hide")) === "yes" : false) : true;
    const effects = child(lp, "effects") ? clone(child(lp, "effects")!) : list("effects", font());
    const hide = hidden || k === "Footprint" || k === "Datasheet" || k === "Description" || (k.startsWith("Sim.") && k !== "Sim.Params");
    props.push(list("property", str(k), str(v),
      list("at", num(roundMm(a.at.x + t.x)), num(roundMm(a.at.y + t.y)), num(angle)),
      hide ? list("hide", "yes") : null,
      list("show_name", "no"), list("do_not_autoplace", "no"),
      effects));
  }
  const pinNums: string[] = [];
  // KiCad lists every pin of the symbol (all units) on each placed unit.
  for (const p of a.info.pins) if ((p.bodyStyle === 0 || p.bodyStyle === 1) && !pinNums.includes(p.number)) pinNums.push(p.number);
  const items: (SExpr | null)[] = [
    list("lib_id", str(a.libId)),
    list("at", num(a.at.x), num(a.at.y), num(canon.angle)),
    canon.mirror ? list("mirror", canon.mirror) : null,
    list("unit", num(a.unit)),
    list("body_style", num(1)),
    list("exclude_from_sim", yesno(a.excludeFromSim)),
    list("in_bom", yesno(a.inBom)),
    list("on_board", yesno(a.onBoard)),
    list("in_pos_files", yesno(a.onBoard)),
    list("dnp", "no"),
    list("uuid", str(a.uuid)),
    ...props,
    ...pinNums.map((n) => list("pin", str(n), list("uuid", str(stableUuid(`${a.uuid}|pin|${n}`))))),
    list("instances", list("project", str(a.projName), list("path", str(`/${a.rootUuid}`), list("reference", str(a.ref)), list("unit", num(a.unit))))),
  ];
  return { t: "list", items: [sym("symbol"), ...items.filter((x): x is SExpr => !!x)] };
}

// ------------------------------------------------------------------ .kicad_pro

/** Project file based on KiCad's own template (share/kicad/template/kicad.kicad_pro) when available. */
export function exportProjectFile(name: string, templateJson?: string, existingJson?: string): string {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(existingJson ?? templateJson ?? ""); } catch { obj = {}; }
  const meta = (obj.meta as Record<string, unknown>) ?? {};
  obj.meta = { ...meta, filename: `${name}.kicad_pro`, version: meta.version ?? 1 };
  return JSON.stringify(obj, null, 2) + "\n";
}
