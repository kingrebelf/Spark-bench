import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTable } from "../src/kicad/node/libs";
import type { KicadInstall } from "../src/kicad/node/install";

const lib = (name: string, type: string, uri: string) => `\t(lib (name "${name}") (type "${type}") (uri "${uri}") (options "") (descr ""))`;

describe("KiCad library tables", () => {
  it("expands KiCad 10 nested (type \"Table\") entries", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sb-libtable-"));
    const template = path.join(dir, "template-sym-lib-table");
    writeFileSync(template, ["(sym_lib_table", "\t(version 7)",
      lib("Device", "KiCad", "${KICAD10_SYMBOL_DIR}/Device.kicad_sym"),
      lib("power", "KiCad", "${KICAD10_SYMBOL_DIR}/power.kicad_sym"), ")", ""].join("\n"));
    const user = path.join(dir, "sym-lib-table");
    writeFileSync(user, ["(sym_lib_table", "\t(version 7)",
      lib("KiCad", "Table", template.split(path.sep).join("/")),
      lib("Mine", "KiCad", "C:/libs/mine.kicad_sym"), ")", ""].join("\n"));
    const k = { symbolDir: "/kicad/symbols", footprintDir: "/kicad/footprints", templateDir: "/kicad/template", shareDir: "/kicad" } as unknown as KicadInstall;
    const libs = readTable(user, k);
    expect(libs.map((l) => l.nickname)).toEqual(["Device", "power", "Mine"]);
    expect(libs[0].uri).toBe("/kicad/symbols/Device.kicad_sym");
  });
});
