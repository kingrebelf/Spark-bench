// Export → update flow through writeProject (what the Electron IPC calls).
import { describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { divider } from "./helpers";
import { exportSchematic } from "../src/kicad/exportSch";
import { findKicad } from "../src/kicad/node/install";
import { KicadLibraries } from "../src/kicad/node/libs";
import { inspectProject, writeProject } from "../src/kicad/node/project";

const kicad = findKicad();
const libs = kicad ? new KicadLibraries(kicad) : null;

describe.skipIf(!kicad?.python)("KiCad project write + update", () => {
  it("writes a complete project, then updates it with a change report and stable symbol identities", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-proj-"));
    const { b, R1 } = divider();
    const ex1 = exportSchematic({ project: b.project, name: "div", symbols: libs! });
    const r1 = await writeProject(kicad!, libs!, { dir, name: "div", schText: ex1.text, parts: ex1.parts, expectedNets: ex1.expectedNets, update: false, pcb: true });
    expect("equal" in r1.connectivity && r1.connectivity.equal).toBe(true);
    expect(r1.erc.ok).toBe(true);
    for (const f of ["div.kicad_pro", "div.kicad_sch", "div.kicad_pcb"]) expect(existsSync(path.join(dir, f))).toBe(true);
    const pro = JSON.parse(await fs.readFile(path.join(dir, "div.kicad_pro"), "utf8"));
    expect(pro.meta.filename).toBe("div.kicad_pro");
    expect(r1.pcb && "placed" in r1.pcb && r1.pcb.placed.length).toBe(2);   // R1, R2; V1 is simulation-only
    expect(r1.drc?.ok).toBe(true);

    const existing = await inspectProject(dir, "div");
    expect(existing.exists && existing.hasPcb).toBe(true);
    R1.props.value = "2.2k";
    const R3 = b.place("resistor", "R3", 30, 3, { value: "47k" });
    b.wire(b.pin(R3, "1"), { x: 30, y: 0 }, { x: 10, y: 0 });
    const ex2 = exportSchematic({ project: b.project, name: "div", symbols: libs!, rootUuid: existing.rootUuid });
    // Same component → same symbol UUID across exports, so KiCad and the PCB keep their links.
    expect(ex2.parts.find((p) => p.ref === "R1")!.symbolUuid).toBe(ex1.parts.find((p) => p.ref === "R1")!.symbolUuid);
    const r2 = await writeProject(kicad!, libs!, { dir, name: "div", schText: ex2.text, parts: ex2.parts, expectedNets: ex2.expectedNets, update: true, pcb: true });
    expect("equal" in r2.connectivity && r2.connectivity.equal).toBe(true);
    expect(r2.changes!.added).toEqual(["R3"]);
    expect(r2.changes!.changed).toContain("R1: value 1k → 2.2k");
    expect(r2.backups.length).toBe(2);
    expect(r2.pcb && "placed" in r2.pcb && r2.pcb.placed.filter((p) => p.kept).map((p) => p.ref).sort()).toEqual(["R1", "R2"]);
    expect(r2.drc!.footprintIssues).toEqual([]);
  }, 180000);
});
