# SparkBench component library

Owned by the library module (`src/library/**`, `examples/**`, `tests/library*`). Parts register from
`src/library/index.ts`; the contract is `ComponentDef` in `src/core/types.ts`.

## Rules every part follows

- **Symbol pins match KiCad.** Each pin's position is the referenced KiCad 10 symbol's pin, converted to grid
  units (1 unit = 1.27 mm, Y flipped). `tests/library-kicad.test.ts` reads the installed `.kicad_sym` files and checks
  every mapping: the symbol exists, every pin maps to an existing pin number at the same position, no KiCad pin is
  left unmapped (except hidden/NC pins and the 555's CONT pin, see below), and the default footprint exists and has a pad
  for every mapped pin number. The KiCad tests skip when KiCad is not installed (`KICAD_SHARE` overrides the path).
- **Honest provenance.** `ideal` = textbook element; `generic` = SPICE model with typical or fitted parameters, not a
  manufacturer's file (named parts are called "2N3904-like" etc.); `behavioral` = macromodel built from B-sources that
  reproduces function, not device physics; `none` = schematic only. **No built-in part is labeled `vendor`**: SparkBench
  does not ship manufacturer model files. To get vendor fidelity, import the manufacturer's `.model`/`.subckt`
  (see below); imported models are `vendor` only when the user names the manufacturer.
- **`dcPaths`** are declared wherever not all pins conduct at DC (capacitors, MOSFET gates, op-amp inputs, logic
  inputs), so the "no DC path to ground" check matches what ngspice needs.
- Every simulatable part runs in op, tran and AC (unless `analyses` says otherwise) in `tests/library-sim.test.ts`.

## How the behavioral models work

ngspice-WASM has no XSPICE digital models, so logic and the 555 are analog subcircuits (`.subckt` cards defined once
per netlist; per-instance values passed as subcircuit parameters).

- **Logic levels** are smooth: `0.5·(1 + tanh((V − VCC/2)/50 mV))`, so Newton always has a derivative. Thresholds and
  output levels scale with the voltage between the part's own VCC and GND pins (works at 3.3 V, 5 V, 12 V).
- **Propagation delay**: the ideal logic value drives a 1 kΩ/C low-pass whose 50 % crossing is at `td`, then a
  regenerating buffer and the output resistance (default 50 Ω).
- **Flip-flops / counter**: master-slave pairs of storage nodes (1 pF). A storage node is driven toward its data while
  transparent and is a bare capacitor while holding, so it keeps its value at any simulator time step. Master and slave
  use non-overlapping clock thresholds (60 % / 40 % of VCC), so slow clock edges cannot race. At the DC operating point
  every flip-flop starts with Q = 0 (or 1 if ~PRE is low).
- **555**: comparators at exactly VCC/3 and 2·VCC/3 (10 mV transition), an SR latch with the
  datasheet priorities (RESET > TRIGGER > THRESHOLD) built from a voltage-controlled switch (on or off, never
  half-set, so it flips at any time step; its hold command comes from its own output), a 10 Ω discharge conductance, and an output of VCC − `vdrop`.
  At the operating point the latch is held reset (power-up with an empty timing capacitor). Measured over several R/C/VCC
  sets: astable frequency within 1.2 % of 1.44/((R1+2R2)C), duty within 0.7 points of (R1+R2)/(R1+2R2), monostable
  within 0.9 % of 1.1·RC (the tests assert 3 %, 2 points and 2 %, and that the astable example keeps
  oscillating for 20 s at max steps of 1 ms, 200 µs and 100 µs). An op analysis of a 555 circuit shows the forced
  power-up state, not a steady state.
- **Op-amps**: tanh-limited transconductance (slew rate) into an RC dominant pole (open-loop gain and GBW), output clamp
  inside the rails with per-rail headroom, input resistance, output resistance. LM358-like/TL072-like use datasheet
  typical values and are `behavioral`, not TI's macromodels.
- **Comparator**: sharp threshold with optional hysteresis, first-order response delay, push-pull or open-collector.

## Parts

### Passive

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| Resistor (`resistor`) | ideal | `Device:R`<br>`Resistor_SMD:R_0805_2012Metric` | Ideal linear resistor. Ohm's law: V = I·R. Power rating, tolerance and temperature drift are not modeled. |
| Potentiometer (`potentiometer`) | ideal | `Device:R_Potentiometer`<br>`Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical` | Two ideal resistors split at the wiper. Contact resistance and taper (log/linear) are not modeled; the position is constant during a run. |
| Capacitor (`capacitor`) | ideal | `Device:C`<br>`Capacitor_SMD:C_0805_2012Metric` | Ideal capacitor (no ESR or leakage). Blocks DC, passes AC. Optional initial voltage for transient runs with UIC. |
| Electrolytic Capacitor (`capacitor_polarized`) | ideal | `Device:C_Polarized`<br>`Capacitor_THT:CP_Radial_D6.3mm_P2.50mm` | Ideal capacitor plus optional series ESR. Reverse-voltage damage, leakage current and voltage rating are NOT modeled: check the polarity yourself. |
| Inductor (`inductor`) | ideal | `Device:L`<br>`Inductor_SMD:L_1206_3216Metric` | Ideal inductor (optional winding resistance; no saturation or core loss). Short circuit at DC. |
| Transformer (`transformer`) | ideal | `Device:Transformer_1P_1S` | Linear coupled inductors with winding resistance. Core saturation, hysteresis and losses are not modeled. |
| Switch (SPST) (`switch_spst`) | ideal | `Switch:SW_SPST`<br>`Button_Switch_THT:SW_DIP_SPSTx01_Slide_9.78x4.72mm_W7.62mm_P2.54mm` | Static ideal switch: a resistor of Ron (closed) or Roff (open). The state is fixed for a whole simulation run; to switch during a run, drive a node with a pulse source instead. Contact bounce is not modeled. |
| Push Button (`push_button`) | ideal | `Switch:SW_Push`<br>`Button_Switch_THT:SW_PUSH_6mm` | Static ideal switch: a resistor of Ron (closed) or Roff (open). The state is fixed for a whole simulation run; to switch during a run, drive a node with a pulse source instead. Contact bounce is not modeled. |

### Sources

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| DC Voltage Source (`vdc`) | ideal | `Simulation_SPICE:VDC` | Ideal DC voltage source (zero internal resistance). The + pin is at the top. |
| DC Current Source (`idc`) | ideal | `Simulation_SPICE:IDC` | Ideal: it forces its current whatever voltage that takes, so it needs a DC path (e.g. a resistor) across it. |
| Sine Voltage Source (`vsine`) | ideal | `Simulation_SPICE:VSIN` | Ideal sine source: offset + amplitude·sin(2π·f·t + phase). Also drives AC analysis with its AC magnitude. |
| Square / Pulse Source (`vpulse`) | ideal | `Simulation_SPICE:VPULSE` | Ideal pulse source switching between Low and High at the given frequency and duty cycle. Edge times are finite to help convergence. |
| Triangle / Sawtooth Source (`vtriangle`) | ideal | `Simulation_SPICE:VPULSE` | A SPICE PULSE source whose rise and fall times fill the whole period. |
| Battery (`battery`) | ideal | `Device:Battery`<br>`Battery:BatteryHolder_Keystone_2460_1xAA` | Constant voltage behind a fixed internal resistance. Discharge, capacity and temperature are not modeled. |
| Ground (`ground`) | none | `power:GND` | 0 V reference (SPICE node 0). Every circuit needs at least one. |

### Instruments

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| Ammeter (`ammeter`) | ideal | `Device:Ammeter_DC` | Zero burden voltage (a real meter adds a small shunt resistance). |
| Voltmeter (`voltmeter`) | ideal | `Device:Voltmeter_DC` | Loads the circuit with its input resistance like a real DMM; the reading itself is exact. |

### Semiconductors

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| Diode (small signal) (`diode`) | generic | `Device:D`<br>`Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal` | Typical small-signal silicon parameters in the 1N4148 class (Is=2.52n, N=1.752, Rs=0.568, BV=100). Not a manufacturer's model. You can replace the model with an imported diode .model (Model → choose). |
| Rectifier Diode (1N4007-like) (`diode_rectifier`) | generic | `Device:D`<br>`Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal` | Typical 1N400x-class values in the style of common public models (Is≈7n, N≈1.8, Rs≈34m, BV=1000); not checked against a manufacturer file. Reverse recovery is approximate. You can replace the model with an imported diode .model (Model → choose). |
| LED (`led`) | generic | `Device:LED`<br>`LED_THT:LED_D5.0mm` | Shockley diode (N=2) fitted so that V = Vf at the given current; typical values for 5 mm LEDs, real parts vary ±0.2 V. Light output, color shift and reverse breakdown (≈5 V) are approximate. |
| Zener Diode (`zener`) | generic | `Device:D_Zener`<br>`Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal` | Generic SPICE diode with breakdown set so V = Vz at the test current, plus series resistance Rz. Temperature coefficient and the soft knee of low-voltage Zeners are not modeled. You can replace the model with an imported diode .model (Model → choose). |
| Schottky Diode (`schottky`) | generic | `Device:D_Schottky`<br>`Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal` | Generic 1 A, 40 V Schottky parameters (Is=3µ, N=1.06, Rs=70m); not a manufacturer's model. You can replace the model with an imported diode .model (Model → choose). |
| NPN Transistor (generic) (`npn`) | generic | `Transistor_BJT:Q_NPN_EBC`<br>`Package_TO_SOT_THT:TO-92_Inline` | Gummel-Poon model with textbook parameters (β, Is, VAF from the properties; small junction capacitances). Not a specific part number. You can assign an imported .model instead. |
| PNP Transistor (generic) (`pnp`) | generic | `Transistor_BJT:Q_PNP_EBC`<br>`Package_TO_SOT_THT:TO-92_Inline` | Gummel-Poon model with textbook parameters (β, Is, VAF from the properties; small junction capacitances). Not a specific part number. You can assign an imported .model instead. |
| 2N3904-like NPN (`2n3904`) | generic | `Transistor_BJT:2N3904`<br>`Package_TO_SOT_THT:TO-92_Inline` | Typical Gummel-Poon values for the 2N3904 in the style of common public SPICE models. Not checked against a manufacturer's file, hence "-like"; import the vendor .model when you need that part's exact behavior. |
| 2N3906-like PNP (`2n3906`) | generic | `Transistor_BJT:2N3906`<br>`Package_TO_SOT_THT:TO-92_Inline` | Typical Gummel-Poon values for the 2N3906 in the style of common public SPICE models. Not checked against a manufacturer's file, hence "-like"; import the vendor .model when you need that part's exact behavior. |
| BC547-like NPN (`bc547`) | generic | `Transistor_BJT:BC547`<br>`Package_TO_SOT_THT:TO-92_Inline` | Typical Gummel-Poon values for the BC547B in the style of common public SPICE models. Not checked against a manufacturer's file, hence "-like"; import the vendor .model when you need that part's exact behavior. |
| BC557-like PNP (`bc557`) | generic | `Transistor_BJT:BC557`<br>`Package_TO_SOT_THT:TO-92_Inline` | Typical Gummel-Poon values for the BC557B in the style of common public SPICE models. Not checked against a manufacturer's file, hence "-like"; import the vendor .model when you need that part's exact behavior. |
| N-channel MOSFET (generic) (`nmos`) | generic | `Transistor_FET:Q_NMOS_GDS`<br>`Package_TO_SOT_THT:TO-92_Inline` | SPICE level-1 (square-law) model with the given Vth, K and λ, fixed 20 pF/5 pF gate capacitances and the intrinsic body diode. Fine for switching and biasing intuition, not for precise analog design. |
| P-channel MOSFET (generic) (`pmos`) | generic | `Transistor_FET:Q_PMOS_GDS`<br>`Package_TO_SOT_THT:TO-92_Inline` | SPICE level-1 (square-law) model with the given Vth, K and λ, fixed 20 pF/5 pF gate capacitances and the intrinsic body diode. Fine for switching and biasing intuition, not for precise analog design. |
| 2N7000-like N-MOSFET (`2n7000`) | generic | `Transistor_FET:2N7000`<br>`Package_TO_SOT_THT:TO-92_Inline` | Level-1 fit to datasheet typicals: Vgs(th) ≈ 2.1 V, Rds(on) ≈ 1.2-1.8 Ω at Vgs = 10 V, Ciss ≈ 30 pF. This is a SparkBench fit, not the manufacturer's model; import the vendor .model for fidelity. |
| BS250-like P-MOSFET (`bs250`) | generic | `Transistor_FET:BS250`<br>`Package_TO_SOT_THT:TO-92_Inline` | Level-1 fit to datasheet typicals: Vgs(th) ≈ −2.4 V, Rds(on) ≈ 14 Ω at Vgs = −10 V. This is a SparkBench fit, not the manufacturer's model; import the vendor .model for fidelity. |

### Analog ICs

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| Op-Amp (ideal-ish) (`opamp`) | behavioral | `Simulation_SPICE:OPAMP` | Single-pole behavioral macromodel: finite gain, GBW, slew limit, output clamped inside the rails, output resistance. Not modeled: input bias current, input common-mode limits, noise, output current limit, supply current drawn by the load (it flows to V−). |
| LM358-like Op-Amp (`lm358`) | behavioral | `Amplifier_Operational:LM358` (unit 1 + 3)<br>`Package_DIP:DIP-8_W7.62mm` | Behavioral macromodel with LM358 datasheet-typical values: gain 100 V/mV, GBW 0.7 MHz, slew 0.3 V/µs, output high ≈ V+ − 1.5 V, low ≈ V−. Not TI's model: crossover distortion, input common-mode range, offset and bias currents are not modeled. |
| TL072-like Op-Amp (`tl072`) | behavioral | `Amplifier_Operational:TL072` (unit 1 + 3)<br>`Package_DIP:DIP-8_W7.62mm` | Behavioral macromodel with TL072 datasheet-typical values: gain 200 V/mV, GBW 3 MHz, slew 13 V/µs, swing ≈ 1.5 V inside each rail, input resistance 1 TΩ. Not TI's model: phase reversal near V−, noise and offsets are not modeled. |
| Comparator (`comparator`) | behavioral | `Comparator:LM393` (unit 1 + 3)<br>`Package_DIP:DIP-8_W7.62mm` | Behavioral: ideal threshold (1 mV transition), first-order response delay, ideal output levels (push-pull swings rail to rail; open-collector sinks through Ron with 100 MΩ leakage). Input offset, bias current and output current limits are not modeled. *(no AC)* |

### Digital

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| NOT Gate (Inverter) (`gate_not`) | behavioral | `74xGxx:74AHC1G04`<br>`Package_TO_SOT_SMD:SOT-23-5` | Behavioral analog model of an inverter: ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). *(no AC)* |
| AND Gate (`gate_and`) | behavioral | `74xGxx:74AHC1G08`<br>`Package_TO_SOT_SMD:SOT-23-5` | Behavioral analog model of a AND gate: ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). *(no AC)* |
| NAND Gate (`gate_nand`) | behavioral | `74xGxx:74AHC1G00`<br>`Package_TO_SOT_SMD:SOT-23-5` | Behavioral analog model of a NAND gate: ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). *(no AC)* |
| OR Gate (`gate_or`) | behavioral | `74xGxx:74AHC1G32`<br>`Package_TO_SOT_SMD:SOT-23-5` | Behavioral analog model of a OR gate: ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). *(no AC)* |
| NOR Gate (`gate_nor`) | behavioral | `74xGxx:74AHC1G02`<br>`Package_TO_SOT_SMD:SOT-23-5` | Behavioral analog model of a NOR gate: ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). *(no AC)* |
| XOR Gate (`gate_xor`) | behavioral | `74xGxx:74AHC1G86`<br>`Package_TO_SOT_SMD:SOT-23-5` | Behavioral analog model of a XOR gate: ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). *(no AC)* |
| D Flip-Flop (`dff`) | behavioral | `74xx:74HC74` (unit 1 + 3)<br>`Package_DIP:DIP-14_W7.62mm` | Behavioral analog model of a D flip-flop (master-slave): ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). Setup/hold violations are not flagged; with ~PRE and ~CLR both low the model gives Q = 1 (a real 74x74 drives both Q and ~Q high). *(no AC)* |
| JK Flip-Flop (`jkff`) | behavioral | `74xx:74LS107` (unit 1 + 3)<br>`Package_DIP:DIP-14_W7.62mm` | Behavioral analog model of a JK flip-flop (master-slave, edge-triggered): ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). Unlike the original 7473 pulse-triggered part, J and K are sampled only around the falling edge. *(no AC)* |
| 4-bit Binary Counter (`counter4`) | behavioral | `74xx:74LS93`<br>`Package_DIP:DIP-14_W7.62mm` | Behavioral analog model of a 4-bit ripple counter (four toggle flip-flops): ideal switching threshold at VCC/2, outputs swing to the rails through the output resistance after the propagation delay. Inputs are 100 MΩ to GND. Not modeled: noise margins of a real family, input capacitance, output current limits, and supply current drawn by the outputs (it returns via GND, not VCC). The internal ripple adds about 1 ns per stage; real 74LS93 stages add 10-20 ns each. *(no AC)* |

