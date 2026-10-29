// PCB generation through KiCad's bundled pcbnew, checked by parsing the board and running kicad-cli DRC.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Builder } from "./helpers";
import { opampCircuit } from "./kicadHelpers";
import { exportProjectFile, exportSchematic } from "../src/kicad/exportSch";
import { findKicad } from "../src/kicad/node/install";
import { KicadLibraries, projectLibTables } from "../src/kicad/node/libs";
import { splitLibId } from "../src/kicad/symbols";
import { exportNetlist, runDrc, writeText } from "../src/kicad/node/cli";
import { generatePcb } from "../src/kicad/node/pcb";
import { arg, child, children, parse } from "../src/kicad/sexpr";
import { parseKicadNetlist } from "../src/kicad/netlist";
import type { Project } from "../src/core/types";

const kicad = findKicad();
const libs = kicad ? new KicadLibraries(kicad) : null;
const canRun = !!kicad?.python;

async function build(project: Project, name: string, dir?: string) {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), `sb-pcb-${name}-`));
  const ex = exportSchematic({ project, name, symbols: libs! });
  const sch = path.join(dir, `${name}.kicad_sch`);
  await writeText(sch, ex.text);
  await writeText(path.join(dir, `${name}.kicad_pro`), exportProjectFile(name));
  const t = projectLibTables(libs!, ex.parts.map((p) => splitLibId(p.libId).lib), ex.parts.map((p) => splitLibId(p.footprint).lib));
  if (t) { await writeText(path.join(dir, "sym-lib-table"), t.sym); await writeText(path.join(dir, "fp-lib-table"), t.fp); }
  const netlist = await exportNetlist(kicad!, sch);
  return { dir, ex, sch, netlist };
}

function rcNetwork() {
  const b = new Builder();
  const V = b.place("vdc", "V1", 0, 0, { value: "5" });
  let prev = b.pin(V, "1");
  for (let i = 1; i <= 6; i++) {
    const r = b.place("resistor", `R${i}`, i * 8, 0, {}, 90);
    b.wire(prev, b.pin(r, "1"));
    const c = b.place("capacitor", `C${i}`, i * 8 + 3, 6);
    b.wire(b.pin(r, "2"), b.pin(c, "1"));
    b.label("GND", b.pin(c, "2"));
    prev = b.pin(r, "2");
  }
  b.label("GND", b.pin(V, "2"));
  // An LED carries Sim.* fields, which must reach the footprint for schematic parity.
  const D = b.place("led", "D1", 70, 0, {}, 90);
  b.label("GND", b.pin(D, "K"));
  b.wire(prev, { x: prev.x, y: -6 }, { x: 67, y: -6 }, { x: 67, y: 0 });
  b.label("led", { x: 67, y: 0 }); b.label("led", b.pin(D, "A"));
  return b.project;
}

