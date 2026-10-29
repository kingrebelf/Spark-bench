import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, write, eolOf, str, list, compact, unquote, arg, child } from "../src/kicad/sexpr";
import { findKicad, runCli } from "../src/kicad/node/install";

const kicad = findKicad();

describe("sexpr basics", () => {
  it("parses and quotes strings with escapes", () => {
    const e = parse(`(text "a \\"b\\" \\\\ c\\n" (at 1 2 0))`);
    expect(unquote(e.items[1].t === "atom" ? e.items[1].raw : "")).toBe('a "b" \\ c\n');
    expect(compact(list("x", str('q"\\')))).toBe('(x "q\\"\\\\")');
    expect(arg(child(e, "at"), 2)).toBe("2");
  });
  it("formats like KiCad", () => {
    const e = parse(`(kicad_sch (version 1) (wire (pts (xy 1 2) (xy 3 4)) (stroke (width 0) (type solid))))`);
    expect(write(e)).toBe("(kicad_sch\n\t(version 1)\n\t(wire\n\t\t(pts\n\t\t\t(xy 1 2) (xy 3 4)\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type solid)\n\t\t)\n\t)\n)\n");
  });
});

// Byte-exact round trip on files written by KiCad 10 itself (demo files re-saved with `kicad-cli ... upgrade`,
// plus the installed libraries). Skipped when KiCad is not installed.
describe.skipIf(!kicad)("sexpr round-trips KiCad-written files", () => {
  const demos = kicad ? path.join(kicad.shareDir, "demos") : "";
  const cases: [string, string, "sch" | "pcb" | null][] = [
    ["simulation/rectifier/rectifier.kicad_sch", "rectifier.kicad_sch", "sch"],
    ["simulation/v_i_sources/v_i_sources.kicad_sch", "v_i_sources.kicad_sch", "sch"],
    ["ecc83/ecc83-pp.kicad_pcb", "ecc83-pp.kicad_pcb", "pcb"],
    ["complex_hierarchy/complex_hierarchy.kicad_pcb", "complex_hierarchy.kicad_pcb", "pcb"],
  ];
  for (const [rel, name, kind] of cases) {
    it(`round-trips ${name}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-sexpr-"));
      const f = path.join(dir, name);
      await fs.copyFile(path.join(demos, rel), f);
      runCli(kicad!, [kind!, "upgrade", "--force", f]);
      const text = await fs.readFile(f, "utf8");
      expect(text.length).toBeGreaterThan(1000);
      expect(write(parse(text), eolOf(text))).toBe(text);
    });
  }
  for (const lib of ["Device.kicad_sym", "Simulation_SPICE.kicad_sym", "power.kicad_sym"]) {
    it(`round-trips library ${lib}`, async () => {
      const text = await fs.readFile(path.join(kicad!.symbolDir, lib), "utf8");
      expect(write(parse(text), eolOf(text))).toBe(text);
    });
  }
  it("round-trips footprints", async () => {
    for (const fp of ["Resistor_SMD.pretty/R_0805_2012Metric.kicad_mod", "Package_DIP.pretty/DIP-8_W7.62mm.kicad_mod"]) {
      const text = await fs.readFile(path.join(kicad!.footprintDir, fp), "utf8");
      expect(write(parse(text), eolOf(text))).toBe(text);
    }
  });
});