### Timers

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| 555 Timer (`timer555`) | behavioral | `Timer:NE555P`<br>`Package_DIP:DIP-8_W7.62mm` | Behavioral model: ideal comparators at exactly VCC/3 and 2·VCC/3, an SR latch with datasheet priorities (reset > trigger > threshold), a 10 Ω discharge switch and an output stage with a fixed high-level drop. Timing follows the ideal formulas (measured within ≈ 1.2 % of 1.44/((R1+2R2)C) and 1.1·RC); real parts add a few % error and a few hundred ns of delay. Output current is not drawn from VCC; the control pin is not available. An operating-point (op) analysis always shows the power-up state (output low, discharge on), not a steady state: a 555 circuit has to be run in transient. *(no AC)* |

### Connectors

| Part (id) | Provenance | KiCad symbol / default footprint | Notes |
|---|---|---|---|
| Pin Header 1×2 (`header_1x02`) | none | `Connector_Generic:Conn_01x02`<br>`Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical` | Not simulated. Whatever connects here off-board is not part of the simulation; add a source or load to model it. |
| Pin Header 1×3 (`header_1x03`) | none | `Connector_Generic:Conn_01x03`<br>`Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical` | Not simulated. Whatever connects here off-board is not part of the simulation; add a source or load to model it. |
| Pin Header 1×4 (`header_1x04`) | none | `Connector_Generic:Conn_01x04`<br>`Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical` | Not simulated. Whatever connects here off-board is not part of the simulation; add a source or load to model it. |
| Screw Terminal 1×2 (`terminal_1x02`) | none | `Connector:Screw_Terminal_01x02`<br>`TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2_1x02_P5.00mm_Horizontal` | Not simulated. Whatever connects here off-board is not part of the simulation; add a source or load to model it. |
| Screw Terminal 1×3 (`terminal_1x03`) | none | `Connector:Screw_Terminal_01x03`<br>`TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-3_1x03_P5.00mm_Horizontal` | Not simulated. Whatever connects here off-board is not part of the simulation; add a source or load to model it. |

