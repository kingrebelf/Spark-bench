// Canned model replies for the AI tests (shaped exactly like real provider output).
import type { AiResponse, Proposal } from "../src/ai/proposal";

const part = (ref: string, type: string, values: Record<string, string>, role: string, uncertain = false): Proposal["parts"][number] => ({
  ref, type, values: Object.entries(values).map(([key, value]) => ({ key, value })), role, uncertain,
  uncertaintyNote: uncertain ? "Depends on the load." : "", kicadFootprint: null, kicadSymbol: null,
});

/** 1 kHz RC low-pass driven by a sine source, with a divider-like DC check. */
export const rcLowPass: Proposal = {
  title: "RC low-pass filter",
  summary: "A first-order RC low-pass filter with a 1.59 kHz corner.",
  assumptions: ["Signal source is 1 V peak", "Load is high impedance"],
  parts: [
    part("V1", "vsine", { amplitude: "1", frequency: "1k", acmag: "1" }, "Test signal"),
    part("R1", "resistor", { value: "1k" }, "Series resistance of the filter"),
    part("C1", "capacitor", { value: "100n" }, "Shunt capacitor of the filter", true),
  ],
  remove: [],
  nets: [
    { name: "IN", ground: false, pins: ["V1.1", "R1.1"] },
    { name: "OUT", ground: false, pins: ["R1.2", "C1.1"] },
    { name: "GND", ground: true, pins: ["V1.2", "C1.2"] },
  ],
  simulations: [{
    description: "Frequency response",
    analysis: "ac",
    tran: null,
    ac: { start: "10", stop: "1MEG", pointsPerDecade: 20 },
    expectations: [
      { description: "-3 dB near 1.59 kHz", net: "OUT", measure: "f_3db", min: 1400, max: 1800, frequency: null },
      { description: "Passband gain about 0 dB", net: "OUT", measure: "gain_db_at", min: -0.5, max: 0.1, frequency: 10 },
    ],
  }],
  kicadNotes: ["Use a C0G capacitor for a stable corner frequency."],
};

/** 12 V -> 5 V divider plus a diode clamp; four parts, a shared node with three pins. */
export const dividerWithDiode: Proposal = {
  title: "Divider with clamp",
  summary: "Divides 12 V and clamps with a diode.",
  assumptions: [],
  parts: [
    part("V1", "vdc", { value: "12" }, "Supply"),
    part("R1", "resistor", { value: "7k" }, "Top of divider"),
    part("R2", "resistor", { value: "5k" }, "Bottom of divider"),
    part("D1", "diode", {}, "Clamp"),
  ],
  remove: [],
  nets: [
    { name: "VIN", ground: false, pins: ["V1.1", "R1.1"] },
    { name: "MID", ground: false, pins: ["R1.2", "R2.1", "D1.A"] },
    { name: "GND", ground: true, pins: ["V1.2", "R2.2", "D1.K"] },
  ],
  simulations: [{
    description: "Operating point", analysis: "op", tran: null, ac: null,
    expectations: [{ description: "Diode clamps the midpoint near 0.7 V", net: "MID", measure: "op", min: 0.5, max: 0.9, frequency: null }],
  }],
  kicadNotes: [],
};

export const reply = (proposal: Proposal | null, message = "Here is a design."): AiResponse => structuredClone({ message, questions: [], proposal });
