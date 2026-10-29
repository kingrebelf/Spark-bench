// KiCad schematic (.kicad_sch) → SparkBench project.
// Symbols map back to library parts through ComponentDef.kicad (exact lib_id first, then the same symbol
// name with matching pin geometry, e.g. a project-local copy of Device:R). Symbols that match no part
// are NOT imported (SparkBench has no honest stand-in for an unknown part); the report lists them and
// the connections they leave open. Hierarchical sheets, buses and no-connect flags are reported, not imported.
import { allParts, getPart } from "../core/library";
import { createProject, newId } from "../core/project";
import { pinWorldPosition, onSegment } from "../core/geometry";
import { parseSI } from "../core/units";
import type { ComponentDef, ComponentInstance, Point, Project, PropValue, Rotation, Wire } from "../core/types";
import { kicadTransform, ptKey, type KicadOrient } from "./common";
import { arg, child, children, head, numArg, parse, type SList } from "./sexpr";
import { splitLibId, symbolInfo, unitPins, type SymbolInfo } from "./symbols";

export interface ImportedPartReport { ref: string; libId: string; part: string; how: "lib_id" | "symbol-name"; notes: string[] }
export interface SkippedReport { ref: string; libId: string; reason: string }

export interface ImportReport {
  fileVersion: string;
  generator: string;
  imported: ImportedPartReport[];
  notImported: SkippedReport[];
  /** Power symbols turned into ground parts or net labels. */
  power: { ref: string; net: string; as: "ground" | "label" }[];
  counts: { wires: number; labels: number; junctions: number };
  /** Things in the file that SparkBench does not carry over (sheets, buses, graphics, ...). */
  unsupported: string[];
  warnings: string[];
  /** Simulation command found in a text directive, if any. */
  simulation?: string;
}

export interface ImportResult { project: Project; report: ImportReport }

const SB_ROTATIONS: Rotation[] = [0, 90, 180, 270];
const GROUND_NAMES = /^(gnd|0)$/i;

interface Candidate { def: ComponentDef; how: "lib_id" | "symbol-name" }

function candidatesFor(libId: string, defs: ComponentDef[]): Candidate[] {
  const exact = defs.filter((d) => d.kicad?.symbol === libId).map((def) => ({ def, how: "lib_id" as const }));
  if (exact.length) return exact;
  const name = splitLibId(libId).name;
  return defs.filter((d) => d.kicad && splitLibId(d.kicad.symbol).name === name).map((def) => ({ def, how: "symbol-name" as const }));
}

