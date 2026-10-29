# Architecture

```
┌──────────── Electron main (Node) ─────────────┐     ┌──────────── Renderer (React) ─────────────┐
│ electron/main.ts      window, IPC registry    │ IPC │ src/app       shell, file actions, layout │
│ electron/ipc/files.ts open/save/recovery      │◄───►│ src/editor    canvas, library, properties │
│ electron/ipc/kicad.ts kicad-cli, file output  │ sb: │ src/sim       sim panel, worker client    │
│ electron/ipc/ai.ts    keys (safeStorage),     │     │ src/scope     waveform viewer             │
│                       providers, codex        │     │ src/kicad     KiCad import/export         │
└───────────────────────────────────────────────┘     │ src/ai        assistant UI + proposals    │
                                                      │ src/library   part definitions            │
                                                      │ src/core      contracts (no UI)           │
                                                      └──────────┬────────────────────────────────┘
                                                                 │ postMessage
                                                      ┌──────────▼──────────┐
                                                      │ src/sim/worker.ts   │ ngspice-WASM
                                                      └─────────────────────┘
```

## Core contracts (`src/core`)
- `types.ts`: every shared type: `Project`, `ComponentInstance`, `ComponentDef` (pins, symbol, props, SPICE emitter,
  KiCad mapping, provenance), `Diagnostic`, `SimResult`.
- `project.ts`: file format (zod schema), create/serialize/parse with diagnostics for missing parts and models.
- `library.ts`: part registry. Parts register from `src/library/index.ts`.
- `connectivity.ts`: wires + pins + labels → nets (rules in `docs/project-format.md`).
- `checks.ts`: pre-simulation design checks (empty, ground, floating pins, DC path, duplicate refs, unknown parts).
- `netlist.ts`: project → ngspice netlist + element map back to components.
- `simulate.ts`: checks → netlist → engine → classified diagnostics + vectors. Refuses to return data on failure.
- `store.ts`: zustand project store with immer-patch undo/redo. All edits use `update(label, recipe)`.
- `host.ts`: typed bridge to Electron IPC (`window.sparkbench`), absent in plain-browser dev.
- `units.ts`: SI parse/format.

## Simulation pipeline
1. `runChecks` finds topology problems and names the parts involved.
2. `generateNetlist` asks each part's `spice(ctx)` for element lines; `.model`/`.subckt` cards are deduplicated.
3. The engine (ngspice 45 WASM) runs in a worker; messages are classified (`classifyMessages`) into blocking errors,
   warnings and notes. Parse failures, singular matrices, timestep failures, and unknown models are blocking.
4. Vectors are mapped back to net names / component ids.

## Why these choices
- **Electron**: real filesystem access for projects and KiCad output, OS-encrypted credential storage
  (`safeStorage`, DPAPI on Windows), and the ability to run `kicad-cli` and `codex` locally.
- **ngspice (WASM)**: a proven SPICE engine with no install step, same results on every machine. Native ngspice with XSPICE was
  considered for true digital simulation but not required; digital parts are behavioral analog models (clearly labeled).
- **SVG canvas**: crisp symbols at any zoom, easy hit-testing, accessible, and enough for schematic-scale scenes.
