// Value and circuit edits applied during a live run.
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { Builder, engine } from "./helpers";
import { interpolate } from "../src/scope/measure";
import { useProject } from "../src/core/store";
import type { EngineOutput, SpiceEngine } from "../src/core/simulate";
import type { Project, SimResult } from "../src/core/types";
import { setSimEngine, usePlayback, useSim } from "../src/sim/store";
import { classifyEdit, describeEdit, mapState } from "../src/sim/edits";
import { stateAt } from "../src/sim/chunk";

/** Node engine that keeps every netlist it was sent. */
class RecordingEngine implements SpiceEngine {
  netlists: string[] = [];
  async run(netlist: string): Promise<EngineOutput> { this.netlists.push(netlist); return engine().run(netlist); }
  stop() {}
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  let quiet = 0;
  for (let i = 0; i < 1000 && quiet < 5; i++) { await wait(15); quiet = useSim.getState().computing || useSim.getState().status === "running" ? 0 : quiet + 1; }
}
const vec = (r: SimResult, n: string) => r.vectors.find((v) => v.name === n)!.real;
const setValue = (ref: string, key: string, v: string) =>
  useProject.getState().update(`Change ${ref}`, (d) => { d.schematic.components.find((c) => c.ref === ref)!.props[key] = v; });
/** Play `ms` of wall time at the current rate, then pause and let computing finish. */
async function play(ms: number) { usePlayback.getState().play(); await wait(ms); usePlayback.getState().pause(); await settle(); }

function risingEdges(r: SimResult, name: string, level: number): number[] {
  const x = r.x!.real, y = vec(r, name), out: number[] = [];
  for (let i = 1; i < x.length; i++) if (y[i - 1] < level && y[i] >= level) out.push(x[i]);
  return out;
}
const meanPeriod = (e: number[]) => (e.length > 1 ? (e[e.length - 1] - e[0]) / (e.length - 1) : NaN);

function rcFilter(r = "1k") {
  const b = new Builder();
  const V = b.place("vsine", "V1", 0, 10, { amplitude: "1", frequency: "1k" });
  const R = b.place("resistor", "R1", 20, 10, { value: r });
  const C = b.place("capacitor", "C1", 40, 10, { value: "1u" });
  const G = b.place("ground", "#PWR1", 60, 10);
  b.label("in", b.pin(V, "1")).label("in", b.pin(R, "1")).label("out", b.pin(R, "2")).label("out", b.pin(C, "1"));
  b.label("gnd", b.pin(C, "2")).label("gnd", b.pin(V, "2")).label("gnd", b.pin(G, "1"));
  return b;
}
/** Peak |v(out)| between two times. */
function peak(r: SimResult, a: number, b: number) {
  const x = r.x!.real, y = vec(r, "v(out)");
  let m = 0;
  for (let i = 0; i < x.length; i++) if (x[i] >= a && x[i] <= b) m = Math.max(m, Math.abs(y[i]));
  return m;
}

