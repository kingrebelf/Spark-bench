// Shared KiCad test fixtures.
import { Builder } from "./helpers";
// A dual op-amp mapped like the library session's LM358: unit 1 placed, power unit 3 as an extra unit.
import { registerParts } from "../src/core/library";
import type { ComponentDef } from "../src/core/types";
export const testOpamp: ComponentDef = {
  id: "test_lm358", name: "LM358 (test)", category: "Test", description: "", refPrefix: "U", provenance: "behavioral",
  pins: [
    { id: "OUT", name: "OUT", x: 6, y: 0 }, { id: "IN-", name: "-", x: -6, y: 2 }, { id: "IN+", name: "+", x: -6, y: -2 },
    { id: "V+", name: "V+", x: -2, y: -6 }, { id: "V-", name: "V-", x: -2, y: 6 },
  ],
  symbol: [], props: [],
  kicad: { symbol: "Amplifier_Operational:LM358", footprint: "Package_DIP:DIP-8_W7.62mm", unit: 1, extraUnits: [3],
    pinMap: { OUT: "1", "IN-": "2", "IN+": "3", "V+": "8", "V-": "4" } },
};
registerParts([testOpamp]);

export function opampCircuit() {
  const b = new Builder();
  const VS = b.place("vdc", "V1", -20, 0, { value: "12" });
  const VIN = b.place("vsine", "V2", -14, 10, {});
  const U = b.place("test_lm358", "U1", 0, 0);
  const RL = b.place("resistor", "R1", 12, 6, { value: "10k" });
  const G = b.place("ground", "#PWR1", -14, 20);
  b.connect(b.pin(VS, "1"), b.pin(U, "V+"));
  b.label("GND", b.pin(VS, "2"));
  b.connect(b.pin(U, "V-"), { x: -2, y: 8 });
  b.label("GND", { x: -2, y: 8 });
  b.connect(b.pin(VIN, "1"), b.pin(U, "IN+"));
  b.connect(b.pin(VIN, "2"), b.pin(G, "1"));
  b.wire(b.pin(U, "OUT"), { x: 12, y: 0 }, b.pin(RL, "1"));
  b.wire({ x: 8, y: 0 }, { x: 8, y: 4 }, { x: -8, y: 4 }, { x: -8, y: 2 }, b.pin(U, "IN-"));
  b.label("GND", b.pin(RL, "2"));
  return { b, U };
}

