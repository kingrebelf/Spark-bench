# KiCad integration

SparkBench exports a circuit to a complete KiCad project (schematic, project file, optional PCB), checks the
result with KiCad's own tools, updates an existing KiCad project, and imports KiCad schematics. Everything is
in the **KiCad** side panel of the desktop app. Code: `src/kicad/**` (pure, renderer-safe), `src/kicad/node/**`
(Node only: files, `kicad-cli`, pcbnew), `electron/ipc/kicad.ts` (IPC channels `sb:kicad:*`).

## Supported versions

| KiCad | Status |
|---|---|
| **10.0.x** | Target. Developed and tested against 10.0.6 on Windows. Output uses KiCad 10's formats: schematic `(version 20260306)`, board `(version 20260206)` (the versions KiCad 10.0.6 itself writes). |
| 9.x and older | **Not supported for opening the output.** KiCad refuses files whose format version is newer than it knows, so the exported files are expected not to open in 9.x. Not tested (no 9.x install was available). Import of 9.x schematics (`20250114`) works: the KiCad demo files are 9.x files and are used in the tests. |

Installation discovery: `SPARKBENCH_KICAD_DIR` (if set), the Windows uninstall registry entries (HKCU/HKLM
`InstallLocation`), then the usual folders (`%LOCALAPPDATA%\Programs\KiCad\<ver>`, `%ProgramFiles%\KiCad\<ver>`,
`/Applications/KiCad`, `/usr`). The newest working `kicad-cli` wins. If none is found the panel says so and
shows no KiCad actions. PCB generation needs KiCad's bundled Python with `pcbnew` (`bin\python.exe` on Windows).

## Export (SparkBench → KiCad)

Writes `<name>.kicad_pro`, `<name>.kicad_sch` and, if chosen, `<name>.kicad_pcb` into a folder.

- **Schematic.** Symbols are copied from the installed `.kicad_sym` libraries into the schematic's `lib_symbols`
  (derived `extends` symbols are flattened the way KiCad does it). Each part gets Reference, Value, Footprint,
  Datasheet/Description from the library, custom fields from the part mapping, pin UUIDs and an `instances`
  block. Only Reference and Value are visible; Footprint, Datasheet, `Sim.*` and custom fields are hidden.
  Wires, junctions, net labels and ground symbols (`power:GND`) are written. SparkBench labels that mean
  ground (`GND`, `gnd`, `0`) become `power:GND` symbols: checked with kicad-cli, KiCad 10 joins only a label
  named exactly `GND` to the GND power net, while `gnd` or `0` would be separate nets there.
- **Grid.** 1 SparkBench grid unit = 1.27 mm, so every pin stays on KiCad's default 50 mil grid. The drawing is
  shifted by a whole number of grid units to sit on the sheet; the paper size (A4…A0) follows the drawing size.
- **Exact connectivity.** Every wire is split at each pin, wire vertex or label lying on it, so every KiCad
  connection is endpoint-to-endpoint (no reliance on T-junction rules). The symbol orientation (KiCad angle +
  mirror) is chosen from the real library pin positions. If a part's pins do not sit where the KiCad symbol has
  them, those pins are tied with net labels and a warning says so.
- **Multi-unit symbols** (`KicadMapping.unit`, `extraUnits`, e.g. LM358/TL072): the main unit is placed where the
  part is; extra units (power units) are placed beside the drawing with the same reference, their pins tied with
  net labels.
- **Stable identities.** Symbol and pin UUIDs are derived from SparkBench component ids, so re-exports keep the
  same UUIDs and KiCad's own *Update PCB from Schematic* recognises the footprints.
