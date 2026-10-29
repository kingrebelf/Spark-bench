// ngspice (compiled to WebAssembly by eecircuit-engine) behind the SpiceEngine interface.
// Works in Node (tests) and in a Web Worker (app). One run at a time per instance.
import { Simulation } from "eecircuit-engine";
import { toAsciiNetlist } from "../core/netlist";
import type { EngineOutput, SpiceEngine } from "../core/simulate";

export class EecircuitEngine implements SpiceEngine {
  private sim = new Simulation();
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  start(): Promise<void> {
    this.ready ??= this.sim.start();
    return this.ready;
  }

  run(netlist: string): Promise<EngineOutput> {
    const job = this.queue.then(async () => {
      await this.start();
      // ngspice-WASM hangs forever on non-ASCII bytes; generateNetlist already strips them, this is the backstop.
      this.sim.setNetList(toAsciiNetlist(netlist).text);
      const r = await this.sim.runSim();
      const messages = this.sim.getError().flatMap((s) => s.split("\n"));
      return {
        dataType: r.dataType,
        variableNames: r.variableNames,
        numPoints: r.numPoints,
        data: r.data as EngineOutput["data"],
        messages,
      };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** ngspice banner/version text, for the About box and docs. */
  info(): string { return this.sim.getInitInfo(); }
}
