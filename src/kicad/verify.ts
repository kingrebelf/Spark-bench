// Compare the connectivity KiCad computes for an exported schematic with SparkBench's own nets.
import type { SchExport } from "./exportSch";
import { comparePartitions, mergedKicadPartition, parseKicadNetlist, parseSpiceNetlist, type NetCompare } from "./netlist";

export interface ConnectivityCheck extends NetCompare {
  /** Plain-language summary for the UI. */
  summary: string;
  checkedPins: number;
}

/** Sorted "REF:pin" lists formatted for people: "R1 pin 2, C3 pin 1". */
export const describeGroup = (g: string[]) => g.map((x) => x.replace(":", " pin ")).join(", ");

export function verifyConnectivity(ex: Pick<SchExport, "expectedNets" | "parts">, boardNetlist: string, spiceNetlist: string | null): ConnectivityCheck {
  const board = parseKicadNetlist(boardNetlist);
  const spice = spiceNetlist ? parseSpiceNetlist(spiceNetlist) : null;
  const simOnly = ex.parts.filter((p) => p.simOnly).map((p) => ({ ref: p.ref, ...p.simOnly! }));
  const actual = mergedKicadPartition(board, spice, simOnly);
  const cmp = comparePartitions(ex.expectedNets, actual);
  const checkedPins = ex.expectedNets.reduce((n, g) => n + g.length, 0);
  const summary = cmp.equal
    ? `KiCad's netlist matches SparkBench exactly: ${ex.expectedNets.length} nets, ${checkedPins} pins.`
    : `KiCad's netlist differs from SparkBench: ${cmp.onlyInSparkbench.length} SparkBench net(s) are connected differently in KiCad.`;
  return { ...cmp, summary, checkedPins };
}
