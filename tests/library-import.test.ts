// SPICE model import: parsing, model assignment to parts, and imported subcircuits as parts.
import { describe, expect, it } from "vitest";
import { engine } from "./helpers";
import { NetBuilder, errorsOf, opValue } from "./libraryFixtures";
import {
  checkModelAssignment, compatibleModels, importSpiceText, parseSpiceModels, partsForModel, registerImportedModels, subcktPartId,
} from "../src/library/spiceImport";
import { simulate } from "../src/core/simulate";
import { getPart, partTypes } from "../src/core/library";
import { parseProject, serializeProject } from "../src/core/project";

const LIB = `* Vendor-style model file
* with comments, continuations and several definitions
.MODEL MyDiode D(IS=1e-12 N=1.9 ; inline comment
+ RS=0.5 BV=50 IBV=10u)
.model QFAST npn (Is=2f Bf=150
+ Vaf=60 $ another comment style
+ Cje=2p Cjc=1p)
.model PFET pmos (level=1 vto=-1.5 kp=0.05)
.model IRFZ VDMOS (Rg=3 Vto=3 Rd=10m Rs=5m Rb=10m Kp=20 Cgdmax=1n Cgdmin=0.1n Cgs=1n Cjo=1n Is=1p)

.SUBCKT RCDIV in out gnd PARAMS: R=1k C=1n
R1 in out {R}
R2 out gnd {R}
C1 out gnd {C}
.ENDS RCDIV
`;

describe("parseSpiceModels", () => {
  it("reads models and subcircuits with continuations and comments", () => {
    const { models, diagnostics } = parseSpiceModels(LIB);
    expect(diagnostics).toEqual([]);
    expect(models.map((m) => [m.kind, m.name, m.type ?? ""])).toEqual([
      ["model", "MyDiode", "D"], ["model", "QFAST", "NPN"], ["model", "PFET", "PMOS"], ["model", "IRFZ", "VDMOS"], ["subckt", "RCDIV", ""],
    ]);
    const d = models[0];
    expect(d.params).toMatchObject({ is: "1e-12", n: "1.9", rs: "0.5", bv: "50", ibv: "10u" });
    expect(d.text).not.toContain(";");
    expect(models[1].params).toMatchObject({ bf: "150", vaf: "60", cjc: "1p" });
    expect(models[3].polarity).toBe("N");
    const sub = models[4];
    expect(sub.pins).toEqual(["in", "out", "gnd"]);
    expect(sub.params).toEqual({ r: "1k", c: "1n" });
    expect(sub.text.split("\n")).toHaveLength(5);
  });
  it("reports unterminated subcircuits, duplicates and empty files", () => {
    expect(parseSpiceModels(".subckt X a b\nR1 a b 1k\n").diagnostics[0].code).toBe("spice-import-unterminated");
    expect(parseSpiceModels(".model A D\n.model a D(Is=1n)").diagnostics[0].code).toBe("spice-import-duplicate");
    expect(parseSpiceModels("hello world").diagnostics[0].code).toBe("spice-import-empty");
  });
  it("handles nested subcircuits and VDMOS p-channel flags", () => {
    const { models } = parseSpiceModels(".subckt OUTER a b\n.subckt INNER x y\nR1 x y 1\n.ends INNER\nX1 a b INNER\n.ends OUTER\n.model PV VDMOS(pchan Vto=-2)");
    expect(models.map((m) => m.name)).toEqual(["OUTER", "PV"]);
    expect(models[1].polarity).toBe("P");
  });
});

