// Mapping review: does every part have an installed KiCad symbol and footprint whose pins and pads
// line up with the part's pins? Problems are Diagnostics with plain-language fixes; the KiCad panel
// lets the user pick replacements, stored in `instance.kicad`.
import { getPart } from "../core/library";
import type { ComponentDef, Diagnostic, Project } from "../core/types";
import { resolveMapping, type ResolvedMapping } from "./common";

/** What the installed libraries say about one symbol (sent over IPC, so plain data). */
export interface SymbolFacts {
  pins: { number: string; name: string; unit: number }[];
  unitCount: number;
  power: boolean;
  onBoard: boolean;
  description: string;
}
export interface LibraryFacts {
  /** null = not installed. */
  symbols: Record<string, SymbolFacts | null>;
  /** Pad numbers; null = not installed. */
  footprints: Record<string, string[] | null>;
}

export interface MappingRow {
  componentId: string;
  ref: string;
  partName: string;
  mapping: ResolvedMapping;
  status: "ok" | "warning" | "error" | "info";
  /** True when the footprint is excluded on purpose (simulation-only source, power symbol). */
  boardless: boolean;
  diagnostics: Diagnostic[];
}

/** Symbol and footprint ids the review needs facts for. */
export function mappingIds(project: Project, lookup: (t: string) => ComponentDef | undefined = getPart) {
  const symbols = new Set<string>(), footprints = new Set<string>();
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    if (!def || def.role === "netlabel") continue;
    const m = resolveMapping(c, def);
    if (m.symbol) symbols.add(m.symbol);
    if (m.footprint) footprints.add(m.footprint);
  }
  return { symbols: [...symbols], footprints: [...footprints] };
}

export function reviewMapping(project: Project, facts: LibraryFacts, lookup: (t: string) => ComponentDef | undefined = getPart): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const c of project.schematic.components) {
    const def = lookup(c.type);
    const d: Diagnostic[] = [];
    const add = (severity: Diagnostic["severity"], code: string, message: string, fix: string) =>
      d.push({ severity, code, message, fix, componentIds: [c.id], source: "kicad" });
    const m = resolveMapping(c, def);
    let boardless = false;
    if (!def) {
      add("error", "kicad-unknown-part", `${c.ref}: part type "${c.type}" is not installed, so it cannot be exported.`, "Install the library that provides it or replace the part.");
      rows.push({ componentId: c.id, ref: c.ref, partName: c.type, mapping: m, status: "error", boardless, diagnostics: d });
      continue;
    }
    if (def.role === "netlabel") continue;
    const sf = m.symbol ? facts.symbols[m.symbol] : undefined;
    if (!m.symbol) {
      add("error", "kicad-no-symbol", `${c.ref} (${def.name}) has no KiCad symbol.`, "Search the installed KiCad symbols below and choose one for this part.");
    } else if (sf === null) {
      add("error", "kicad-symbol-missing", `${c.ref}: KiCad symbol "${m.symbol}" is not in the installed KiCad libraries.`,
        "Search the installed symbols and choose a replacement, or install the library that contains it.");
    }
    if (sf) {
      const units = [m.unit, ...m.extraUnits];
      if (units.some((u) => u > sf.unitCount)) {
        add("error", "kicad-unit-missing", `${c.ref}: KiCad symbol ${m.symbol} has ${sf.unitCount} unit(s), but unit ${Math.max(...units)} is used.`, "Choose a symbol with the right number of units.");
      }
      const missing = Object.entries(m.pinMap).filter(([, n]) => !sf.pins.some((p) => p.number === n));
      if (missing.length) {
        add("error", "kicad-pin-unmapped",
          `${c.ref}: KiCad symbol ${m.symbol} has no pin ${missing.map(([, n]) => n).join(", ")} (needed for ${missing.map(([id]) => def.pins.find((p) => p.id === id)?.name ?? id).join(", ")}).`,
          "Choose a symbol with matching pin numbers; those connections would be missing in KiCad.");
      }
      const used = new Set(sf.pins.filter((p) => p.unit === 0 || units.includes(p.unit)).map((p) => p.number));
      if (!missing.length && used.size !== def.pins.length && !sf.power) {
        add("warning", "kicad-pin-count",
          `${c.ref}: the part has ${def.pins.length} pin(s) but the placed unit(s) of ${m.symbol} have ${used.size}.`,
          used.size > def.pins.length ? "The extra KiCad pins will be left unconnected (ERC may flag them). Choose a closer symbol if that is wrong."
            : "Some part pins have no KiCad pin. Choose a symbol with all of the part's pins.");
      }
      boardless = sf.power || (!m.footprint && (/^Simulation_SPICE:/.test(m.symbol) || !sf.onBoard));
    }
    if (!boardless) {
      if (!m.footprint) {
        add("warning", "kicad-no-footprint", `${c.ref} (${def.name}) has no footprint, so it will be missing from the PCB.`,
          "Search the installed footprints below and choose one (e.g. the package you will buy).");
      } else {
        const pads = facts.footprints[m.footprint];
        if (pads === null) {
          add("error", "kicad-footprint-missing", `${c.ref}: footprint "${m.footprint}" is not in the installed KiCad libraries.`,
            "Search the installed footprints and choose a replacement.");
        } else if (pads && sf) {
          const pinNums = new Set(Object.values(m.pinMap));
          const noPad = [...pinNums].filter((n) => !pads.includes(n));
          if (noPad.length) {
            add("error", "kicad-pad-mismatch", `${c.ref}: footprint ${m.footprint} has no pad ${noPad.join(", ")} for symbol pin(s) with that number.`,
              "Choose a footprint whose pad numbers match the symbol's pin numbers; otherwise those pins are not connected on the PCB.");
          }
        }
      }
    } else if (sf && !sf.power) {
      add("info", "kicad-sim-only", `${c.ref} is a simulation-only part; it is left off the PCB and BOM.`, "Nothing to do. Assign a footprint if it should be on the board.");
    }
    const status = d.some((x) => x.severity === "error") ? "error" : d.some((x) => x.severity === "warning") ? "warning" : d.some((x) => x.severity === "info") ? "info" : "ok";
    rows.push({ componentId: c.id, ref: c.ref, partName: def.name, mapping: m, status, boardless, diagnostics: d });
  }
  return rows;
}