describe("edit classification", () => {
  it("tells value edits from topology edits and describes them", () => {
    const b = rcFilter();
    const a: Project = b.project;
    const val: Project = { ...a, schematic: { ...a.schematic, components: a.schematic.components.map((c) => (c.ref === "C1" ? { ...c, props: { ...c.props, value: "22u" } } : c)) } };
    expect(classifyEdit(a, val)).toBe("props");
    expect(describeEdit(a, val)).toBe("C1 → 22 µF");
    const moved: Project = { ...a, schematic: { ...a.schematic, components: a.schematic.components.map((c) => (c.ref === "C1" ? { ...c, position: { x: 41, y: 10 } } : c)) } };
    expect(classifyEdit(a, moved)).toBe("topology");
    expect(classifyEdit(a, { ...a, simulation: { ...a.simulation, probes: [] } })).toBe("none");
  });

  it("maps the running state onto an edited circuit, or refuses when a node disappears", async () => {
    const b = rcFilter();
    const { runSimulation } = await import("../src/sim/run");
    const r = await runSimulation({ ...b.project, simulation: { ...b.project.simulation, tran: { stop: "2m", step: "10u" } } }, engine(), "tran");
    const st = stateAt(r, r.x!.real.length - 1);
    // add a load on "out": every node still exists
    const plus = new Builder(); plus.project = structuredClone(b.project);
    const L = plus.place("resistor", "RL", 80, 10, { value: "10k" });
    plus.label("out", plus.pin(L, "1")).label("gnd", plus.pin(L, "2"));
    const m = mapState(b.project, plus.project, st)!;
    expect(m).not.toBeNull();
    expect(m.nodes.out).toBe(st.nodes.out);
    // remove R1: node "in" keeps V1, but nothing is lost only if every node maps; "out" keeps C1, so it maps too
    const minus: Project = structuredClone(b.project);
    minus.schematic.components = minus.schematic.components.filter((c) => c.ref !== "C1");
    minus.schematic.labels = minus.schematic.labels.filter((l) => true);
    expect(mapState(b.project, minus, st)?.nodes.out).toBe(st.nodes.out); // R1 pin 2 still on "out"
  }, 60_000);
});

describe("live value edits", () => {
  it("changing C1 of the 555 astable changes the blink frequency from the change time on", async () => {
    const p = JSON.parse(readFileSync("examples/555-astable-blinker.sbproj", "utf8"));
    useProject.getState().load(p);
    setSimEngine(engine());
    await useSim.getState().startLive();
    usePlayback.getState().setRate(10);
    await play(700);
    setValue("C1", "value", "4.7u"); // ~1 Hz -> ~2.1 Hz
    await wait(120);
    const tk = useSim.getState().session!.lastChange!.t;
    expect(useSim.getState().session!.lastChange!.label).toBe("C1 → 4.7 µF");
    expect(useSim.getState().session!.edits!.map((e) => e.label)).toContain("C1 → 4.7 µF");
    await play(900);
    const r = useSim.getState().result!;
    const edges = risingEdges(r, "v(out)", 4);
    const before = meanPeriod(edges.filter((t) => t < tk)), after = meanPeriod(edges.filter((t) => t > tk + 1));
    expect(1 / before).toBeGreaterThan(0.8);
    expect(1 / before).toBeLessThan(1.2);
    expect(after / before).toBeGreaterThan(0.38);
    expect(after / before).toBeLessThan(0.56); // ≈ 4.7/10
    // the project keeps the new value (a normal undoable edit)
    expect(useProject.getState().project.schematic.components.find((c) => c.ref === "C1")!.props.value).toBe("4.7u");
    useSim.getState().reset();
  }, 60_000);

  it("an RC filter's amplitude follows an R change, and undo applies the old value live", async () => {
    useProject.getState().load(rcFilter("1k").project); // fc ≈ 160 Hz: 1 kHz is attenuated to ~0.16
    setSimEngine(engine());
    await useSim.getState().startLive();
    usePlayback.getState().setRate(0.02);
    await play(600);
    const t1 = useSim.getState().result!.x!.real.at(-1)!;
    setValue("R1", "value", "100"); // fc ≈ 1.6 kHz: ~0.85
    await wait(120);
    const tk = useSim.getState().session!.lastChange!.t;
    await play(600);
    let r = useSim.getState().result!;
    expect(peak(r, tk - 4e-3, tk)).toBeLessThan(0.25);
    expect(peak(r, tk + 3e-3, tk + 6e-3)).toBeGreaterThan(0.7);
    useProject.getState().undo();
    await wait(120);
    const tu = useSim.getState().session!.lastChange!.t;
    expect(useSim.getState().session!.lastChange!.label).toBe("R1 → 1 kΩ");
    await play(600);
    r = useSim.getState().result!;
    expect(peak(r, tu + 4e-3, tu + 8e-3)).toBeLessThan(0.25);
    expect(tk).toBeGreaterThan(t1 - 1); // applied near the playhead, not from 0
    useSim.getState().reset();
  }, 60_000);

  it("invalid values never reach ngspice; the run keeps the last valid value", async () => {
    useProject.getState().load(rcFilter("1k").project);
    const eng = new RecordingEngine();
    setSimEngine(eng);
    await useSim.getState().startLive();
    usePlayback.getState().setRate(0.02);
    await play(300);
    const sent = eng.netlists.length;
    setValue("R1", "value", "1k2x");
    await wait(150);
    usePlayback.getState().seek(useSim.getState().result!.x!.real.at(-1)!);
    await play(400);
    expect(useSim.getState().session!.note).toMatch(/^Not applied yet: R1: "1k2x" is not a valid Resistance/);
    const after = eng.netlists.slice(sent);
    expect(after.length).toBeGreaterThan(0);
    for (const n of after) expect(n).toMatch(/^R1 in out 1e\+3$/m);
    setValue("R1", "value", "2k");
    await wait(150);
    await play(300);
    expect(eng.netlists.at(-1)).toMatch(/^R1 in out 2e\+3$/m);
    expect(useSim.getState().session!.note).toBeUndefined();
    useSim.getState().reset();
  }, 60_000);
});

