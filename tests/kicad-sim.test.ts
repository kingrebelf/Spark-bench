// The Sim.* fields SparkBench writes let KiCad's own SPICE netlister reproduce SparkBench's results:
// KiCad's netlist of the export is run through ngspice and compared with SparkBench's own simulation.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Builder, engine } from "./helpers";
import { simulate } from "../src/core/simulate";
import { getPart } from "../src/core/library";
import { exportSchematic } from "../src/kicad/exportSch";
import { modelCardMapping } from "../src/kicad/simfields";
import { findKicad } from "../src/kicad/node/install";
import { KicadLibraries } from "../src/kicad/node/libs";
import { exportNetlist, writeText } from "../src/kicad/node/cli";

const kicad = findKicad();
const libs = kicad ? new KicadLibraries(kicad) : null;

async function compareOp(b: Builder, nets: string[], name: string) {
  const ours = await simulate(b.project, engine(), "op");
  expect(ours.ok, ours.diagnostics.map((d) => d.message).join("; ")).toBe(true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sb-sim-${name}-`));
  const ex = exportSchematic({ project: b.project, name, symbols: libs! });
  const sch = path.join(dir, `${name}.kicad_sch`);
  await writeText(sch, ex.text);
  const spice = await exportNetlist(kicad!, sch, "spice");
  const out = await engine().run(spice);
  expect(out.messages.join("\n")).not.toMatch(/error|unknown/i);
  for (const n of nets) {
    const mine = ours.vectors.find((v) => v.netName === n)!.real[0];
    const i = out.variableNames.findIndex((v) => v.toLowerCase() === `v(/${n})`);
    expect(i, `${name}: KiCad netlist has no node /${n}\n${spice}`).toBeGreaterThanOrEqual(0);
    const theirs = (out.data[i] as { values: number[] }).values[0];
    expect(theirs, `${name} V(${n})`).toBeCloseTo(mine, 4);
  }
  return spice;
}

describe.skipIf(!kicad)("KiCad simulation fields reproduce SparkBench results", () => {
  const diodes = ["diode", "diode_rectifier", "led", "zener", "schottky"].filter((id) => getPart(id));
  for (const id of diodes) it(`${id}: forward and reverse bias`, async () => {
    const b = new Builder();
    const V = b.place("vdc", "V1", 0, 0, { value: "5" });
    const R = b.place("resistor", "R1", 6, -6, { value: "1k" }, 90);
    const D = b.place(id, "D1", 14, 0, {}, 90);   // forward
    const R2 = b.place("resistor", "R2", 24, -6, { value: "1k" }, 90);
    const D2 = b.place(id, "D2", 32, 0, {}, 270); // reverse
    b.connect(b.pin(V, "1"), b.pin(R, "1"));
    b.label("a", b.pin(R, "2")); b.label("a", b.pin(D, "A"));
    b.label("vin", b.pin(V, "1")); b.label("vin", b.pin(R2, "1"));
    b.label("r", b.pin(R2, "2")); b.label("r", b.pin(D2, "K"));
    for (const p of [b.pin(V, "2"), b.pin(D, "K"), b.pin(D2, "A")]) b.label("GND", p);
    expect(modelCardMapping(getPart(id)!, D)).not.toBeNull();
    await compareOp(b, ["a", "r"], id);
  });
  const bjts = ["npn", "pnp", "2n3904", "2n3906", "bc547", "bc557"].filter((id) => getPart(id));
  for (const id of bjts) it(`${id}: biased transistor`, async () => {
    const pnp = /pnp|3906|557/.test(id);
    const b = new Builder();
    const V = b.place("vdc", "V1", 0, 0, { value: pnp ? "-5" : "5" });
    const Q = b.place(id, "Q1", 20, 0);
    const RB = b.place("resistor", "R1", 10, -10, { value: "100k" });
    const RC = b.place("resistor", "R2", 30, -10, { value: "1k" });
    b.label("vcc", b.pin(V, "1")); b.label("vcc", b.pin(RB, "1")); b.label("vcc", b.pin(RC, "1"));
    b.label("b", b.pin(RB, "2")); b.label("b", b.pin(Q, "B"));
    b.label("c", b.pin(RC, "2")); b.label("c", b.pin(Q, "C"));
    b.label("GND", b.pin(Q, "E")); b.label("GND", b.pin(V, "2"));
    expect(modelCardMapping(getPart(id)!, Q)).not.toBeNull();
    await compareOp(b, ["b", "c"], id);
  });
});
