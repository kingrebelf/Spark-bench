/// <reference lib="webworker" />
// Runs ngspice-WASM off the UI thread. Stopping a run = terminating this worker.
import { EecircuitEngine } from "./eecircuitEngine";

const engine = new EecircuitEngine();

self.onmessage = async (e: MessageEvent<{ id: number; netlist?: string; type?: "init" }>) => {
  const { id, netlist, type } = e.data;
  try {
    if (type === "init") { await engine.start(); self.postMessage({ id, ok: true, info: engine.info() }); return; }
    const out = await engine.run(netlist!);
    self.postMessage({ id, ok: true, out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err as Error).message ?? String(err) });
  }
};
