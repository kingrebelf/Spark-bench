import { describe, expect, it } from "vitest";
import { divider } from "./helpers";
import { mappingIds, reviewMapping, type LibraryFacts } from "../src/kicad/mapping";
import { findKicad } from "../src/kicad/node/install";
import { KicadLibraries, searchHits } from "../src/kicad/node/libs";
import { opampCircuit } from "./kicadHelpers";

const kicad = findKicad();
const libs = kicad ? new KicadLibraries(kicad) : null;

const codes = (rows: ReturnType<typeof reviewMapping>, ref: string) => rows.find((r) => r.ref === ref)!.diagnostics.map((d) => d.code);

describe("mapping review (pure)", () => {
  const facts: LibraryFacts = {
    symbols: {
      "Device:R": { pins: [{ number: "1", name: "~", unit: 1 }, { number: "2", name: "~", unit: 1 }], unitCount: 1, power: false, onBoard: true, description: "" },
      "Simulation_SPICE:VDC": { pins: [{ number: "1", name: "+", unit: 1 }, { number: "2", name: "-", unit: 1 }], unitCount: 1, power: false, onBoard: true, description: "" },
      "power:GND": { pins: [{ number: "1", name: "GND", unit: 1 }], unitCount: 1, power: true, onBoard: true, description: "" },
      "Device:Q_NPN": { pins: [{ number: "1", name: "B", unit: 1 }, { number: "2", name: "C", unit: 1 }, { number: "3", name: "E", unit: 1 }], unitCount: 1, power: false, onBoard: true, description: "" },
    },
    footprints: { "Resistor_SMD:R_0805_2012Metric": ["1", "2"], "Package_TO_SOT_SMD:SOT-23": ["1", "2", "3"] },
  };
  it("passes a clean divider and marks the source simulation-only", () => {
    const { b } = divider();
    const rows = reviewMapping(b.project, facts);
    expect(rows.find((r) => r.ref === "R1")!.status).toBe("ok");
    expect(codes(rows, "V1")).toEqual(["kicad-sim-only"]);
    expect(rows.find((r) => r.ref === "#PWR1")!.status).toBe("ok");
  });
  it("reports missing symbol, missing footprint, no footprint, pin and pad mismatches", () => {
    const { b, R1, R2 } = divider();
    R1.kicad = { symbol: "Device:R_Missing" };
    R2.kicad = { footprint: "" };
    const V = b.place("vdc", "V9", 50, 0);
    V.kicad = { symbol: "Device:Q_NPN", footprint: "Package_TO_SOT_SMD:SOT-23" }; // 2-pin part on a 3-pin symbol
    const R3 = b.place("resistor", "R3", 60, 0);
    R3.kicad = { footprint: "Nope:Nothing" };
    const R4 = b.place("resistor", "R4", 70, 0);
    R4.kicad = { footprint: "Package_TO_SOT_SMD:SOT-23" };
    const rows = reviewMapping(b.project, { symbols: { ...facts.symbols, "Device:R_Missing": null }, footprints: { ...facts.footprints, "Nope:Nothing": null } });
    expect(codes(rows, "R1")).toContain("kicad-symbol-missing");
    expect(codes(rows, "R2")).toContain("kicad-no-footprint");
    expect(codes(rows, "V9")).toContain("kicad-pin-count");
    expect(codes(rows, "R3")).toContain("kicad-footprint-missing");
    expect(rows.find((r) => r.ref === "R4")!.status).toBe("ok"); // pads 1,2 exist on SOT-23 (pads match numbers)
    for (const r of rows) for (const d of r.diagnostics) { expect(d.fix).toBeTruthy(); expect(d.componentIds).toEqual([r.componentId]); }
  });
});

describe.skipIf(!kicad)("mapping review against installed libraries", () => {
  it("starter parts and a multi-unit op-amp map cleanly", () => {
    const { b } = opampCircuit();
    const ids = mappingIds(b.project);
    const rows = reviewMapping(b.project, libs!.facts(ids.symbols, ids.footprints));
    const bad = rows.flatMap((r) => r.diagnostics).filter((d) => d.severity !== "info");
    expect(bad).toEqual([]);
  });
  it("finds a pad mismatch with a real footprint", () => {
    const { b, R1 } = divider();
    R1.kicad = { footprint: "Diode_SMD:D_SOD-123" }; // pads 1,2 — fine
    const D = b.place("diode", "D1", 40, 0);
    D.kicad = { footprint: "Connector_PinHeader_2.54mm:PinHeader_1x01_P2.54mm_Vertical" }; // only pad 1
    const ids = mappingIds(b.project);
    const rows = reviewMapping(b.project, libs!.facts(ids.symbols, ids.footprints));
    expect(codes(rows, "R1")).toEqual([]);
    expect(codes(rows, "D1")).toEqual(["kicad-pad-mismatch"]);
  });
  it("searches installed symbols and footprints", async () => {
    const s = searchHits(await libs!.symbolIndex(), (h) => `${h.libId} ${h.description} ${h.keywords}`, (h) => h.libId, "LM358");
    expect(s[0].libId).toBe("Amplifier_Operational:LM358");
    const f = searchHits(await libs!.footprintIndex(), (h) => h.fpId, (h) => h.fpId, "R_0805");
    expect(f.map((x) => x.fpId)).toContain("Resistor_SMD:R_0805_2012Metric");
  }, 120000);
});
