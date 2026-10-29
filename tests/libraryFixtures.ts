// Helpers for library simulation tests: build circuits by labeling pins with net names,
// so tests don't need hand-routed wires. Labels named GND are ground.
import { Builder } from "./helpers";
import { getPart } from "../src/core/library";
import type { ComponentInstance, PropValue, SimResult, Vector } from "../src/core/types";

export class NetBuilder extends Builder {
  private x = 0;
  /** Place a part far from the others and label its pins: nets = { pinId: netName }. */
  add(type: string, ref: string, nets: Record<string, string>, props: Record<string, PropValue> = {}): ComponentInstance {
    const c = this.place(type, ref, this.x, 0, props);
    this.x += 40;
    const def = getPart(type)!;
    for (const pin of def.pins) {
      const net = nets[pin.id];
      if (net === undefined) throw new Error(`${ref}: no net for pin ${pin.id}`);
      this.label(net, this.pin(c, pin.id));
    }
    return c;
  }
  r(ref: string, a: string, b: string, value: string) { return this.add("resistor", ref, { 1: a, 2: b }, { value }); }
  c(ref: string, a: string, b: string, value: string) { return this.add("capacitor", ref, { 1: a, 2: b }, { value }); }
  v(ref: string, plus: string, minus: string, value: string | number) { return this.add("vdc", ref, { 1: plus, 2: minus }, { value: String(value) }); }
}

export const vec = (r: SimResult, net: string): Vector => {
  const v = r.vectors.find((x) => x.kind === "voltage" && x.netName?.toLowerCase() === net.toLowerCase());
  if (!v) throw new Error(`no vector for ${net}; have ${r.vectors.map((x) => x.netName ?? x.name).join(", ")}; diagnostics: ${JSON.stringify(r.diagnostics)}`);
  return v;
};
export const opValue = (r: SimResult, net: string) => vec(r, net).real[0];

/** Value of a vector at time t (linear interpolation). */
export function at(r: SimResult, net: string, t: number): number {
  const ts = r.x!.real, v = vec(r, net).real;
  const k = ts.findIndex((x) => x >= t);
  if (k <= 0) return v[Math.max(0, k)];
  return v[k - 1] + (v[k] - v[k - 1]) * (t - ts[k - 1]) / (ts[k] - ts[k - 1]);
}

/** Times where the vector crosses `level` going up (rising) or down. */
export function crossings(r: SimResult, net: string, level: number, dir: "rise" | "fall" = "rise"): number[] {
  const ts = r.x!.real, v = vec(r, net).real, out: number[] = [];
  for (let i = 1; i < v.length; i++) {
    const up = v[i - 1] < level && v[i] >= level, down = v[i - 1] > level && v[i] <= level;
    if ((dir === "rise" && up) || (dir === "fall" && down)) out.push(ts[i - 1] + (level - v[i - 1]) * (ts[i] - ts[i - 1]) / (v[i] - v[i - 1]));
  }
  return out;
}

export const errorsOf = (r: SimResult) => r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);