### Deliberate omissions and limitations

- **555 control pin (5)** is not brought out: an unconnected pin would fail the floating-pin check, and almost every
  circuit only decouples it. The KiCad export leaves pin 5 unconnected.
- **Switches and buttons are static per run** (a resistor of Ron or Roff). To switch during a run, drive the circuit
  with a pulse source.
- **Digital outputs draw their current from GND, not VCC**, so supply-current readings of logic circuits are not
  meaningful. Input capacitance, noise margins and output current limits of real families are not modeled.
- **Multi-unit KiCad symbols**: the op-amps and comparator map to unit A of the dual package plus the power unit
  (`unit: 1, extraUnits: [3]`), the D and JK flip-flops to unit A of the 74HC74 / 74LS107 plus the power unit. Gates,
  counter and 555 use single-unit symbols (74xGxx single-gate parts, 74LS93, NE555P). In the flip-flop symbols VCC/GND
  sit directly above/below ~PRE/~CLR (~R), exactly as in KiCad: a wire run straight up or down into ~PRE/~CLR would
  pass through the supply pin tip and join it, so wire those pins from the side.
- **Generic op-amp** (`Simulation_SPICE:OPAMP`) has no default footprint: that symbol numbers its pins 1-5, which
  matches no real package. Pick an LM358-like/TL072-like part or set a footprint for PCB export.
