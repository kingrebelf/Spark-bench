// Import of KiCad-written schematics, verified against KiCad's own netlist of the source file.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { divider } from "./helpers";
import { opampCircuit } from "./kicadHelpers";
import { exportSchematic } from "../src/kicad/exportSch";
import { importSchematic, importedPartition } from "../src/kicad/importSch";
import { comparePartitions, mergedKicadPartition, parseKicadNetlist, parseSpiceNetlist } from "../src/kicad/netlist";
import { computeConnectivity } from "../src/core/connectivity";
import { findKicad, runCli } from "../src/kicad/node/install";
import { KicadLibraries } from "../src/kicad/node/libs";
import { exportNetlist, writeText } from "../src/kicad/node/cli";
import type { Project } from "../src/core/types";

const kicad = findKicad();
const libs = kicad ? new KicadLibraries(kicad) : null;

/** KiCad's connectivity of a schematic file, restricted to the refs SparkBench imported. */
async function kicadNets(sch: string, imported: Project) {
  const board = parseKicadNetlist(await exportNetlist(kicad!, sch));
  const spice = parseSpiceNetlist(await exportNetlist(kicad!, sch, "spice"));
  const onBoard = new Set(board.components.map((c) => c.ref));
  const simOnly = imported.schematic.components.filter((c) => /^v/.test(c.type) && !onBoard.has(c.ref)).map((c) => ({ ref: c.ref, device: "V", simPins: "1=+ 2=-" }));
  const refs = new Set(imported.schematic.components.map((c) => c.ref));
  return mergedKicadPartition(board, spice, simOnly).map((g) => g.filter((k) => refs.has(k.split(":")[0]))).filter((g) => g.length);
}

describe.skipIf(!kicad)("import KiCad schematics", () => {
  it("round-trips SparkBench → KiCad → SparkBench with identical connectivity (incl. multi-unit)", async () => {
    for (const [p, name] of [[divider().b.project, "rt1"], [opampCircuit().b.project, "rt2"]] as const) {
      const ex = exportSchematic({ project: p, name, symbols: libs! });
      const { project, report } = importSchematic(ex.text, { name });
      expect(report.notImported).toEqual([]);
      expect(report.imported.every((r) => r.how === "lib_id")).toBe(true);
      const back = importedPartition(project, computeConnectivity(project));
      expect(comparePartitions(ex.expectedNets, back)).toEqual({ equal: true, onlyInSparkbench: [], onlyInKicad: [] });
      // values survive
      const orig = p.schematic.components.filter((c) => c.props.value !== undefined);
      for (const c of orig) expect(String(project.schematic.components.find((x) => x.ref === c.ref)!.props.value)).toBe(String(c.props.value));
    }
  });

  it("imports the KiCad rectifier demo (project-local symbols matched by name and pins) with KiCad's connectivity", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-import-"));
    const src = path.join(kicad!.shareDir, "demos", "simulation", "rectifier");
    for (const f of await fs.readdir(src)) await fs.copyFile(path.join(src, f), path.join(dir, f));
    const sch = path.join(dir, "rectifier.kicad_sch");
    runCli(kicad!, ["sch", "upgrade", "--force", sch]); // a file written by KiCad 10 itself
    const { project, report } = importSchematic(await fs.readFile(sch, "utf8"), { name: "rectifier" });
    expect(report.imported.map((r) => r.ref).sort()).toEqual(["C1", "D1", "R1", "R2", "V1"]);
    expect(report.imported.every((r) => r.how === "symbol-name")).toBe(true);
    expect(report.power).toEqual([{ ref: "#PWR01", net: "GND", as: "ground" }]);
    expect(report.simulation).toBe(".tran 1u 10m");
    expect(project.simulation.analysis).toBe("tran");
    const v1 = project.schematic.components.find((c) => c.ref === "V1")!;
    expect(v1.type).toBe("vsine");
    expect(v1.props).toMatchObject({ amplitude: "1", frequency: "1k" });
    const ours = importedPartition(project, computeConnectivity(project));
    const theirs = await kicadNets(sch, project);
    expect(comparePartitions(theirs, ours)).toEqual({ equal: true, onlyInSparkbench: [], onlyInKicad: [] });
  });

  it("reports hierarchical sheets and unknown symbols instead of guessing", async () => {
    const f = path.join(kicad!.shareDir, "demos", "complex_hierarchy", "complex_hierarchy.kicad_sch");
    const { report } = importSchematic(await fs.readFile(f, "utf8"));
    expect(report.unsupported.join(" ")).toMatch(/hierarchical sheet/);
    const f2 = path.join(kicad!.shareDir, "demos", "ecc83", "ecc83-pp.kicad_sch");
    const r2 = importSchematic(await fs.readFile(f2, "utf8")).report;
    expect(r2.notImported.length).toBeGreaterThan(0);      // valves etc. have no SparkBench part
    for (const n of r2.notImported) expect(n.reason).toBeTruthy();
    expect(r2.warnings.join(" ")).toMatch(/not imported/);
  });

  it("writes an imported project that survives export again", async () => {
    const ex = exportSchematic({ project: opampCircuit().b.project, name: "again", symbols: libs! });
    const { project } = importSchematic(ex.text);
    const ex2 = exportSchematic({ project, name: "again2", symbols: libs! });
    expect(ex2.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-import2-"));
    await writeText(path.join(dir, "again2.kicad_sch"), ex2.text);
  });
});

describe.skipIf(!kicad)("ground-like label names keep KiCad's connectivity", () => {
  it('only a label named exactly "GND" joins ground; "gnd"/"0" stay separate nets as in KiCad', async () => {
    const { b } = divider();
    const R3 = b.place("resistor", "R3", 40, 3);
    const R4 = b.place("resistor", "R4", 50, 3);
    b.label("q1", b.pin(R3, "2")); b.label("q2", b.pin(R4, "2"));
    b.label("q3", b.pin(R3, "1")); b.label("q4", b.pin(R4, "1"));
    const ex = exportSchematic({ project: b.project, name: "gl", symbols: libs! });
    // Labels written straight into KiCad's file: "GND" (joins the power net in KiCad), "gnd" and "0" (do not).
    const text = ex.text.replace('(label "q1"', '(label "GND"').replace('(label "q2"', '(label "gnd"').replace('(label "q3"', '(label "0"').replace('(label "q4"', '(label "0"');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-gl-"));
    const sch = path.join(dir, "gl.kicad_sch");
    await writeText(sch, text);
    const { project, report } = importSchematic(text);
    expect(report.warnings.join(" ")).toMatch(/"gnd" was renamed/);
    const ours = importedPartition(project, computeConnectivity(project));
    const theirs = await kicadNets(sch, project);
    expect(comparePartitions(theirs, ours)).toEqual({ equal: true, onlyInSparkbench: [], onlyInKicad: [] });
  });
});
