// Screenshot scenes for the README. Each scene loads a project, optionally runs a simulation,
// switches the right panel and captures one PNG into docs/images/.
//
// `project` is either a path under examples/ (preferred, once the library ships them) or a
// function returning an inline fallback project so the pipeline works on any checkout.
// Scenes whose UI isn't present (e.g. a panel tab that doesn't exist yet) are skipped with a warning,
// never captured half-empty.

const now = new Date(0).toISOString();
const meta = (name, description = "") => ({ name, created: now, modified: now, appVersion: "0.1.0", description });

/** RC low-pass: square-wave source (sine with AC magnitude 1 for AC analysis) → 1k → 100n to ground. Used when examples/ isn't available. */
export function rcLowpass(analysis = "tran") {
  return {
    format: "sparkbench-project",
    version: 1,
    meta: meta("RC low-pass filter", "First-order RC filter, fc ≈ 1.6 kHz"),
    schematic: {
      components: [
        { id: "c_v1", type: analysis === "ac" ? "vsine" : "vpulse", ref: "V1", position: { x: 0, y: 1 }, rotation: 0, mirror: false, props: {} },
        { id: "c_r1", type: "resistor", ref: "R1", position: { x: 7, y: -3 }, rotation: 90, mirror: false, props: { value: "1k" } },
        { id: "c_c1", type: "capacitor", ref: "C1", position: { x: 14, y: 1 }, rotation: 0, mirror: false, props: { value: "100n" } },
        { id: "c_g1", type: "ground", ref: "#PWR1", position: { x: 0, y: 7 }, rotation: 0, mirror: false, props: {} },
        { id: "c_g2", type: "ground", ref: "#PWR2", position: { x: 14, y: 7 }, rotation: 0, mirror: false, props: {} },
      ],
      wires: [
        { id: "w1", points: [{ x: 0, y: -3 }, { x: 4, y: -3 }] },
        { id: "w2", points: [{ x: 10, y: -3 }, { x: 14, y: -3 }, { x: 14, y: -2 }] },
        { id: "w3", points: [{ x: 0, y: 5 }, { x: 0, y: 7 }] },
        { id: "w4", points: [{ x: 14, y: 4 }, { x: 14, y: 7 }] },
      ],
      labels: [{ id: "l_out", name: "out", position: { x: 14, y: -3 }, rotation: 0 }],
    },
    simulation: {
      analysis,
      tran: { stop: "2m", step: "2u", start: "0", uic: false },
      ac: { sweep: "dec", points: 40, start: "10", stop: "1MEG" },
      probes: [{ id: "p_out", kind: "voltage", target: { netName: "out" }, label: "Vout", color: "#4fc3f7" }],
    },
    models: [],
    kicad: { notes: [] },
  };
}

/** Same filter with the ground removed: triggers a clear "no ground" diagnostic. */
export function rcFloating() {
  const p = rcLowpass("tran");
  p.meta = meta("RC filter (missing ground)");
  p.schematic.components = p.schematic.components.filter((c) => c.type !== "ground");
  return p;
}

export const scenes = [
  { name: "editor", title: "Schematic editor", project: ["examples/rc-lowpass.sbproj", () => rcLowpass("tran")], panel: "Properties" },
  { name: "library", title: "Component library", project: ["examples/rc-lowpass.sbproj", () => rcLowpass("tran")], search: "source" },
  { name: "properties", title: "Properties panel", project: ["examples/rc-lowpass.sbproj", () => rcLowpass("tran")], select: "R1", panel: "Properties" },
  { name: "transient", title: "Transient scope", project: ["examples/rc-lowpass.sbproj", () => rcLowpass("tran")], run: "tran", cursors: true },
  { name: "bode", title: "AC Bode plot", project: ["examples/rc-lowpass.sbproj", () => rcLowpass("ac")], run: "ac" },
  { name: "diagnostics", title: "Diagnostics", project: [null, rcFloating], run: "tran", expectFail: true },
  { name: "kicad", title: "KiCad export", project: ["examples/rc-lowpass.sbproj", () => rcLowpass("tran")], panel: "KiCad" },
  { name: "ai", title: "AI assistant", project: ["examples/rc-lowpass.sbproj", () => rcLowpass("tran")], panel: "AI" },
];