- Not included: fuse (a fuse that cannot blow would mislead), JFETs, 7-segment decoder.

## SPICE model import (`src/library/spiceImport.ts`)

- `importSpiceText(text, { source, manufacturer?, provenance? })` → `{ models: SpiceModel[], diagnostics }`. Parses every
  `.model` and `.subckt` (case-insensitive, `+` continuation lines, `*` / `;` / `$` comments, nested subcircuits,
  `params:` defaults). Reports unterminated subcircuits, duplicate names and empty files as diagnostics; never throws.
- **Discrete models** (`D`, `NPN`, `PNP`, `NMOS`, `PMOS`, `VDMOS`): put the model in `project.models` and set
  `instance.modelId` on a diode, LED, Zener, Schottky, BJT or MOSFET part. `compatibleModels(partId, project.models)`
  lists the models a part accepts and `checkModelAssignment(partId, model)` explains a mismatch as a Diagnostic.
  If the netlister meets a mismatched model it refuses the part (`unsupported-part`) instead of silently using the
  built-in one. VDMOS power-MOSFET models are emitted with three terminals.
- **Subcircuits** become parts: `registerImportedModels(project.models)` registers a `ComponentDef` with id
  `subckt:<model id>` per subcircuit (box symbol, pins from the `.subckt` line, category "Imported", provenance from
  the model). Place instances with that type. `partsForModel(model)` tells the UI which parts can use a model.