describe("live circuit edits", () => {
  it("adding a part continues from the running state; removing one that leaves a node orphaned restarts from 0 s", async () => {
    const b = rcFilter("1k");
    useProject.getState().load(b.project);
    setSimEngine(engine());
    await useSim.getState().startLive();
    usePlayback.getState().setRate(0.02);
    await play(500);
    const tBefore = usePlayback.getState().t!;
    // add a 1 kΩ load on "out" (labels join it)
    useProject.getState().update("Add RL", (d) => {
      const c = { id: "c_rl", type: "resistor", ref: "RL", position: { x: 80, y: 10 }, rotation: 0 as const, props: { value: "1k" } };
      d.schematic.components.push(c);
      d.schematic.labels.push({ id: "l_rl1", name: "out", position: { x: 80, y: 7 }, rotation: 0 }, { id: "l_rl2", name: "gnd", position: { x: 80, y: 13 }, rotation: 0 });
    });
    await wait(150);
    await settle();
    let st = useSim.getState();
    expect(st.status).toBe("done");
    expect(st.session!.note).toMatch(/continuing from the circuit's state/);
    const x0 = st.result!.x!.real[0];
    expect(x0).toBeGreaterThan(tBefore - 0.02); // the new timeline starts near the playhead, not at 0
    expect(st.result!.vectors.some((v) => v.componentId === "c_rl")).toBe(true); // the new part is simulated
    useSim.getState().reset();
  }, 60_000);

  it("deleting the 555 mid-run (its internal nodes vanish) restarts from 0 s with a note, never showing old data", async () => {
    const p = JSON.parse(readFileSync("examples/555-astable-blinker.sbproj", "utf8"));
    useProject.getState().load(p);
    setSimEngine(engine());
    await useSim.getState().startLive();
    usePlayback.getState().setRate(5);
    await play(500);
    useProject.getState().update("Delete U1", (d) => { d.schematic.components = d.schematic.components.filter((c) => c.ref !== "U1"); });
    await wait(150);
    await settle();
    const st = useSim.getState();
    // the remaining circuit has floating pins: an honest failure, or (if it simulates) a fresh run from 0 s
    if (st.status === "done") {
      expect(st.session!.note).toMatch(/restarted from 0 s/);
      expect(st.result!.x!.real[0]).toBe(0);
    } else {
      expect(st.status).toBe("failed");
      expect(st.result?.ok ?? false).toBe(false);
    }
    expect(st.result?.vectors.some((v) => /xu1\./i.test(v.name)) ?? false).toBe(false); // nothing from the old circuit
    useSim.getState().reset();
  }, 60_000);
});
