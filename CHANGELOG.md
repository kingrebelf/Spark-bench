# Changelog

What changed in each SparkBench release. The launcher shows these notes ("What's new"); `npm run release` adds a
section here for every release. Write upcoming changes under **Unreleased**: the release script moves them into
the new version's section (when it's empty, it lists the commits since the last release instead).

## Unreleased

### New
- **Launcher / start screen** with the version, update status, recent projects, patch notes, feedback and support.
- **Automatic updates** from GitHub releases for the installed version (download in the background, install on
  restart when you choose). The portable version links to the new download instead. Beta channel on by default.
- **Feedback and bug reports** from inside the app, with optional diagnostics and project attachment.
- **Support SparkBench**: a donate button (any amount, via Stripe).

## v0.1.0 — 2026-10-29 (pre-release)

First public build. Windows only; the EXEs are not code-signed.

### Highlights
- **Live, interactive simulation**: circuits play continuously in real time. LEDs glow from their simulated current, and you can flip switches, hold push buttons and drag potentiometers while the circuit runs. Each change re-simulates from 0 s, so every waveform is one real ngspice run.
- **Time-scale dial** from 100 ns/s to 10 s/s, with a real-time setting and an automatic setting based on the circuit's own timing.
- **Component damage**: parts have ratings. A part glows as it nears its limit, burns out under sustained overload, and gets a message that names the stress and a sized fix.
- **ngspice 45 (WebAssembly)** with DC operating point, transient and AC analyses, honest error reporting, an oscilloscope with cursors and measurements, a Bode plot, and CSV/netlist/PNG export.
- **Library of ideal, generic, behavioral and vendor-model parts**, each labeled with what its model is. Includes the 555, op-amps, logic and transistors, plus SPICE model import.
- **14 example circuits**, including interactive ones: an LED with a switch, a pot dimmer, and a 555 with adjustable speed.
- **KiCad 10**: schematic and project export with symbol/footprint mapping review, a PCB with footprints placed (not routed), ERC/DRC through kicad-cli, and schematic import.
- **AI assistant** with Anthropic, OpenAI, OpenAI-compatible (local models) and Codex CLI providers. Every change it proposes is reviewed, checked and simulated before you apply it. API keys are encrypted with Windows DPAPI.

### Known limitations
- Digital parts and the 555 are behavioral analog models: they reproduce the function, not device physics.
- Live mode re-simulates from 0 s on each extension. After very long runs (roughly 20 minutes of circuit time in real time), playback waits for the simulation rather than looping.
- Changes made during a live run aren't saved to the project.
- PCB output places footprints but doesn't route them, and makes no manufacturing-readiness claim.
- macOS and Linux build from source but are untested.