### Integration notes for the app
1. Call `registerImportedModels(project.models)` **after loading a project and before** `parseProject(..., partTypes())`
   reports missing parts (or re-run the check after registering), otherwise `subckt:*` parts are flagged as missing.
2. "Import SPICE model…" → read the file → `importSpiceText` → show diagnostics → add chosen models with one undoable
   `update()` → `registerImportedModels`.
3. On a diode/BJT/MOSFET's properties, offer "Model: built-in / <compatibleModels…>" and write `modelId`.

## Examples (`examples/*.sbproj`)

Generated by `src/library/examples.ts`; regenerate with `npx tsx examples/build.ts`. `tests/library-examples.test.ts`
checks the files are current, load without diagnostics, have no pin sitting inside a wire, and simulate as documented:

| File | Analysis | Expected behavior (tested) |
|---|---|---|
| `resistor-divider` | op | V(out) = 3.000 V |
| `rc-charging` | tran | 63 % of 5 V at τ = 1 ms, > 4.95 V at 5τ, discharges to 1.84 V at 6 ms |
| `rc-lowpass-bode` | ac | −3 dB at 1 kHz, −20 dB at 10 kHz |
| `led-resistor` | op | red LED Vf 1.7-2.1 V, ≈ 9.4 mA |
| `half-wave-rectifier` | tran | peak ≈ 9.2 V, ripple ≈ 1.8 V with 100 µF / 1 kΩ at 50 Hz |
| `bjt-common-emitter` | tran (+ac, op) | inverted, gain ≈ 4.3; collector ≈ 5-6 V |
| `opamp-inverting` | tran (+ac) | V(out) = −10·V(in), 20 dB |
| `555-astable-blinker` | tran | ≈ 0.99 Hz, duty ≈ 54 %, capacitor 3-6 V |
| `555-monostable` | tran | single ≈ 1.1 s pulse after the 10 ms trigger |
| `logic-gates` | tran | AND/OR/XOR truth tables over time |
| `counter-4bit` | tran | binary count 1, 2, … 15, 0 on falling clock edges |