- **Simulation fields** (KiCad's ngspice integration):
  - DC/sine/pulse sources → `Sim.Device V`, `Sim.Type DC|SIN|PULSE`, `Sim.Params` (names from KiCad's
    `Simulation_SPICE` symbols).
  - R/C/L → numeric Value (KiCad infers the model).
  - Diodes, LEDs, zeners, Schottkys and BJTs whose SparkBench model is a plain `.model` card → KiCad's built-in
    `D`/`NPN`/`PNP` (Gummel-Poon) models with the same parameters (a diode's grading coefficient is written `mj`;
    `m` would be read by KiCad as the instance multiplier) and `Sim.Pins` from the SPICE node order.
  - Other sources whose SPICE line is a plain DC and/or PULSE source (DC current source, triangle/sawtooth source)
    → KiCad `V`/`I` DC or PULSE with the same numbers.
  - The analysis becomes a text directive (`.op`, `.tran …`, `.ac …`).
  - Not mapped (KiCad will ask for a model, or use its own): op-amps, logic, 555 and other behavioural
    subcircuits; MOSFETs (SparkBench ties bulk to source, which a 3-pin KiCad symbol cannot express); switches,
    meters, transformers. Where the KiCad symbol carries its own default `Sim.*` settings (e.g.
    `Simulation_SPICE:OPAMP` → KiCad's built-in op-amp), the export note says they do not reflect the SparkBench
    part's model. Capacitor initial voltages, probes and imported vendor model files are not transferred.
- **Simulation-only sources** (`Simulation_SPICE:*` without a footprint) are written with `on_board no` /
  `in_bom no`, so they stay off the PCB and BOM. A part that has a footprint is always put on the board, even
  if its library symbol is marked `on_board no`.
- **Library tables.** If KiCad has no global `sym-lib-table`/`fp-lib-table` yet (fresh install), project tables
  listing only the used KiCad libraries (through `${KICAD10_SYMBOL_DIR}` / `${KICAD10_FOOTPRINT_DIR}`) are written,
  so the project resolves its libraries in KiCad and `kicad-cli`.

### Verification after every export

1. `kicad-cli sch erc`: errors and warnings are shown as KiCad reports them (e.g. "power pin not driven",
   unconnected pins). Positions in kicad-cli's JSON are not used (with `--units mm` they come out scaled by 1/100
   in 10.0.6). Reports and netlists are written to a temporary folder, never into the project folder.
2. `kicad-cli sch export netlist` (board netlist + SPICE netlist): KiCad's connectivity is compared with
   SparkBench's nets as sets of `REF:pin` groups. The board netlist omits `on_board no` symbols, so those come
   from the SPICE netlist. The panel shows "matches exactly" or lists every net that differs. KiCad pins that the
   SparkBench part does not model (e.g. a 555's CONTROL pin) are fine when left unconnected.

## Mapping review

For every part: is there a KiCad symbol, is it installed, do all pin-map numbers exist in it, does the pin count
of the placed unit(s) match, is the unit number valid, is there a footprint, is it installed, and do its pad
numbers cover the mapped pin numbers? Each problem is a `Diagnostic` (`source: "kicad"`, codes
`kicad-no-symbol`, `kicad-symbol-missing`, `kicad-pin-unmapped`, `kicad-pin-count`, `kicad-unit-missing`,
`kicad-no-footprint`, `kicad-footprint-missing`, `kicad-pad-mismatch`, `kicad-sim-only`) with a plain-language fix.
In the panel, open a part to search the installed symbol and footprint libraries by name/description and pick
one; the choice is stored in `instance.kicad.symbol` / `instance.kicad.footprint` (undoable) and the review runs
again. Pin numbers always come from the part's `pinMap`.

## PCB (starting point only)

The PCB is built by KiCad's own `pcbnew` Python module, from **KiCad's netlist of the exported schematic**, so net
names, references, footprints and symbol paths are KiCad's. Footprints are loaded from the installed `.pretty`
libraries, pads get their nets, symbol fields are copied onto footprints (as *Update PCB* does) as hidden fields, the Value text sits on the
Fab layer (never silkscreen), so only reference designators are printed; footprints
are placed in rows following the schematic (top-to-bottom bands, left to right) so schematic neighbours start
as board neighbours, inside a rectangular `Edge.Cuts` outline with a 5 mm margin.

**Placement is a starting point. Nothing is routed. SparkBench does not claim the board passes DRC or is ready
to manufacture.** `kicad-cli pcb drc --schematic-parity` runs afterwards and its findings are shown as-is; the
unrouted connections it reports are expected.

## Update an existing KiCad project

Choosing a folder that already contains `<name>.kicad_sch` switches the button to *Update KiCad project*:

- The schematic is regenerated from SparkBench (the old file is kept as `.kicad_sch.<time>.bak`). **Edits made to
  the schematic in KiCad are replaced**; the root sheet UUID and symbol UUIDs are kept.
- A change report compares KiCad's netlists before and after: parts added/removed, value/footprint/symbol
  changes, and pins whose connections changed.
- PCB (backup `.kicad_pcb.<time>.bak`): footprints whose reference and footprint are unchanged keep position,
  rotation and side; a changed footprint is swapped in place; removed parts are deleted; new parts are placed
  beside the existing outline. Nets are reassigned. Tracks, vias, zones and the outline are left untouched, so
  tracks on changed nets may now be wrong; DRC shows them.

## Import (KiCad → SparkBench)

`Import KiCad schematic…` opens a `.kicad_sch` as a new project and shows an import report.

- Symbols map back through `ComponentDef.kicad`: exact `lib_id` first, otherwise the same symbol name with
  matching pin numbers (e.g. a project-local copy of `Device:R`; reported as "matched by symbol name and pins").
  The orientation is chosen so SparkBench's pins land on the KiCad pins; if geometry differs, short wires join
  them and the report says so.
- Kept: references, values (including `Sim.Params` of DC/sine/pulse sources), footprints that differ from the
  part default and custom fields (stored in `instance.kicad`), wires (split at junction dots), local/global/
  hierarchical labels (as net labels), `.op/.tran/.ac` text directives.
- Power symbols: `GND` (and `0`, with a note: KiCad lists "0" and "GND" as separate nets although both are
  simulation ground) become SparkBench ground; other power nets (`+5V`, `VCC`, …) become net labels with that
  name. This matches KiCad, which joins a power symbol and a label of the same name (checked with kicad-cli).
- Labels named `gnd`, `Gnd` or `0` are separate nets in KiCad but would be ground in SparkBench, so they are
  renamed `<name>_net` and the report says so. A label named exactly `GND` joins ground in both.
- Extra units of a multi-unit part are tied to the main part with labels `<REF>_<pin>`.
- **Not imported, and listed in the report:** symbols with no SparkBench part (no placeholder is created, because
  it could not be simulated honestly; their connections are missing), units of a multi-unit symbol that the
  SparkBench part does not model (e.g. the second op-amp of an LM358), KiCad simulation model files
  (`Sim.Library`; the SparkBench part's own model is used and the report names it), hierarchical sheets
  (**not supported**: only the top sheet is imported), buses, no-connect flags, graphics and text notes.
  Off-grid coordinates are rounded and counted.

## What round-trips

| Item | Export | Import |
|---|---|---|
| Parts with a KiCad mapping (refs, values) | yes | yes (mapped parts only) |
| Connectivity | verified equal with kicad-cli | verified equal in tests (rectifier demo, own exports) |
| Footprint/symbol overrides, custom fields | yes | yes |
| Wires, junctions, labels, ground | yes | yes |
| Other power symbols | – (SparkBench has none) | as same-named net labels |
| Multi-unit parts | main + extra units | main + extra units |
| Simulation settings | text directive | `.op/.tran/.ac` directive |
| SPICE models | built-in D/BJT models, sources, R/C/L | no (SparkBench models are used) |
| Probes, plots, vendor model files | no | – |
| Hierarchical sheets, buses | – | no (reported) |
| PCB | generated / updated | – |

## Known limitations

- Single-sheet schematics only.
- Symbol field placement is copied from the library symbol (rotated with the part); KiCad may place them
  differently than you would by hand.
- `instance.kicad` cannot override a part's pin map; choose symbols whose pin numbers match the part.
- MOSFETs, op-amps, logic and other subcircuit models are not given KiCad simulation models.
- On Windows the files are written with CRLF line endings, as KiCad does there.

## Tests

`npm test` runs these when KiCad is installed (they skip otherwise):

- `tests/kicad-sexpr.test.ts`: byte-identical parse→write of files KiCad 10 wrote (schematics, boards, symbol
  libraries, footprints).
- `tests/kicad-export.test.ts`: export → `kicad-cli` netlists equal SparkBench nets for several circuits (all 8
  orientations, T-junctions, labels, multi-unit LM358, every library part); KiCad re-saving the export changes
  nothing but the generator line; a broken export is detected; KiCad's SPICE netlist reproduces SparkBench's
  answer.
- `tests/kicad-sim.test.ts`: diode and BJT parts simulate to SparkBench's operating point through KiCad's netlist.
- `tests/kicad-mapping.test.ts`: mapping diagnostics and library search.
- `tests/kicad-import.test.ts`: round trip and the KiCad rectifier demo against KiCad's own netlist; reports for
  hierarchical and unknown-symbol designs.
- `tests/kicad-pcb.test.ts`, `tests/kicad-project.test.ts`: footprint/pad/net counts, outline, DRC with
  schematic parity, update keeping placement.
