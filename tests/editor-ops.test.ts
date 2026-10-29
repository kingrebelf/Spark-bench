import { describe, expect, it } from "vitest";
import "../src/library";
import { computeConnectivity } from "../src/core/connectivity";
import { createProject } from "../src/core/project";
import {
  addWire, cleanupWires, copyItems, hitPin, hitTest, itemsInRect, mirrorItems, moveItems, nextRef, orthogonalize,
  pasteClip, rotateItems, routeAvoiding, routeOrthogonal, rubberBand, simplifyPolyline, type Schematic,
} from "../src/editor/ops";
import { keyOf } from "../src/core/geometry";
import { registerParts } from "../src/core/library";
import { Builder, divider } from "./helpers";
import type { ComponentDef, Point } from "../src/core/types";

const P = (x: number, y: number): Point => ({ x, y });
const isOrthogonal = (pts: Point[]) => pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);
const netSignature = (s: Schematic) => {
  const p = createProject();
  p.schematic = s;
  const c = computeConnectivity(p);
  // nets as sorted lists of "ref:pin" so ids/positions don't matter
  return c.nets.map((n) => n.pins.map((r) => `${s.components.find((x) => x.id === r.componentId)!.ref}:${r.pinId}`).sort().join(" "))
    .filter((x) => x).sort();
};

describe("routing and simplification", () => {
  it("routes with one bend in the requested order", () => {
    expect(routeOrthogonal(P(0, 0), P(5, 3), true)).toEqual([P(0, 0), P(5, 0), P(5, 3)]);
    expect(routeOrthogonal(P(0, 0), P(5, 3), false)).toEqual([P(0, 0), P(0, 3), P(5, 3)]);
    expect(routeOrthogonal(P(0, 0), P(5, 0), false)).toEqual([P(0, 0), P(5, 0)]);
  });
  it("picks the other corner when the preferred one would cross a pin", () => {
    const pin = P(10, 16);
    expect(routeAvoiding(P(20, 16), P(5, 20), true, [pin])).toEqual([P(20, 16), P(20, 20), P(5, 20)]);
    expect(routeAvoiding(P(20, 16), P(5, 20), true, [])).toEqual([P(20, 16), P(5, 16), P(5, 20)]);
  });
  it("drops duplicates and collinear interior points but keeps U-turns", () => {
    expect(simplifyPolyline([P(0, 0), P(0, 0), P(2, 0), P(5, 0), P(5, 3)])).toEqual([P(0, 0), P(5, 0), P(5, 3)]);
    expect(simplifyPolyline([P(0, 0), P(5, 0), P(3, 0)])).toEqual([P(0, 0), P(5, 0), P(3, 0)]);
  });
  it("orthogonalize inserts elbows", () => {
    const out = orthogonalize([P(0, 0), P(4, 0), P(6, 3)]);
    expect(isOrthogonal(out)).toBe(true);
    expect(out[0]).toEqual(P(0, 0));
    expect(out[out.length - 1]).toEqual(P(6, 3));
  });
});

