// Schematic-only connectors (no simulation model). They mark where wires leave the board
// and carry the KiCad symbol/footprint for export.
import type { ComponentDef, PinDef, Shape } from "../core/types";
import { circle, hlead, rect, text } from "./util";

/** KiCad Conn_01xNN / Screw_Terminal_01xNN pin rows: pins at x = −4, 2 units apart. */
const rowPins = (count: number): PinDef[] => {
  const top = -Math.floor((count - 1) / 2) * 2;
  return Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: String(i + 1), x: -4, y: top + i * 2 }));
};

function connector(kind: "header" | "terminal", count: number): ComponentDef {
  const pins = rowPins(count);
  const top = pins[0].y - 1, h = count * 2;
  const pad = String(count).padStart(2, "0");
  const symbol: Shape[] = [
    rect(-1.6, top, 2.8, h),
    ...pins.flatMap((p): Shape[] => [hlead(-4, -1.6, p.y), kind === "terminal" ? circle(-0.2, p.y, 0.6) : rect(-1.2, p.y - 0.3, 1.2, 0.6), text(-4, p.y - 0.7, p.id, 0.7, "start")]),
  ];
  const header = kind === "header";
  return {
    id: `${kind}_1x${pad}`,
    name: header ? `Pin Header 1×${count}` : `Screw Terminal 1×${count}`,
    category: "Connectors", refPrefix: "J",
    description: header
      ? `Single-row 2.54 mm pin header with ${count} pins. Schematic only: it is not simulated.`
      : `${count}-way 5 mm screw terminal block for wires. Schematic only: it is not simulated.`,
    keywords: header ? ["header", "connector", "pin", "jumper", "dupont"] : ["terminal", "screw", "connector", "wire", "block"],
    pins, symbol, props: [],
    provenance: "none",
    accuracyNote: "Not simulated. Whatever connects here off-board is not part of the simulation; add a source or load to model it.",
    kicad: header
      ? { symbol: `Connector_Generic:Conn_01x${pad}`, footprint: `Connector_PinHeader_2.54mm:PinHeader_1x${pad}_P2.54mm_Vertical`, pinMap: Object.fromEntries(pins.map((p) => [p.id, p.id])) }
      : { symbol: `Connector:Screw_Terminal_01x${pad}`, footprint: `TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-${count}_1x${pad}_P5.00mm_Horizontal`, pinMap: Object.fromEntries(pins.map((p) => [p.id, p.id])) },
  };
}

export const connectorParts: ComponentDef[] = [
  connector("header", 2), connector("header", 3), connector("header", 4),
  connector("terminal", 2), connector("terminal", 3),
];