export function importSchematic(text: string, opts: { name?: string; lookup?: (t: string) => ComponentDef | undefined; parts?: ComponentDef[] } = {}): ImportResult {
  const root = parse(text);
  if (head(root) !== "kicad_sch") throw new Error("Not a KiCad schematic (.kicad_sch) file.");
  const lookup = opts.lookup ?? getPart;
  const defs = opts.parts ?? allParts();
  const project = createProject(opts.name ?? "Imported from KiCad");
  const report: ImportReport = {
    fileVersion: arg(child(root, "version")) ?? "?", generator: arg(child(root, "generator")) ?? "?",
    imported: [], notImported: [], power: [], counts: { wires: 0, labels: 0, junctions: 0 }, unsupported: [], warnings: [],
  };
  const ver = Number(report.fileVersion);
  if (ver && ver < 20211123) report.warnings.push(`File format ${report.fileVersion} is older than KiCad 6; re-save it in KiCad 10 first if anything looks wrong.`);

  // Library symbols embedded in the file.
  const lib = new Map<string, SymbolInfo>();
  for (const s of children(child(root, "lib_symbols"), "symbol")) lib.set(arg(s)!, symbolInfo(s));

  // KiCad mm → grid. Off-grid coordinates are rounded and reported.
  let offGrid = 0;
  const g = (mm: number) => { const v = mm / 1.27; const r = Math.round(v); if (Math.abs(v - r) > 1e-3) offGrid++; return r; };
  const gp = (x: number, y: number): Point => ({ x: g(x), y: g(y) });

  const extraWires: Wire[] = [];
  const extraLabels: { name: string; at: Point }[] = [];
  const pending = new Map<string, { inst: ComponentInstance; def: ComponentDef }>(); // ref → main instance (for extra units)
  const unitLater: { ref: string; unit: number; info: SymbolInfo; at: { x: number; y: number }; o: KicadOrient }[] = [];

  for (const s of children(root, "symbol")) {
    const libId = arg(child(s, "lib_id")) ?? "";
    const at = child(s, "at");
    const ax = numArg(at, 1), ay = numArg(at, 2), angle = (Number(arg(at, 3) ?? 0) % 360 + 360) % 360;
    const mir = arg(child(s, "mirror")) as "x" | "y" | undefined;
    const o: KicadOrient = { angle: angle as KicadOrient["angle"], mirror: mir ?? "" };
    const unit = Number(arg(child(s, "unit")) ?? 1);
    const props: Record<string, string> = {};
    for (const p of children(s, "property")) props[arg(p)!] = arg(p, 2) ?? "";
    const inst = child(child(child(s, "instances"), "project"), "path");
    const ref = arg(child(inst, "reference")) ?? props.Reference ?? "?";
    const info = lib.get(libId);
    if (!info) { report.notImported.push({ ref, libId, reason: "its symbol is missing from the file's lib_symbols" }); continue; }
    const pinAt = (number: string) => {
      const p = unitPins(info, unit).find((x) => x.number === number);
      if (!p) return undefined;
      const t = kicadTransform(p.x, p.y, o);
      return { x: ax + t.x, y: ay + t.y };
    };

    if (info.power) {
      const net = props.Value || splitLibId(libId).name;
      const pin = unitPins(info, unit)[0];
      const pt = pin ? pinAt(pin.number)! : { x: ax, y: ay };
      if (GROUND_NAMES.test(net)) {
        const gd = defs.find((d) => d.role === "ground");
        if (gd) {
          const c: ComponentInstance = { id: newId("c"), type: gd.id, ref, position: gp(pt.x, pt.y), rotation: 0, props: {} };
          // the ground part's pin is at its origin
          const d0 = gd.pins[0];
          c.position = { x: c.position.x - d0.x, y: c.position.y - d0.y };
          project.schematic.components.push(c);
          report.power.push({ ref, net, as: "ground" });
          continue;
        }
      }
      extraLabels.push({ name: net, at: gp(pt.x, pt.y) });
      report.power.push({ ref, net, as: "label" });
      continue;
    }

    // Additional unit of an already-imported multi-unit part?
    const main = pending.get(ref);
    if (main || candidatesFor(libId, defs).some((c) => (c.def.kicad?.extraUnits ?? []).includes(unit))) {
      unitLater.push({ ref, unit, info, at: { x: ax, y: ay }, o });
      continue;
    }

    const cands = candidatesFor(libId, defs).filter((c) => (c.def.kicad?.unit ?? 1) === unit);
    let best: { def: ComponentDef; how: Candidate["how"]; rot: Rotation; mirror: boolean; pos: Point; matched: number } | null = null;
    for (const c of cands) {
      const pm = c.def.kicad!.pinMap;
      if (!c.def.pins.every((p) => pm[p.id] !== undefined && info.pins.some((x) => x.number === pm[p.id]))) continue;
      const pos = gp(ax, ay);
      for (const mirror of [false, true]) for (const rot of SB_ROTATIONS) {
        const trial: ComponentInstance = { id: "", type: c.def.id, ref, position: pos, rotation: rot, mirror, props: {} };
        let matched = 0;
        for (const p of c.def.pins) {
          const k = pinAt(pm[p.id]);
          if (!k) continue;
          const w = pinWorldPosition(trial, c.def, p.id)!;
          if (Math.abs(w.x * 1.27 - k.x) < 0.01 && Math.abs(w.y * 1.27 - k.y) < 0.01) matched++;
        }
        if (!best || matched > best.matched || (matched === best.matched && c.how === "lib_id" && best.how !== "lib_id"))
          best = { def: c.def, how: c.how, rot, mirror, pos, matched };
      }
    }
    if (!best) {
      report.notImported.push({ ref, libId, reason: cands.length
        ? "a SparkBench part uses this symbol, but its pin numbers do not match"
        : unit > 1 && candidatesFor(libId, defs).length ? `unit ${unit} of a multi-unit symbol; the SparkBench part models only unit ${candidatesFor(libId, defs)[0].def.kicad?.unit ?? 1}`
        : "no SparkBench part maps to this KiCad symbol" });
      continue;
    }
    const def = best.def;
    const c: ComponentInstance = { id: newId("c"), type: def.id, ref, position: best.pos, rotation: best.rot, mirror: best.mirror || undefined, props: {} };
    if (!c.mirror) delete c.mirror;
    const notes: string[] = [];
    Object.assign(c.props, propsFromKicad(def, props, notes));
    const k: NonNullable<ComponentInstance["kicad"]> = {};
    if (best.how === "symbol-name") k.symbol = libId;
    if ((props.Footprint ?? "") !== (def.kicad?.footprint ?? "")) k.footprint = props.Footprint ?? "";
    const std = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description"]);
    const fields = Object.fromEntries(Object.entries(props).filter(([n, v]) => !std.has(n) && !n.startsWith("Sim.") && !n.startsWith("ki_") && v !== "" && v !== info.props[n]));
    if (Object.keys(fields).length) k.fields = fields;
    if (Object.keys(k).length) c.kicad = k;
    // Pins whose geometry differs: connect SparkBench pin to the KiCad pin position with a wire.
    if (best.matched < def.pins.length) {
      for (const p of def.pins) {
        const kp = pinAt(def.kicad!.pinMap[p.id]);
        if (!kp) continue;
        const w = pinWorldPosition(c, def, p.id)!;
        const target = gp(kp.x, kp.y);
        if (w.x === target.x && w.y === target.y) continue;
        extraWires.push({ id: newId("w"), points: w.x === target.x || w.y === target.y ? [w, target] : [w, { x: w.x, y: target.y }, target] });
      }
      notes.push(`pin positions differ from the SparkBench part; ${def.pins.length - best.matched} pin(s) joined with short wires (check the drawing)`);
    }
    project.schematic.components.push(c);
    pending.set(ref, { inst: c, def });
    report.imported.push({ ref, libId, part: def.name, how: best.how, notes });
  }

  // Extra units (e.g. the power unit of an op-amp): tie their pins to the main instance with net labels.
  for (const u of unitLater) {
    const main = pending.get(u.ref);
    if (!main) { report.notImported.push({ ref: u.ref, libId: u.info.libId, reason: `unit ${u.unit} found without its main unit` }); continue; }
    const pm = main.def.kicad!.pinMap;
    if (!(main.def.kicad?.extraUnits ?? []).includes(u.unit)) {
      report.notImported.push({ ref: u.ref, libId: u.info.libId, reason: `unit ${u.unit}; the SparkBench part models only unit ${main.def.kicad?.unit ?? 1}` });
      continue;
    }
    for (const p of main.def.pins) {
      const kp = unitPins(u.info, u.unit).find((x) => x.unit === u.unit && x.number === pm[p.id]);
      if (!kp) continue;
      const t = kicadTransform(kp.x, kp.y, u.o);
      const name = `${u.ref}_${kp.number}`;
      extraLabels.push({ name, at: gp(u.at.x + t.x, u.at.y + t.y) });
      extraLabels.push({ name, at: pinWorldPosition(main.inst, main.def, p.id)! });
    }
    const r = report.imported.find((x) => x.ref === u.ref);
    r?.notes.push(`unit ${u.unit} pins connected through labels ${u.ref}_<pin>`);
  }

  // Wires (split at junction dots so crossings with a junction connect, as in KiCad).
  const junctions = children(root, "junction").map((j) => gp(numArg(child(j, "at"), 1), numArg(child(j, "at"), 2)));
  report.counts.junctions = junctions.length;
  for (const w of children(root, "wire")) {
    const pts = children(child(w, "pts"), "xy").map((xy) => gp(numArg(xy, 1), numArg(xy, 2)));
    if (pts.length < 2) continue;
    const out: Point[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const inner = junctions.filter((j) => onSegment(j, a, b) && ptKey(j) !== ptKey(a) && ptKey(j) !== ptKey(b))
        .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
      out.push(...inner, b);
    }
    project.schematic.wires.push({ id: newId("w"), points: out });
    report.counts.wires++;
  }
  project.schematic.wires.push(...extraWires);

  const labelRot = (a: number): Rotation => (((360 - a) % 360) as Rotation);
  for (const kind of ["label", "global_label", "hierarchical_label"]) {
    for (const l of children(root, kind)) {
      const name = arg(l) ?? "";
      const at = child(l, "at");
      project.schematic.labels.push({ id: newId("l"), name, position: gp(numArg(at, 1), numArg(at, 2)), rotation: labelRot(Number(arg(at, 3) ?? 0)) });
      report.counts.labels++;
      if (GROUND_NAMES.test(name)) report.warnings.push(`Label "${name}" is treated as ground in SparkBench (in KiCad a label named ${name} is not joined to the GND power net).`);
    }
    const n = children(root, kind).length;
    if (n && kind === "global_label") report.warnings.push(`${n} global label(s) imported as ordinary net labels (single sheet: same behaviour).`);
    if (n && kind === "hierarchical_label") report.warnings.push(`${n} hierarchical label(s) imported as net labels; the parent sheet connection is not imported.`);
  }
  for (const l of extraLabels) project.schematic.labels.push({ id: newId("l"), name: l.name, position: l.at, rotation: 0 });

  // Simulation directive.
  for (const t of children(root, "text")) {
    const s = (arg(t) ?? "").trim();
    const m = /^\.(tran|ac|op)\b(.*)$/im.exec(s);
    if (!m || arg(child(t, "exclude_from_sim")) === "yes") continue;
    const a = m[2].trim().split(/\s+/).filter(Boolean);
    if (m[1].toLowerCase() === "tran" && a.length >= 2) {
      project.simulation.analysis = "tran";
      project.simulation.tran = { step: a[0], stop: a[1], ...(a[2] && !/uic/i.test(a[2]) ? { start: a[2] } : {}), ...(a.some((x) => /^uic$/i.test(x)) ? { uic: true } : {}) };
    } else if (m[1].toLowerCase() === "ac" && a.length >= 4 && ["dec", "oct", "lin"].includes(a[0].toLowerCase())) {
      project.simulation.analysis = "ac";
      project.simulation.ac = { sweep: a[0].toLowerCase() as "dec" | "oct" | "lin", points: Number(a[1]), start: a[2], stop: a[3] };
    } else if (m[1].toLowerCase() === "op") project.simulation.analysis = "op";
    else continue;
    report.simulation = `.${m[1]} ${m[2].trim()}`.trim();
    break;
  }

  // Unsupported content, reported plainly.
  const sheets = children(root, "sheet");
  if (sheets.length) {
    const names = sheets.map((sh) => children(sh, "property").find((p) => arg(p) === "Sheetname" || arg(p) === "Sheet name")).map((p) => arg(p, 2) ?? "?");
    report.unsupported.push(`${sheets.length} hierarchical sheet(s) (${names.join(", ")}): hierarchical designs are not supported; only the top sheet was imported and connections into the sheets are missing.`);
  }
  const count = (h: string) => children(root, h).length;
  if (count("bus") || count("bus_entry")) report.unsupported.push(`${count("bus")} bus(es) and ${count("bus_entry")} bus entr(y/ies): buses are not supported; wires attached to them may be open.`);
  if (count("no_connect")) report.unsupported.push(`${count("no_connect")} no-connect flag(s) (no effect on simulation).`);
  const gfx = ["polyline", "rectangle", "circle", "arc", "image", "text_box", "table"].reduce((n, h) => n + count(h), 0);
  if (gfx) report.unsupported.push(`${gfx} drawing item(s) (graphics, text boxes, images) are not imported.`);
  const texts = children(root, "text").length - (report.simulation ? 1 : 0);
  if (texts > 0) report.unsupported.push(`${texts} text note(s) are not imported.`);
  if (offGrid) report.warnings.push(`${offGrid} coordinate(s) were not on the 1.27 mm grid and were rounded; check connections near them.`);
  if (report.notImported.length) report.warnings.push(`${report.notImported.length} symbol(s) were not imported, so their pins' connections are missing; see the list below.`);

  // Shift to start near the origin (whole grid units keep everything on grid).
  const pts: Point[] = [...project.schematic.components.map((c) => c.position), ...project.schematic.wires.flatMap((w) => w.points), ...project.schematic.labels.map((l) => l.position)];
  if (pts.length) {
    const dx = 10 - Math.min(...pts.map((p) => p.x)), dy = 10 - Math.min(...pts.map((p) => p.y));
    for (const c of project.schematic.components) c.position = { x: c.position.x + dx, y: c.position.y + dy };
    for (const w of project.schematic.wires) w.points = w.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    for (const l of project.schematic.labels) l.position = { x: l.position.x + dx, y: l.position.y + dy };
  }
  void lookup;
  return { project, report };
}