describe("addWire merging", () => {
  it("joins a straight continuation into one wire", () => {
    const s: Schematic = { components: [], labels: [], wires: [{ id: "a", points: [P(0, 0), P(5, 0)] }] };
    const r = addWire(s, [P(5, 0), P(9, 0)]);
    expect(r.wires).toHaveLength(1);
    expect(r.wires[0].points).toEqual([P(0, 0), P(9, 0)]);
    expect(r.id).toBe("a");
  });
  it("joins at a corner too (no anchor there), keeping the bend", () => {
    const s: Schematic = { components: [], labels: [], wires: [{ id: "a", points: [P(0, 0), P(5, 0)] }] };
    const r = addWire(s, [P(5, 0), P(5, 4)]);
    expect(r.wires).toHaveLength(2); // a bend is not a straight continuation
    const r2 = addWire(s, [P(9, 0), P(5, 0)]);
    expect(r2.wires).toHaveLength(1);
    expect([...r2.wires[0].points].sort((a, c) => a.x - c.x)).toEqual([P(0, 0), P(9, 0)]);
  });
  it("does not merge through a pin or a T-junction", () => {
    const b = new Builder();
    const R = b.place("resistor", "R1", 0, 3); // pins at (0,0) and (0,6)
    b.wire(P(0, 0), P(0, -4));
    const r = addWire(b.project.schematic, [P(0, -4), P(0, -8)]);
    expect(r.wires).toHaveLength(1); // merges at (0,-4): nothing else there
    const r2 = addWire(b.project.schematic, [P(0, 6), P(0, 9)]);
    expect(r2.wires).toHaveLength(2); // pin at (0,6)
    void R;
    const s: Schematic = { components: [], labels: [], wires: [{ id: "a", points: [P(0, 0), P(10, 0)] }, { id: "b", points: [P(5, 0), P(5, -5)] }] };
    const r3 = addWire(s, [P(5, 5), P(5, 0)]);
    expect(r3.wires).toHaveLength(3); // (5,0) is on wire a's segment: a junction
  });
  it("cleanupWires removes zero-length wires", () => {
    expect(cleanupWires([{ id: "a", points: [P(1, 1), P(1, 1)] }, { id: "b", points: [P(0, 0), P(1, 0), P(2, 0)] }]))
      .toEqual([{ id: "b", points: [P(0, 0), P(2, 0)] }]);
  });
});

describe("rubber-banding", () => {
  it("slides the neighbouring bend so the wire stays orthogonal", () => {
    const pts = [P(0, 0), P(5, 0), P(5, 5)];
    const out = rubberBand(pts, new Map([[keyOf(P(0, 0)), P(0, 2)]]), new Set());
    expect(out).toEqual([P(0, 2), P(5, 2), P(5, 5)]);
  });
  it("inserts an elbow on a straight two-point wire", () => {
    const out = rubberBand([P(0, 0), P(5, 0)], new Map([[keyOf(P(5, 0)), P(5, 3)]]), new Set());
    expect(isOrthogonal(out)).toBe(true);
    expect(out[0]).toEqual(P(0, 0));
    expect(out[out.length - 1]).toEqual(P(5, 3));
  });
  it("translates rigidly when both ends move together", () => {
    const out = rubberBand([P(0, 0), P(0, 3), P(4, 3)], new Map([[keyOf(P(0, 0)), P(1, 1)], [keyOf(P(4, 3)), P(5, 4)]]), new Set());
    expect(out).toEqual([P(1, 1), P(1, 4), P(5, 4)]);
  });
  it("moving, rotating and mirroring parts keeps every net intact", () => {
    const { b, R1, R2 } = divider();
    const s = b.project.schematic;
    const before = netSignature(s);
    const ids = new Set([R1.id]);
    for (const next of [moveItems(s, ids, 3, -2), moveItems(s, ids, -7, 4), rotateItems(s, ids), mirrorItems(s, new Set([R2.id])), rotateItems(s, new Set([R1.id, R2.id]), true)]) {
      expect(netSignature(next)).toEqual(before);
      for (const w of next.wires) expect(isOrthogonal(w.points)).toBe(true);
    }
  });
  it("pins touching directly get a wire when one part moves", () => {
    const b = new Builder();
    b.place("resistor", "R1", 0, 3);   // pins (0,0) (0,6)
    const R2 = b.place("resistor", "R2", 0, 9); // pins (0,6) (0,12): touches R1 pin 2
    const s = b.project.schematic;
    const before = netSignature(s);
    const next = moveItems(s, new Set([R2.id]), 4, 2);
    expect(next.wires).toHaveLength(1);
    expect(netSignature(next)).toEqual(before);
  });
  it("dragging a wire on its own leaves stubs back to its pins", () => {
    const { b } = divider();
    const s = b.project.schematic;
    const before = netSignature(s);
    const w = s.wires[1]; // R1:2 -> R2:1, vertical
    const next = moveItems(s, new Set([w.id]), 3, 0);
    expect(netSignature(next)).toEqual(before);
  });
  it("mirror is a screen-horizontal flip for rotated parts", () => {
    const b = new Builder();
    // test-local two-pin part so the check doesn't depend on a library symbol's pin order
    const def: ComponentDef = {
      id: "test_polar2", name: "Test polar part", category: "Test", description: "", refPrefix: "D",
      pins: [{ id: "A", name: "A", x: -3, y: 0 }, { id: "K", name: "K", x: 3, y: 0 }],
      symbol: [], props: [], provenance: "none",
    };
    registerParts([def]);
    const D = b.place(def.id, "D1", 0, 0, {}, 90); // A at (0,-3), K at (0,3) when rotated 90
    const s = mirrorItems(b.project.schematic, new Set([D.id]));
    const d2 = s.components[0];
    expect(d2.rotation).toBe(270);
    expect(d2.mirror).toBe(true);
    // a vertical part flipped left-right keeps its pins where they were
    expect(hitPin(s, P(0, -3), 0.1)!.pinId).toBe("A");
    expect(hitPin(s, P(0, 3), 0.1)!.pinId).toBe("K");
  });
});

