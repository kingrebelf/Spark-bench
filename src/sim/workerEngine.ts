// SpiceEngine backed by a Web Worker. `stop()` terminates a running simulation
// (ngspice-WASM has no cooperative pause), and the next run starts a fresh worker.
import type { EngineOutput, SpiceEngine } from "../core/simulate";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class WorkerEngine implements SpiceEngine {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.out ?? e.data.info); else p.reject(new Error(e.data.error));
    };
    w.onerror = (e) => { for (const p of this.pending.values()) p.reject(new Error(e.message || "Simulation worker crashed")); this.pending.clear(); this.worker = null; };
    this.worker = w;
    return w;
  }

  private call<T>(msg: object): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ensure().postMessage({ id, ...msg });
    });
  }

  /** Load the engine ahead of the first run; resolves with ngspice's banner text. */
  init(): Promise<string> { return this.call<string>({ type: "init" }); }
  run(netlist: string): Promise<EngineOutput> { return this.call<EngineOutput>({ netlist }); }

  get busy(): boolean { return this.pending.size > 0; }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("Simulation stopped by user"));
    this.pending.clear();
  }
}

export const workerEngine = new WorkerEngine();
