import { describe, expect, it } from "vitest";
import { Builder, divider, engine } from "./helpers";
import { simulate } from "../src/core/simulate";
import { runChecks } from "../src/core/checks";
import { computeConnectivity } from "../src/core/connectivity";
import { parseProject, serializeProject } from "../src/core/project";
import { partTypes } from "../src/core/library";
import { formatSI, parseSI } from "../src/core/units";

describe("units", () => {
  it("parses SI prefixes", () => {
    expect(parseSI("4.7k")).toBeCloseTo(4700);
    expect(parseSI("10u")).toBeCloseTo(1e-5);
    expect(parseSI("1MEG")).toBe(1e6);
    expect(parseSI("1M")).toBe(1e6);
    expect(parseSI("2.2nF")).toBeCloseTo(2.2e-9);
    expect(parseSI("100 Ω")).toBe(100);
    expect(parseSI("abc")).toBeNaN();
    expect(formatSI(4700, "Ω")).toBe("4.7 kΩ");
    expect(formatSI(0.0005, "A")).toBe("500 µA");
  });
});

describe("connectivity", () => {
  it("joins pins, wires, labels and ground", () => {
    const { b, R1, R2 } = divider();
    const conn = computeConnectivity(b.project);
    const out = conn.pinNet.get(`${R2.id}:1`);
    expect(out).toBe("out");
    expect(conn.pinNet.get(`${R1.id}:2`)).toBe("out");
    expect(conn.pinNet.get(`${R2.id}:2`)).toBe("0");
  });
  it("connects a pin that lands mid-wire (T junction) and draws a dot", () => {
    const b = new Builder();
    b.wire({ x: 0, y: 0 }, { x: 10, y: 0 });
    b.wire({ x: 5, y: 0 }, { x: 5, y: 5 });
    const conn = computeConnectivity(b.project);
    expect(conn.nets.length).toBe(1);
    expect(conn.junctions).toContainEqual({ x: 5, y: 0 });
  });
  it("does not connect crossing wires", () => {
    const b = new Builder();
    b.wire({ x: 0, y: 5 }, { x: 10, y: 5 });
    b.wire({ x: 5, y: 0 }, { x: 5, y: 10 });
    expect(computeConnectivity(b.project).nets.length).toBe(2);
  });
});

describe("checks", () => {
  it("reports missing ground with a fix", () => {
    const { b, G } = divider();
    b.project.schematic.components = b.project.schematic.components.filter((c) => c !== G);
    const d = runChecks(b.project);
    expect(d.find((x) => x.code === "no-ground")?.fix).toMatch(/Ground/);
  });
  it("names a floating pin's component", () => {
    const { b } = divider();
    const R3 = b.place("resistor", "R3", 30, 30);
    const d = runChecks(b.project).filter((x) => x.code === "floating-pin");
    expect(d.length).toBe(2);
    expect(d[0].componentIds).toEqual([R3.id]);
    expect(d[0].message).toContain("R3");
  });
  it("detects a node with no DC path (series capacitor)", () => {
    const b = new Builder();
    const V = b.place("vdc", "V1", 0, 10);
    const C = b.place("capacitor", "C1", 10, 3);
    const R = b.place("capacitor", "C2", 10, 13);
    const G = b.place("ground", "#PWR1", 0, 20);
    b.connect(b.pin(V, "1"), b.pin(C, "1")); b.wire(b.pin(C, "2"), b.pin(R, "1"));
    b.connect(b.pin(R, "2"), b.pin(G, "1")); b.wire(b.pin(V, "2"), b.pin(G, "1"));
    expect(runChecks(b.project).some((x) => x.code === "no-dc-path")).toBe(true);
  });
});