describe("hit-testing and marquee", () => {
  it("finds pins, wires and parts", () => {
    const { b, R1 } = divider();
    const s = b.project.schematic;
    expect(hitPin(s, P(10.2, 0.1), 0.5)).toMatchObject({ id: R1.id, pinId: "1" });
    expect(hitTest(s, P(10, 3), 0.3)).toMatchObject({ kind: "component", id: R1.id });
    expect(hitTest(s, P(5, 0.1), 0.3)).toMatchObject({ kind: "wire" });
    expect(hitTest(s, P(40, 40), 0.3)).toBeUndefined();
    // a generous tolerance must not let a nearby wire steal clicks on a part body
    expect(hitTest(s, P(10, 2.5), 1)).toMatchObject({ kind: "component", id: R1.id });
  });
  it("inside vs touching marquee", () => {
    const { b, R1 } = divider();
    const s = b.project.schematic;
    const inside = itemsInRect(s, { x: 8, y: -0.5, w: 4, h: 7 }, "inside");
    expect(inside).toContain(R1.id);
    expect(inside.filter((id) => id.startsWith("c_"))).toHaveLength(1);
    const touch = itemsInRect(s, { x: 9, y: 2, w: 2, h: 1 }, "touch");
    expect(touch).toEqual([R1.id]);
  });
});

describe("copy / paste", () => {
  it("assigns fresh ids and next free refs", () => {
    const { b, R1, R2 } = divider();
    const s = b.project.schematic;
    const clip = copyItems(s, new Set([R1.id, R2.id, s.wires[1].id]))!;
    const { schematic, ids } = pasteClip(s, clip, P(30, 0));
    expect(ids).toHaveLength(3);
    const pasted = schematic.components.filter((c) => ids.includes(c.id));
    expect(pasted.map((c) => c.ref).sort()).toEqual(["R3", "R4"]);
    expect(new Set(schematic.components.map((c) => c.id)).size).toBe(schematic.components.length);
    // pasting again keeps numbering going
    const again = pasteClip(schematic, clip, P(50, 0));
    expect(again.schematic.components.filter((c) => again.ids.includes(c.id)).map((c) => c.ref).sort()).toEqual(["R5", "R6"]);
    // the copied wire still joins the two copies
    const pr = pasted.sort((a, c) => a.ref.localeCompare(c.ref));
    const p = createProject(); p.schematic = schematic;
    const conn = computeConnectivity(p);
    expect(conn.pinNet.get(`${pr[0].id}:2`)).toBe(conn.pinNet.get(`${pr[1].id}:1`));
  });
  it("nextRef fills gaps", () => {
    expect(nextRef("R", [{ ref: "R1" }, { ref: "R3" }])).toBe("R2");
  });
});
