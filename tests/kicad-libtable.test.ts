import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTable } from "../src/kicad/node/libs";
import type { KicadInstall } from "../src/kicad/node/install";

describe("KiCad library tables", () => {
  it("expands KiCad 10 nested (type \"Table\") entries", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sb-libtable-"));
    const template = path.join(dir, "template-sym-lib-table");
    writeFileSync(template, `(sym_lib_table\n\t(version 7)\n\t(lib (name "Device")(type "KiCad")(uri "\${KICAD10_SYMBOL_DIR}/Device.kicad_sym")(options "")(descr ""))\n\t(lib (name "power")(type "KiCad")(uri "\${KICAD10_SYMBOL_DIR}/power.kicad_sym")(options "")(descr ""))\n)\n`);
    const user = path.join(dir, "sym-lib-table");
    writeFileSync(user, `(sym_lib_table\n\t(version 7)\n\t(lib (name "KiCad") (type "Table") (uri "${template.replace(/\/g, "/")}") (options "") (descr "KiCad Default Libraries"))\n\t(lib (name "Mine")(type "KiCad")(uri "C:/libs/mine.kicad_sym")(options "")(descr ""))\n)\n`);
    const k = { symbolDir: "/kicad/symbols", footprintDir: "/kicad/footprints", templateDir: "/kicad/template", shareDir: "/kicad" } as unknown as KicadInstall;
    const libs = readTable(user, k);
    expect(libs.map((l) => l.nickname)).toEqual(["Device", "power", "Mine"]);
    expect(libs[0].uri).toBe("/kicad/symbols/Device.kicad_sym");
  });
});