describe.skipIf(!canRun)("PCB generation (pcbnew)", () => {
  it("places every footprint with KiCad's nets, inside an Edge.Cuts outline, unrouted", async () => {
    const { dir, netlist } = await build(rcNetwork(), "rc");
    const pcbPath = path.join(dir, "rc.kicad_pcb");
    const res = await generatePcb(kicad!, libs!, { pcbPath, netlistText: netlist, update: false });
    expect(res.skipped).toEqual([]);
    expect(res.placed.map((p) => p.ref).sort()).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "D1", "R1", "R2", "R3", "R4", "R5", "R6"].sort());

    const board = parse(await fs.readFile(pcbPath, "utf8"));
    const fps = children(board, "footprint");
    expect(fps.length).toBe(13);
    // Pad nets equal KiCad's netlist.
    const nl = parseKicadNetlist(netlist);
    const expected = new Map<string, string>();
    for (const n of nl.nets) for (const d of n.nodes) expected.set(`${d.ref}:${d.pin}`, n.name);
    let pads = 0;
    for (const fp of fps) {
      const ref = arg(children(fp, "property").find((p) => arg(p) === "Reference"), 2)!;
      for (const pad of children(fp, "pad")) {
        pads++;
        expect(arg(child(pad, "net"))).toBe(expected.get(`${ref}:${arg(pad)}`));
      }
      // Linked to the schematic symbol so KiCad's Update PCB matches it.
      expect(arg(child(fp, "path"))).toMatch(/^\/[0-9a-f-]{36}$/);
    }
    expect(pads).toBe(26);
    const outline = children(board, "gr_rect").filter((r) => arg(child(r, "layer")) === "Edge.Cuts");
    expect(outline.length).toBe(1);
    expect(children(board, "segment").length).toBe(0);
    // Footprints inside the outline.
    for (const p of res.placed) {
      expect(p.x).toBeGreaterThan(res.outline!.x);
      expect(p.x).toBeLessThan(res.outline!.x + res.outline!.w);
      expect(p.y).toBeGreaterThan(res.outline!.y);
      expect(p.y).toBeLessThan(res.outline!.y + res.outline!.h);
    }

    const drc = await runDrc(kicad!, pcbPath);
    expect(drc.ok).toBe(true);
    expect(drc.unconnected.length).toBeGreaterThan(0);          // not routed: KiCad reports the open connections
    expect(drc.footprintIssues).toEqual([]);                     // schematic parity: board matches the schematic
    // Placement problems: courtyard overlaps, anything against the board edge, silk of two different footprints
    // overlapping, library resolution. (Some library footprints overlap their own silkscreen; that is not placement.)
    const refsIn = (v: { items: { description: string }[] }) => new Set(v.items.map((i) => /of (S+) on/.exec(i.description)?.[1]).filter(Boolean)).size;
    const placement = drc.violations.filter((v) => /courtyard|edge|lib_footprint|clearance/i.test(v.type) && v.type !== "silk_overlap" || (v.type === "silk_overlap" && refsIn(v) > 1));
    expect(placement).toEqual([]);
  }, 120000);

  it("multi-unit op-amp gets one DIP-8 footprint; simulation sources stay off the board", async () => {
    const { dir, netlist } = await build(opampCircuit().b.project, "op");
    const res = await generatePcb(kicad!, libs!, { pcbPath: path.join(dir, "op.kicad_pcb"), netlistText: netlist, update: false });
    expect(res.placed.map((p) => p.ref).sort()).toEqual(["R1", "U1"]);
    const board = parse(await fs.readFile(path.join(dir, "op.kicad_pcb"), "utf8"));
    const u1 = children(board, "footprint").find((f) => arg(f) === "Package_DIP:DIP-8_W7.62mm")!;
    const padNet = (n: string) => arg(child(children(u1, "pad").find((p) => arg(p) === n), "net"));
    expect(padNet("4")).toBe("GND");
    expect(padNet("1")).toBe(padNet("2"));      // follower: output tied to inverting input
  }, 120000);

  it("update keeps existing placement by reference, removes deleted parts, places new ones", async () => {
    const p1 = rcNetwork();
    const { dir, netlist } = await build(p1, "upd");
    const pcbPath = path.join(dir, "upd.kicad_pcb");
    await generatePcb(kicad!, libs!, { pcbPath, netlistText: netlist, update: false });
    // Move R1 like a user would, then change the schematic: delete C6, add R7.
    const text = await fs.readFile(pcbPath, "utf8");
    const moved = text.replace(/(\(footprint "Resistor_SMD:R_0805_2012Metric"[\s\S]*?\(at )([\d.]+) ([\d.]+)/, "$1123.45 67.89");
    await fs.writeFile(pcbPath, moved, "utf8");
    const p2 = structuredClone(p1);
    p2.schematic.components = p2.schematic.components.filter((c) => c.ref !== "C6");
    const r7 = { ...p2.schematic.components.find((c) => c.ref === "R6")!, id: "c_new_r7", ref: "R7", position: { x: 70, y: 20 } };
    p2.schematic.components.push(r7);
    const again = await build(p2, "upd", dir);
    const res = await generatePcb(kicad!, libs!, { pcbPath, netlistText: again.netlist, update: true });
    expect(res.mode).toBe("update");
    expect(res.backup).toBeTruthy();
    expect(res.removed).toEqual(["C6"]);
    const r1 = res.placed.find((p) => Math.abs(p.x - 123.45) < 1e-6 && Math.abs(p.y - 67.89) < 1e-6);
    expect(r1?.kept).toBe(true);
    expect(res.placed.find((p) => p.ref === "R7")?.kept).toBe(false);
    const board = parse(await fs.readFile(pcbPath, "utf8"));
    expect(children(board, "footprint").length).toBe(13);
  }, 180000);
});
