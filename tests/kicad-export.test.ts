// Export → kicad-cli netlist: KiCad must see exactly SparkBench's connectivity.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Builder, divider } from "./helpers";
import { exportSchematic, exportProjectFile } from "../src/kicad/exportSch";
import { verifyConnectivity } from "../src/kicad/verify";
import { findKicad } from "../src/kicad/node/install";
import { KicadLibraries } from "../src/kicad/node/libs";
import { exportNetlist, runErc, writeText } from "../src/kicad/node/cli";
import { kicadTransform } from "../src/kicad/common";
import type { Project } from "../src/core/types";

const kicad = findKicad();
const libs = kicad ? new KicadLibraries(kicad) : null;

export async function exportAndCheck(project: Project, name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sb-kicad-${name}-`));
  const ex = exportSchematic({ project, name, symbols: libs! });
  const sch = path.join(dir, `${name}.kicad_sch`);
  await writeText(sch, ex.text);
  await writeText(path.join(dir, `${name}.kicad_pro`), exportProjectFile(name));
  const board = await exportNetlist(kicad!, sch);
  const spice = await exportNetlist(kicad!, sch, "spice");
  const v = verifyConnectivity(ex, board, spice);
  const cmp = { equal: v.equal, onlyInSparkbench: v.onlyInSparkbench, onlyInKicad: v.onlyInKicad };
  return { ex, board, spice, cmp, dir, sch };
}

/** Rotations, mirroring, T-junctions, labels, a pin in the middle of a wire, a diode (pin map A→2, K→1). */
function mixed() {
  const b = new Builder();
  const V1 = b.place("vsine", "V1", 0, 10, {});
  const R1 = b.place("resistor", "R1", 8, 0, {}, 90);            // horizontal
  const D1 = b.place("diode", "D1", 18, 0, {});                  // anode left
  const C1 = b.place("capacitor", "C1", 24, 6, {}, 180);
  const R2 = b.place("resistor", "R2", 30, 6, {}, 270);
  const L1 = b.place("inductor", "L1", 40, 6, {});
  L1.mirror = true;
  const D2 = b.place("diode", "D2", 40, 16, {}, 90);
  D2.mirror = true;
  const G = b.place("ground", "#PWR1", 0, 20);
  b.connect(b.pin(V1, "1"), b.pin(R1, "1"));
  b.wire(b.pin(R1, "2"), b.pin(D1, "A"));
  b.wire(b.pin(D1, "K"), { x: 40, y: 0 }, { x: 40, y: 3 });     // D1.K → L1 pin 1 at (40,3)
  b.wire({ x: 24, y: 0 }, b.pin(C1, "2"));                       // T into D1.K wire at (24,0)
  b.wire(b.pin(C1, "1"), { x: 24, y: 14 }, { x: 0, y: 14 });     // C1 → bottom rail
  b.wire(b.pin(R2, "1"), b.pin(R2, "2"));                         // shorted resistor (horizontal at y=6)
  b.wire(b.pin(L1, "2"), b.pin(D2, "K"));
  b.label("out", { x: 30, y: 0 });                                // label mid-wire on the D1.K wire
  b.label("bot", b.pin(D2, "A"));
  b.label("bot", { x: 12, y: 14 });                               // same-name label on the rail → joins D2.A
  b.wire(b.pin(V1, "2"), b.pin(G, "1"));
  b.wire({ x: 0, y: 14 }, { x: 0, y: 20 });                       // rail to ground passes V1- at (0,14)
  return b.project;
}

describe("kicad transforms", () => {
  it("rotates counter-clockwise on screen and mirrors after rotation", () => {
    expect(kicadTransform(0, 3.81, { angle: 0, mirror: "" })).toEqual({ x: 0, y: -3.81 });
    expect(kicadTransform(0, 3.81, { angle: 90, mirror: "" })).toEqual({ x: -3.81, y: 0 });
    expect(kicadTransform(0, 3.81, { angle: 90, mirror: "y" })).toEqual({ x: 3.81, y: 0 });
  });
});

describe.skipIf(!kicad)("export to KiCad: netlist connectivity equals SparkBench's", () => {
  it("divider", async () => {
    const { cmp, ex } = await exportAndCheck(divider().b.project, "divider");
    expect(ex.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(cmp).toEqual({ equal: true, onlyInSparkbench: [], onlyInKicad: [] });
  });
  it("rotated/mirrored parts, T-junctions, labels, ground labels", async () => {
    const { cmp, ex } = await exportAndCheck(mixed(), "mixed");
    expect(ex.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(cmp).toEqual({ equal: true, onlyInSparkbench: [], onlyInKicad: [] });
  });
  it("every rotation and mirror of a diode", async () => {
    const b = new Builder();
    let x = 0;
    for (const mirror of [false, true]) for (const rot of [0, 90, 180, 270] as const) {
      const d = b.place("diode", `D${x / 10 + 1}`, x, 0, {}, rot);
      d.mirror = mirror;
      b.label(`a${x}`, b.pin(d, "A"));
      const r = b.place("resistor", `R${x / 10 + 1}`, x + 5, 10, {});
      b.connect(b.pin(d, "K"), b.pin(r, "1"));
      b.label(`a${x}`, b.pin(r, "2"));
      x += 10;
    }
    const { cmp } = await exportAndCheck(b.project, "orient");
    expect(cmp.equal).toBe(true);
  });
  it("ERC runs on the export", async () => {
    const { sch } = await exportAndCheck(divider().b.project, "erc");
    const erc = await runErc(kicad!, sch);
    expect(erc.ok).toBe(true);
    expect(Array.isArray(erc.violations)).toBe(true);
  });
});

describe.skipIf(!kicad)("export format matches what KiCad itself writes", () => {
  it("KiCad re-saving the export changes nothing but the generator line", async () => {
    for (const [p, n] of [[mixed(), "oracle1"], [divider().b.project, "oracle2"]] as const) {
      const { sch, ex } = await exportAndCheck(p, n);
      const { runCli } = await import("../src/kicad/node/install");
      const r = runCli(kicad!, ["sch", "upgrade", "--force", sch]);
      expect(r.code).toBe(0);
      const strip = (t: string) => t.replace(/\r\n/g, "\n").replace(/\t\(generator[^\n]*\n/g, "");
      expect(strip(await fs.readFile(sch, "utf8"))).toBe(strip(ex.text));
    }
  });
  it("detects a broken export (negative control)", async () => {
    const { ex, dir } = await exportAndCheck(divider().b.project, "broken");
    const sch = path.join(dir, "broken2.kicad_sch");
    await writeText(sch, ex.text.replace(/\t\(wire[\s\S]*?\n\t\)\n/, ""));   // drop one wire
    const v = verifyConnectivity(ex, await exportNetlist(kicad!, sch), await exportNetlist(kicad!, sch, "spice"));
    expect(v.equal).toBe(false);
  });
});

describe.skipIf(!kicad)("Sim.* fields drive KiCad's own SPICE netlister", () => {
  it("KiCad's SPICE netlist of the export simulates to SparkBench's answer", async () => {
    const { engine } = await import("./helpers");
    const { simulate } = await import("../src/core/simulate");
    const d = divider("10", "1k", "3k");
    // add a diode branch so the inline diode model is exercised
    const D1 = d.b.place("diode", "D1", 20, 10, {}, 90);
    d.b.connect(d.b.pin(d.R2, "1"), d.b.pin(D1, "A"));
    const R3 = d.b.place("resistor", "R3", 26, 16, { value: "10k" });
    d.b.connect(d.b.pin(D1, "K"), d.b.pin(R3, "1"));
    d.b.connect(d.b.pin(R3, "2"), d.b.pin(d.G, "1"));
    const ours = await simulate(d.b.project, engine(), "op");
    expect(ours.ok).toBe(true);
    const vOurs = ours.vectors.find((v) => v.netName === "out")!.real[0];

    const { spice } = await exportAndCheck(d.b.project, "simfields");
    expect(spice).toMatch(/^D1 .* __D1\s*$/m);          // no instance params leaked from the model
    expect(spice).not.toMatch(/\bm=0\.4/);
    const out = await engine().run(spice.replace(/^\.title.*$/m, "* KiCad export").replace(/^\.end\s*$/m, ".end"));
    const idx = out.variableNames.findIndex((n) => /v\(\/out\)/i.test(n));
    expect(idx).toBeGreaterThanOrEqual(0);
    const vKicad = (out.data[idx] as { values: number[] }).values[0];
    expect(vKicad).toBeCloseTo(vOurs, 4);
  });
});

// A dual op-amp mapped like the library session's LM358: unit 1 placed, power unit 3 as an extra unit.
import { registerParts } from "../src/core/library";
import type { ComponentDef } from "../src/core/types";
export const testOpamp: ComponentDef = {
  id: "test_lm358", name: "LM358 (test)", category: "Test", description: "", refPrefix: "U", provenance: "behavioral",
  pins: [
    { id: "OUT", name: "OUT", x: 6, y: 0 }, { id: "IN-", name: "-", x: -6, y: 2 }, { id: "IN+", name: "+", x: -6, y: -2 },
    { id: "V+", name: "V+", x: -2, y: -6 }, { id: "V-", name: "V-", x: -2, y: 6 },
  ],
  symbol: [], props: [],
  kicad: { symbol: "Amplifier_Operational:LM358", footprint: "Package_DIP:DIP-8_W7.62mm", unit: 1, extraUnits: [3],
    pinMap: { OUT: "1", "IN-": "2", "IN+": "3", "V+": "8", "V-": "4" } },
};
registerParts([testOpamp]);

export function opampCircuit() {
  const b = new Builder();
  const VS = b.place("vdc", "V1", -20, 0, { value: "12" });
  const VIN = b.place("vsine", "V2", -14, 10, {});
  const U = b.place("test_lm358", "U1", 0, 0);
  const RL = b.place("resistor", "R1", 12, 6, { value: "10k" });
  const G = b.place("ground", "#PWR1", -14, 20);
  b.connect(b.pin(VS, "1"), b.pin(U, "V+"));
  b.label("GND", b.pin(VS, "2"));
  b.connect(b.pin(U, "V-"), { x: -2, y: 8 });
  b.label("GND", { x: -2, y: 8 });
  b.connect(b.pin(VIN, "1"), b.pin(U, "IN+"));
  b.connect(b.pin(VIN, "2"), b.pin(G, "1"));
  b.wire(b.pin(U, "OUT"), { x: 12, y: 0 }, b.pin(RL, "1"));
  b.wire({ x: 8, y: 0 }, { x: 8, y: 4 }, { x: -8, y: 4 }, { x: -8, y: 2 }, b.pin(U, "IN-"));
  b.label("GND", b.pin(RL, "2"));
  return { b, U };
}

describe.skipIf(!kicad)("multi-unit symbols", () => {
  it("places unit 1 and the power unit with one reference; connectivity matches", async () => {
    const { b } = opampCircuit();
    const { cmp, ex, board } = await exportAndCheck(b.project, "opamp");
    expect(ex.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(cmp).toEqual({ equal: true, onlyInSparkbench: [], onlyInKicad: [] });
    const units = [...ex.text.matchAll(/\(lib_id "Amplifier_Operational:LM358"\)[\s\S]*?\(unit (\d+)\)/g)].map((m) => m[1]).sort();
    expect(units).toEqual(["1", "3"]);
    expect(board).toMatch(/\(ref "U1"\)/);
    expect(ex.parts.find((p) => p.ref === "U1")!.units).toEqual([1, 3]);
  });
  it("KiCad re-save of a flattened derived symbol (LM358 extends LM2904) is identical", async () => {
    const { sch, ex } = await exportAndCheck(opampCircuit().b.project, "opamp-oracle");
    const { runCli } = await import("../src/kicad/node/install");
    expect(runCli(kicad!, ["sch", "upgrade", "--force", sch]).code).toBe(0);
    const strip = (t: string) => t.replace(/\r\n/g, "\n").replace(/\t\(generator[^\n]*\n/g, "");
    expect(strip(await fs.readFile(sch, "utf8"))).toBe(strip(ex.text));
  });
});
