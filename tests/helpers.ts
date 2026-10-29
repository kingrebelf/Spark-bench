// Small builder for test circuits. Parts are placed vertically; wires are given explicitly.
import "../src/library";
import { createProject, newId } from "../src/core/project";
import { getPart } from "../src/core/library";
import { pinWorldPosition } from "../src/core/geometry";
import type { ComponentInstance, Point, Project, PropValue, Rotation } from "../src/core/types";
import { EecircuitEngine } from "../src/sim/eecircuitEngine";

let shared: EecircuitEngine | null = null;
export const engine = () => (shared ??= new EecircuitEngine());

export class Builder {
  project: Project = createProject("test");
  place(type: string, ref: string, x: number, y: number, props: Record<string, PropValue> = {}, rotation: Rotation = 0): ComponentInstance {
    const c: ComponentInstance = { id: newId("c"), type, ref, position: { x, y }, rotation, props };
    this.project.schematic.components.push(c);
    return c;
  }
  pin(c: ComponentInstance, pinId: string): Point {
    return pinWorldPosition(c, getPart(c.type)!, pinId)!;
  }
  wire(...pts: Point[]) {
    this.project.schematic.wires.push({ id: newId("w"), points: pts });
    return this;
  }
  /** Straight or L-shaped wire between two pins (vertical leg first). */
  connect(a: Point, b: Point) {
    if (a.x === b.x || a.y === b.y) return this.wire(a, b);
    return this.wire(a, { x: a.x, y: b.y }, b);
  }
  label(name: string, at: Point) {
    this.project.schematic.labels.push({ id: newId("l"), name, position: at, rotation: 0 });
    return this;
  }
}

/** V1 (10 V) -> R1 -> out -> R2 -> gnd. Returns builder and parts. */
export function divider(v = "10", r1 = "1k", r2 = "1k") {
  const b = new Builder();
  const V1 = b.place("vdc", "V1", 0, 10, { value: v });
  const R1 = b.place("resistor", "R1", 10, 3, { value: r1 });
  const R2 = b.place("resistor", "R2", 10, 13, { value: r2 });
  const G = b.place("ground", "#PWR1", 0, 20);
  b.connect(b.pin(V1, "1"), b.pin(R1, "1"));     // (0,6) -> (0,0) -> (10,0)
  b.wire(b.pin(R1, "2"), b.pin(R2, "1"));        // (10,6)-(10,10)
  b.label("out", b.pin(R2, "1"));
  b.connect(b.pin(R2, "2"), b.pin(G, "1"));
  b.wire(b.pin(V1, "2"), b.pin(G, "1"));
  return { b, V1, R1, R2, G };
}
