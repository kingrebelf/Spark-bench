import { describe, expect, it } from "vitest";
import "../src/library";
import { createProject } from "../src/core/project";
import { checkProposal, parseAiResponse, type Proposal } from "../src/ai/proposal";
import { AI_RESPONSE_JSON_SCHEMA } from "../src/ai/schema";
import { comparePartition, layoutProposal, pinPartition } from "../src/ai/layout";
import { runChecks } from "../src/core/checks";
import { computeConnectivity } from "../src/core/connectivity";
import { dividerWithDiode, rcLowPass, reply } from "./aiFixtures";
import { divider } from "./helpers";

const clone = <T>(x: T): T => structuredClone(x);

describe("response schema (strict-mode subset shared by all providers)", () => {
  it("every object is closed and lists every property as required; no unsupported keywords", () => {
    const banned = ["minLength", "maxLength", "minimum", "maximum", "multipleOf", "minItems", "maxItems", "$schema", "$ref", "pattern"];
    const walk = (s: any, path: string) => {
      if (!s || typeof s !== "object") return;
      for (const b of banned) expect(s[b], `${path}.${b}`).toBeUndefined();
      if (s.type === "object") {
        expect(s.additionalProperties, path).toBe(false);
        expect([...s.required].sort(), path).toEqual(Object.keys(s.properties).sort());
        for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
      }
      if (s.items) walk(s.items, `${path}[]`);
      if (s.anyOf) s.anyOf.forEach((v: any, i: number) => walk(v, `${path}|${i}`));
    };
    walk(AI_RESPONSE_JSON_SCHEMA, "$");
  });
});

describe("parseAiResponse", () => {
  it("accepts a well-formed reply (also inside a ```json fence)", () => {
    const text = JSON.stringify(reply(rcLowPass));
    expect(parseAiResponse(text).response?.proposal?.title).toBe("RC low-pass filter");
    expect(parseAiResponse("```json\n" + text + "\n```").response).toBeTruthy();
  });
  it("reports invalid JSON and schema mismatches as errors instead of guessing", () => {
    expect(parseAiResponse("{not json").diagnostics[0].code).toBe("ai-invalid-json");
    const bad = reply(rcLowPass) as any;
    delete bad.proposal.nets;
    const r = parseAiResponse(JSON.stringify(bad));
    expect(r.response).toBeUndefined();
    expect(r.diagnostics[0].code).toBe("ai-schema");
    expect(r.diagnostics[0].message).toContain("nets");
  });
  it("accepts a questions-only reply", () => {
    const r = parseAiResponse(JSON.stringify({ message: "A few questions first.", questions: [{ question: "Supply voltage?", why: "Sets resistor values", options: ["5 V", "12 V"] }], proposal: null }));
    expect(r.response?.questions).toHaveLength(1);
  });
});

describe("checkProposal", () => {
  const empty = createProject();
  it("passes a valid proposal and resolves pin names to ids", () => {
    const p = clone(rcLowPass);
    p.nets[2].pins = ["V1.−", "C1.2"]; // pin name instead of id
    const c = checkProposal(p, empty);
    expect(c.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(c.nets[2].pins).toContainEqual({ ref: "V1", pinId: "2" });
  });
  it("rejects unknown part ids with a message naming the part", () => {
    const p = clone(rcLowPass);
    p.parts[1].type = "resistor_magic";
    const c = checkProposal(p, empty);
    expect(c.ok).toBe(false);
    expect(c.diagnostics.find((d) => d.code === "ai-unknown-part")?.message).toContain("resistor_magic");
  });
  it("rejects unknown pins, unknown props, bad values, pins in two nets and missing ground", () => {
    const p = clone(rcLowPass);
    p.nets[0].pins.push("R1.3");
    p.nets[1].pins.push("V1.1");
    p.parts[1].values.push({ key: "watts", value: "1" });
    p.parts[2].values[0].value = "lots";
    p.nets[2].ground = false;
    p.nets[2].name = "RETURN";
    const codes = checkProposal(p, empty).diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(["ai-unknown-pin", "ai-pin-two-nets", "ai-unknown-prop", "ai-invalid-value", "ai-no-ground"]));
  });
  it("rejects a non-ground net whose name would become ground", () => {
    const p = clone(rcLowPass);
    p.nets[1].name = "gnd";
    expect(checkProposal(p, empty).diagnostics.map((d) => d.code)).toContain("ai-net-name-ground");
  });
  it("refuses to silently drop existing parts", () => {
    const { b } = divider();
    const p: Proposal = { ...clone(rcLowPass) };
    const c = checkProposal(p, b.project);
    expect(c.diagnostics.filter((d) => d.code === "ai-dropped-part").map((d) => d.message).join(" ")).toMatch(/R1|R2|V1/);
  });
});

