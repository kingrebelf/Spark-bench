// Every library part's KiCad mapping must point at a symbol and footprint that exist in the
// installed KiCad libraries, with matching pin numbers and pin positions. Skipped without KiCad.
import { describe, expect, it } from "vitest";
import "../src/library";
import { libraryParts } from "../src/library";
import { findSymbol, footprintExists, footprintPads, kicadInstalled, toGrid } from "./libraryKicadLib";

describe("library parts: static contract", () => {
  it("has unique ids and integer pin positions", () => {
    const ids = libraryParts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of libraryParts) {
      for (const pin of p.pins) expect(Number.isInteger(pin.x) && Number.isInteger(pin.y), `${p.id}.${pin.id}`).toBe(true);
      const keys = p.pins.map((q) => `${q.x},${q.y}`);
      expect(new Set(keys).size, `${p.id}: two pins at one point`).toBe(keys.length);
      expect(p.description.length, p.id).toBeGreaterThan(20);
      if (p.provenance !== "ideal" && p.provenance !== "none") expect(p.accuracyNote, `${p.id} needs an accuracy note`).toBeTruthy();
    }
  });
  it("maps every pin to KiCad", () => {
    for (const p of libraryParts) {
      expect(p.kicad, p.id).toBeDefined();
      for (const pin of p.pins) expect(p.kicad!.pinMap[pin.id], `${p.id} pin ${pin.id}`).toBeDefined();
    }
  });
});

describe.skipIf(!kicadInstalled())("library parts vs installed KiCad libraries", () => {
  for (const part of libraryParts) {
    it(`${part.id} → ${part.kicad?.symbol}`, () => {
      const k = part.kicad!;
      const sym = findSymbol(k.symbol);
      expect(sym, `symbol ${k.symbol} not found`).toBeDefined();
      for (const pin of part.pins) {
        const num = k.pinMap[pin.id];
        const kp = sym!.pins.find((q) => q.number === num);
        expect(kp, `${part.id}: KiCad pin ${num} missing in ${k.symbol}`).toBeDefined();
        const g = toGrid(kp!);
        const r = (v: number) => Math.round(v * 1000) / 1000 + 0;
        expect([r(g.x), r(g.y)], `${part.id} pin ${pin.id} (KiCad ${num}) position`).toEqual([pin.x, pin.y]);
      }
      // Unmapped KiCad pins are allowed only when they are hidden/NC or deliberately omitted (555 CONT).
      const mapped = new Set(Object.values(k.pinMap));
      const unmapped = sym!.pins.filter((q) => !mapped.has(q.number) && !q.hidden && (k.unit === undefined || q.unit === k.unit || q.unit === 0 || k.extraUnits?.includes(q.unit)));
      const allowed = (q: { name: string }) => /^(NC|CONT)$/.test(q.name);
      expect(unmapped.filter((q) => !allowed(q)).map((q) => `${q.number}:${q.name}`), `${part.id} leaves KiCad pins unmapped`).toEqual([]);
      if (k.footprint) {
        expect(footprintExists(k.footprint), `footprint ${k.footprint}`).toBe(true);
        const pads = footprintPads(k.footprint);
        for (const num of mapped) expect(pads.has(num), `${part.id}: pad ${num} missing in ${k.footprint}`).toBe(true);
      }
    });
  }
});