describe("model assignment", () => {
  const { models } = importSpiceText(LIB, { source: "test.lib" });
  const byName = (n: string) => models.find((m) => m.name === n)!;

  it("labels provenance honestly", () => {
    expect(models[0].provenance).toBe("generic");
    expect(importSpiceText(LIB, { manufacturer: "Acme" }).models[0].provenance).toBe("vendor");
  });
  it("matches model types to parts", () => {
    expect(checkModelAssignment("diode", byName("MyDiode"))).toBeUndefined();
    expect(checkModelAssignment("led", byName("MyDiode"))).toBeUndefined();
    expect(checkModelAssignment("npn", byName("MyDiode"))?.code).toBe("model-type-mismatch");
    expect(checkModelAssignment("resistor", byName("MyDiode"))?.code).toBe("model-not-assignable");
    expect(checkModelAssignment("nmos", byName("IRFZ"))).toBeUndefined();
    expect(checkModelAssignment("diode", byName("RCDIV"))?.code).toBe("model-is-subckt");
    expect(compatibleModels("pmos", models).map((m) => m.name)).toEqual(["PFET"]);
    expect(partsForModel(byName("QFAST"))).toEqual(expect.arrayContaining(["npn", "2n3904", "bc547"]));
  });

  it("simulates parts with imported models (diode, BJT, VDMOS) and refuses mismatches", async () => {
    const b = new NetBuilder();
    b.project.models = models;
    b.v("V1", "vcc", "GND", 5);
    b.r("R1", "vcc", "a", "1k");
    b.add("diode", "D1", { A: "a", K: "GND" }).modelId = byName("MyDiode").id;
    b.r("R2", "vcc", "c", "1k"); b.r("R3", "vcc", "b", "100k");
    b.add("npn", "Q1", { B: "b", C: "c", E: "GND" }).modelId = byName("QFAST").id;
    b.r("R4", "vcc", "d", "100"); b.add("nmos", "M1", { G: "vcc", D: "d", S: "GND" }).modelId = byName("IRFZ").id;
    const r = await simulate(b.project, engine(), "op");
    expect(errorsOf(r)).toEqual([]);
    expect(r.netlist).toContain(".MODEL MyDiode D(");
    expect(r.netlist).toMatch(/^D1 a 0 MyDiode$/m);
    expect(r.netlist).toMatch(/^M1 d vcc 0 IRFZ$/m); // VDMOS: three terminals
    const vd = opValue(r, "a");
    expect(vd).toBeGreaterThan(1.0); expect(vd).toBeLessThan(1.15); // N=1.9, Is=1p at 3.9 mA -> 1.08 V
    expect(opValue(r, "c")).toBeLessThan(5); // QFAST conducts with ~43 µA base current
    expect(opValue(r, "d")).toBeLessThan(0.1);

    const bad = new NetBuilder();
    bad.project.models = models;
    bad.v("V1", "vcc", "GND", 5);
    bad.r("R1", "vcc", "a", "1k");
    const d = bad.add("diode", "D1", { A: "a", K: "GND" });
    d.modelId = byName("QFAST").id;
    const r2 = await simulate(bad.project, engine(), "op");
    expect(r2.ok).toBe(false);
    expect(r2.diagnostics.find((x) => x.code === "unsupported-part")?.componentIds).toEqual([d.id]);
  }, 60_000);
});

describe("imported subcircuits become parts", () => {
  it("registers a part with the .subckt pins and simulates it", async () => {
    const { models } = importSpiceText(LIB, { source: "test.lib" });
    const sub = models.find((m) => m.kind === "subckt")!;
    const [def] = registerImportedModels(models);
    expect(def.id).toBe(subcktPartId(sub));
    expect(getPart(def.id)).toBe(def);
    expect(def.pins.map((p) => p.name)).toEqual(["in", "out", "gnd"]);
    for (const p of def.pins) expect(Number.isInteger(p.y)).toBe(true);

    const b = new NetBuilder();
    b.project.models = models;
    b.v("V1", "in", "GND", 10);
    b.add(def.id, "X1", { 1: "in", 2: "out", 3: "GND" });
    b.r("RL", "out", "GND", "1MEG");
    const r = await simulate(b.project, engine(), "op");
    expect(errorsOf(r)).toEqual([]);
    expect(opValue(r, "out")).toBeCloseTo(10 * (1e3 * 1e6 / (1e3 + 1e6)) / (1e3 + 1e3 * 1e6 / (1e3 + 1e6)), 3);

    // Round trip: the project file carries the model, and once re-registered the part type is known.
    const loaded = parseProject(serializeProject(b.project), partTypes());
    expect(loaded.diagnostics).toEqual([]);
  }, 60_000);
});
