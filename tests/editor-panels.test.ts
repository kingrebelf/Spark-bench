import { describe, expect, it } from "vitest";
import "../src/library";
import { allParts, getPart } from "../src/core/library";
import { partScore } from "../src/editor/LibraryPanel";
import { checkNumber } from "../src/editor/PropertiesPanel";
import type { PropDef } from "../src/core/types";

const res: PropDef = { key: "value", label: "Resistance", kind: "number", unit: "Ω", default: "1k", min: 0 };

describe("property validation", () => {
  it("accepts SI values and reports the parsed number", () => {
    expect(checkNumber("4.7k", res)).toEqual({ value: 4700 });
    expect(checkNumber("1MEG", res).value).toBe(1e6);
  });
  it("rejects text, negatives below min, and empty required values", () => {
    expect(checkNumber("abc", res).error).toMatch(/Not a number/);
    expect(checkNumber("-5", res).error).toMatch(/at least/);
    expect(checkNumber("", res).error).toMatch(/Required/);
  });
  it("warns about milli vs mega and zero-ohm parts", () => {
    expect(checkNumber("10m", res).warning).toMatch(/milli/);
    expect(checkNumber("0", res).warning).toMatch(/Zero/);
  });
  it("optional fields may be empty", () => {
    expect(checkNumber("", { key: "ic", label: "IC", kind: "text", default: "" })).toEqual({});
  });
});

describe("library search ranking", () => {
  it("ranks name prefix above keyword and description hits", () => {
    const r = getPart("resistor")!;
    expect(partScore(r, "res")).toBeGreaterThan(partScore(r, "ohm"));
    expect(partScore(r, "zzz")).toBe(0);
  });
  it("finds parts by keyword and by reference letter", () => {
    const hits = (q: string) => allParts().filter((p) => partScore(p, q) > 0).map((p) => p.id);
    expect(hits("battery")).toContain("vdc");
    expect(hits("gnd")).toContain("ground");
    expect(hits("d")).toContain("diode");
  });
});