describe("layout: nets -> placed, wired schematic", () => {
  for (const [name, proposal] of [["RC low-pass", rcLowPass], ["divider with diode", dividerWithDiode]] as const) {
    it(`${name}: recomputed connectivity equals the proposal's nets, and checks pass`, () => {
      const base = createProject();
      const c = checkProposal(proposal, base);
      expect(c.ok).toBe(true);
      const r = layoutProposal(base, proposal, c.nets);
      expect(r.diagnostics).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.style).toBe("wired");
      expect(comparePartition(pinPartition(r.project), c.nets)).toEqual([]);
      expect(runChecks(r.project).filter((d) => d.severity === "error")).toEqual([]);
      // grid integrity and orthogonal wires
      for (const w of r.project.schematic.wires) {
        for (const p of w.points) { expect(Number.isInteger(p.x)).toBe(true); expect(Number.isInteger(p.y)).toBe(true); }
        for (let i = 1; i < w.points.length; i++) expect(w.points[i].x === w.points[i - 1].x || w.points[i].y === w.points[i - 1].y).toBe(true);
      }
      // parts don't overlap
      const comps = r.project.schematic.components.filter((x) => x.type !== "ground");
      const pos = new Set(comps.map((x) => `${x.position.x},${x.position.y}`));
      expect(pos.size).toBe(comps.length);
    });
  }

  it("names nets after the proposal where labels are used and maps every proposal net", () => {
    const c = checkProposal(rcLowPass, createProject());
    const r = layoutProposal(createProject(), rcLowPass, c.nets);
    expect(r.netNames.get("GND")).toBe("0");
    expect(new Set(r.netNames.values()).size).toBe(3);
  });

  it("edits keep existing parts (ids and positions) and their wiring", () => {
    const { b, R1, R2, V1 } = divider();
    const base = b.project;
    const proposal: Proposal = {
      ...clone(dividerWithDiode),
      parts: [
        { ...dividerWithDiode.parts[0], values: [{ key: "value", value: "12" }] },
        { ...dividerWithDiode.parts[1], values: [] },
        { ...dividerWithDiode.parts[2], values: [{ key: "value", value: "2k" }] },
        dividerWithDiode.parts[3],
      ],
      nets: [
        { name: "VIN", ground: false, pins: ["V1.1", "R1.1"] },
        { name: "out", ground: false, pins: ["R1.2", "R2.1", "D1.A"] },
        { name: "GND", ground: true, pins: ["V1.2", "R2.2", "D1.K"] },
      ],
    };
    const c = checkProposal(proposal, base);
    expect(c.ok).toBe(true);
    const r = layoutProposal(base, proposal, c.nets);
    expect(r.ok).toBe(true);
    for (const old of [R1, R2, V1]) {
      const now = r.project.schematic.components.find((x) => x.id === old.id)!;
      expect(now.position).toEqual(old.position);
    }
    expect(r.project.schematic.components.find((x) => x.id === R2.id)!.props.value).toBe("2k");
    expect(r.refToId.get("R1")).toBe(R1.id);
    for (const w of base.schematic.wires) expect(r.project.schematic.wires.some((x) => x.id === w.id)).toBe(true);
    expect(base.schematic.components.length).toBe(4); // base untouched
    expect(comparePartition(pinPartition(r.project), c.nets)).toEqual([]);
  });

  it("splitting an existing net rewires it correctly", () => {
    const { b } = divider();
    // Insert C1 between R1 and R2: R1.2 and R2.1 must no longer touch.
    const proposal: Proposal = {
      ...clone(rcLowPass),
      parts: [
        { ...rcLowPass.parts[1], ref: "V1", type: "vdc", values: [] },
        { ...rcLowPass.parts[1], ref: "R1", values: [] },
        { ...rcLowPass.parts[1], ref: "R2", values: [] },
        { ...rcLowPass.parts[2], ref: "C1" },
      ],
      nets: [
        { name: "VIN", ground: false, pins: ["V1.1", "R1.1"] },
        { name: "A", ground: false, pins: ["R1.2", "C1.1"] },
        { name: "B", ground: false, pins: ["C1.2", "R2.1"] },
        { name: "GND", ground: true, pins: ["V1.2", "R2.2"] },
      ],
      simulations: [],
    };
    const c = checkProposal(proposal, b.project);
    expect(c.ok).toBe(true);
    const r = layoutProposal(b.project, proposal, c.nets);
    expect(r.diagnostics).toEqual([]);
    expect(comparePartition(pinPartition(r.project), c.nets)).toEqual([]);
    expect(computeConnectivity(r.project).unknownParts).toEqual([]);
  });

  it("removing a part cleans up and keeps the rest connected", () => {
    const { b } = divider();
    const proposal: Proposal = {
      ...clone(rcLowPass),
      parts: [
        { ...rcLowPass.parts[1], ref: "V1", type: "vdc", values: [] },
        { ...rcLowPass.parts[1], ref: "R1", values: [] },
      ],
      remove: ["R2"],
      nets: [
        { name: "VIN", ground: false, pins: ["V1.1", "R1.1"] },
        { name: "GND", ground: true, pins: ["V1.2", "R1.2"] },
      ],
      simulations: [],
    };
    const c = checkProposal(proposal, b.project);
    expect(c.ok).toBe(true);
    const r = layoutProposal(b.project, proposal, c.nets);
    expect(r.ok).toBe(true);
    expect(r.project.schematic.components.some((x) => x.ref === "R2")).toBe(false);
    expect(comparePartition(pinPartition(r.project), c.nets)).toEqual([]);
  });
});
