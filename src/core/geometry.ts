import type { ComponentDef, ComponentInstance, Point, Rotation } from "./types";

/** Rotate (and optionally mirror across Y) a local point. Positive rotation is clockwise on screen (y down). */
export function transformPoint(p: Point, rotation: Rotation, mirror = false): Point {
  const x = mirror ? -p.x : p.x;
  const y = p.y;
  switch (rotation) {
    case 0: return { x, y };
    case 90: return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
  }
}

export function pinWorldPosition(inst: ComponentInstance, def: ComponentDef, pinId: string): Point | undefined {
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return undefined;
  const t = transformPoint(pin, inst.rotation, inst.mirror);
  return { x: inst.position.x + t.x, y: inst.position.y + t.y };
}

export const keyOf = (p: Point) => `${p.x},${p.y}`;

/** True when p lies on segment a-b (axis-aligned or diagonal), endpoints included. */
export function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 1e-9) return false;
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