/** KiCad Value / Sim.Params → SparkBench props for the part. */
function propsFromKicad(def: ComponentDef, props: Record<string, string>, notes: string[]): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  const params = Object.fromEntries((props["Sim.Params"] ?? "").trim().split(/\s+/).filter((x) => x.includes("=")).map((x) => {
    const [k, ...v] = x.split("="); return [k.toLowerCase(), v.join("=").replace(/^"|"$/g, "")];
  }));
  const has = (k: string) => def.props.some((p) => p.key === k);
  const value = props.Value ?? "";
  if (props["Sim.Library"] || props["Sim.Name"]) {
    notes.push(`KiCad simulation model ${props["Sim.Name"] ?? ""}${props["Sim.Library"] ? ` from ${props["Sim.Library"]}` : ""} was not imported; SparkBench simulates it with its own "${def.name}" model (${def.provenance})`);
  }
  switch (def.id) {
    case "vdc":
      if (params.dc ?? (!Number.isNaN(parseSI(value)) ? value : undefined)) out.value = params.dc ?? value;
      if (params.ac) out.acmag = params.ac;
      return out;
    case "vsine":
      if (params.dc) out.offset = params.dc;
      if (params.ampl) out.amplitude = params.ampl;
      if (params.f) out.frequency = params.f;
      if (params.ac) out.acmag = params.ac;
      if (params.ph) out.phase = params.ph;
      if (!props["Sim.Params"]) notes.push("no Sim.Params; default source settings used");
      return out;
    case "vpulse": {
      if (params.y1) out.low = params.y1;
      if (params.y2) out.high = params.y2;
      if (params.td) out.delay = params.td;
      if (params.tr) out.edge = params.tr;
      const per = parseSI(params.per ?? ""), tw = parseSI(params.tw ?? ""), tr = parseSI(params.tr ?? "0");
      if (per > 0) out.frequency = String(Number((1 / per).toPrecision(6)));
      if (per > 0 && tw > 0) out.duty = String(Number((((tw + (tr || 0)) / per) * 100).toPrecision(4)));
      return out;
    }
  }
  if (has("value") && value && !value.startsWith("${")) {
    if (!Number.isNaN(parseSI(value))) out.value = value;
    else notes.push(`value "${value}" is not a number SparkBench understands; the part default was kept`);
  }
  return out;
}

/** Expected KiCad connectivity of an imported project, as "REF:kicadPin" groups (for verification). */
export function importedPartition(project: Project, conn: { nets: { pins: { componentId: string; pinId: string }[] }[] }, lookup: (t: string) => ComponentDef | undefined = getPart): string[][] {
  const byId = new Map(project.schematic.components.map((c) => [c.id, c]));
  const out: string[][] = [];
  for (const n of conn.nets) {
    const g = new Set<string>();
    for (const p of n.pins) {
      const c = byId.get(p.componentId);
      const def = c && lookup(c.type);
      if (!c || !def || def.role === "ground" || !def.kicad) continue;
      g.add(`${c.ref}:${def.kicad.pinMap[p.pinId]}`);
    }
    if (g.size) out.push([...g].sort());
  }
  return out;
}

export type { SList };
