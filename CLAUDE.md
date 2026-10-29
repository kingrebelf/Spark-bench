# SparkBench: working rules for every session

SparkBench is a desktop circuit design + simulation app with KiCad interoperability and an AI assistant.
Stack: Electron 45 + React 19 + TypeScript 7 + Vite 8, zustand/immer state, ngspice 45 compiled to
WebAssembly (`eecircuit-engine`) running in a Web Worker. Tests: vitest (`npm test`), typecheck: `npm run typecheck`.
Read `docs/architecture.md` before changing anything.

## Module ownership (parallel sessions; stay in your lane)
| Area | Owns | Notes |
|---|---|---|
| Hub (coordinator) | `src/core/**`, `src/app/**`, `electron/main.ts`, `electron/preload.ts`, `docs/architecture.md`, `docs/project-format.md`, this file | Other sessions must not edit these. If you need a core change, make the smallest possible change in its own commit with a message starting `core:` and explain it in your final report. |
| Editor | `src/editor/**`, `tests/editor*` | |
| Simulation UX | `src/sim/**`, `src/scope/**`, `tests/sim*` | |
| Library & examples | `src/library/**`, `examples/**`, `tests/library*` | |
| KiCad | `src/kicad/**`, `electron/ipc/kicad.ts`, `tests/kicad*`, `docs/kicad.md` | |
| AI | `src/ai/**`, `electron/ipc/ai.ts`, `tests/ai*`, `docs/ai.md` | |

Integration points that are allowed for everyone (one-line additions only):
- `src/app/App.tsx` → add your panel to `RIGHT_PANELS` or a toolbar button.
- `electron/main.ts` → add one `registerXxxIpc()` call for your `electron/ipc/xxx.ts`.
- IPC channels must start with `sb:<area>:` (preload blocks everything else).

## Non-negotiable product rules
- Never show invented or unverified results. If ngspice fails, show the failure (see `src/core/simulate.ts`).
- Every part declares `provenance` (ideal / generic / behavioral / vendor / none). Never claim a part behaves like a
  specific real device unless it uses that vendor's model.
- Every user-facing problem is a `Diagnostic` with the affected component ids and a plain-language `fix`.
- No placeholder buttons. If a feature isn't done, it isn't shown.
- All schematic edits go through `useProject.getState().update(label, draft => ...)` so they are undoable.
- Coordinates are integer grid units; 1 unit = 1.27 mm (50 mil). Library pin positions match the KiCad symbol's pins.

## Facts established in the hub (don't re-derive)
- ngspice-WASM does analog op/tran/ac correctly. **XSPICE digital code models are NOT available** (`A` devices fail with
  "unknown device type"). Digital parts and the 555 must be behavioral analog subcircuits (B-sources, switches), labeled `behavioral`.
- On a floating circuit ngspice still returns zeros after "singular matrix" warnings; `simulate()` treats this as an error.
- The engine cannot pause mid-run. "Stop" terminates the worker. Pause/speed apply to playback of computed results.
- KiCad **10.0.6** is installed at `C:\Users\benwe\AppData\Local\Programs\KiCad\10.0` (kicad-cli in `bin\`, bundled
  Python in `bin\python.exe`, libraries in `share\kicad\symbols|footprints`). Schematic files are `(version 20250610)`.
- Codex CLI 0.145.0 is installed and logged in with a ChatGPT account (`codex login status`).
- In dev (`npm run dev:web`), `window.__sb` exposes `{ useProject, useSim }` for scripted UI checks.

## Working style
- Commit to your own branch in small, meaningful commits. Run `npm test` and `npm run typecheck` before each commit.
- Images: use the `image-duel` skill (ChatGPT first, local FLUX only as backup) and say which one made each image.