describe("simulation (ngspice WASM)", () => {
  it("resistor divider: 10 V / 2 = 5 V at the midpoint", async () => {
    const { b, V1 } = divider();
    const r = await simulate(b.project, engine(), "op");
    expect(r.ok).toBe(true);
    const out = r.vectors.find((v) => v.netName === "out")!;
    expect(out.real[0]).toBeCloseTo(5, 6);
    const i = r.vectors.find((v) => v.kind === "current" && v.componentId === V1.id)!;
    expect(i.real[0]).toBeCloseTo(-0.005, 6);
  }, 60_000);

  it("RC charging reaches 63.2% of the step after one time constant", async () => {
    const b = new Builder();
    const V = b.place("vpulse", "V1", 0, 10, { low: "0", high: "5", frequency: "10", duty: "50", edge: "1n" });
    const R = b.place("resistor", "R1", 10, 3, { value: "1k" });
    const C = b.place("capacitor", "C1", 10, 13, { value: "1u" });
    const G = b.place("ground", "#PWR1", 0, 20);
    b.connect(b.pin(V, "1"), b.pin(R, "1")); b.wire(b.pin(R, "2"), b.pin(C, "1"));
    b.label("vc", b.pin(C, "1"));
    b.connect(b.pin(C, "2"), b.pin(G, "1")); b.wire(b.pin(V, "2"), b.pin(G, "1"));
    b.project.simulation.tran = { stop: "5m", step: "5u" };
    const r = await simulate(b.project, engine(), "tran");
    expect(r.ok).toBe(true);
    const t = r.x!.real, vc = r.vectors.find((v) => v.netName === "vc")!.real;
    const k = t.findIndex((x) => x >= 1e-3);
    const interp = vc[k - 1] + (vc[k] - vc[k - 1]) * (1e-3 - t[k - 1]) / (t[k] - t[k - 1]);
    expect(interp / 5).toBeCloseTo(1 - Math.exp(-1), 2);
  }, 60_000);

  it("AC: RC low-pass is -3 dB at 1/(2πRC)", async () => {
    const b = new Builder();
    const V = b.place("vsine", "V1", 0, 10, { acmag: "1" });
    const R = b.place("resistor", "R1", 10, 3, { value: "1k" });
    const C = b.place("capacitor", "C1", 10, 13, { value: "1u" });
    const G = b.place("ground", "#PWR1", 0, 20);
    b.connect(b.pin(V, "1"), b.pin(R, "1")); b.wire(b.pin(R, "2"), b.pin(C, "1"));
    b.label("vc", b.pin(C, "1"));
    b.connect(b.pin(C, "2"), b.pin(G, "1")); b.wire(b.pin(V, "2"), b.pin(G, "1"));
    b.project.simulation.ac = { sweep: "lin", points: 1, start: String(1 / (2 * Math.PI * 1e-3)), stop: String(1 / (2 * Math.PI * 1e-3)) };
    const r = await simulate(b.project, engine(), "ac");
    expect(r.ok).toBe(true);
    const v = r.vectors.find((x) => x.netName === "vc")!;
    expect(Math.hypot(v.real[0], v.imag![0])).toBeCloseTo(Math.SQRT1_2, 3);
  }, 60_000);

  it("refuses to simulate a floating circuit instead of showing numbers", async () => {
    const { b } = divider();
    b.place("resistor", "R9", 40, 40);
    const r = await simulate(b.project, engine(), "op");
    expect(r.ok).toBe(false);
    expect(r.vectors).toEqual([]);
    expect(r.diagnostics.some((d) => d.code === "floating-pin")).toBe(true);
  }, 60_000);

  it("reports a bad value without calling the engine", async () => {
    const { b, R1 } = divider();
    R1.props.value = "4.7 bananas";
    const r = await simulate(b.project, engine(), "op");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === "invalid-value")?.componentIds).toEqual([R1.id]);
  }, 60_000);

  it("surfaces ngspice errors (singular matrix) as blocking", async () => {
    // No ground at all: ngspice falls back to "transient op" and returns zeros, which must not be shown.
    const out = await engine().run("bad\nR1 a b 1k\n.op\n.end\n");
    const { classifyMessages } = await import("../src/core/simulate");
    const d = classifyMessages(out.messages);
    expect(d.some((x) => x.code === "spice-singular" && x.severity === "error")).toBe(true);
  }, 60_000);
});

describe("project format", () => {
  it("round-trips through save and load", () => {
    const { b } = divider();
    const text = serializeProject(b.project);
    const { project, diagnostics } = parseProject(text, partTypes());
    expect(diagnostics).toEqual([]);
    expect(project!.schematic).toEqual(b.project.schematic);
  });
  it("flags unknown part types and missing models on open", () => {
    const { b, R1 } = divider();
    R1.type = "flux_capacitor";
    b.project.schematic.components[0].modelId = "gone";
    const { diagnostics } = parseProject(serializeProject(b.project), partTypes());
    expect(diagnostics.map((d) => d.code).sort()).toEqual(["project-missing-model", "project-missing-part"]);
  });
  it("rejects damaged files with a readable message", () => {
    expect(parseProject("{not json").diagnostics[0].code).toBe("project-json");
    expect(parseProject("{}").diagnostics[0].code).toBe("project-schema");
  });
});
