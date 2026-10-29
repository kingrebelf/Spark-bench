# SparkBench project format (`.sbproj`, version 1)

A project is one UTF-8 JSON file validated by `projectSchema` in `src/core/project.ts`.

```jsonc
{
  "format": "sparkbench-project",
  "version": 1,
  "meta": { "name": "RC filter", "created": "ISO-8601", "modified": "ISO-8601", "appVersion": "0.1.0", "description": "" },
  "schematic": {
    "components": [{
      "id": "c_…",               // stable unique id
      "type": "resistor",        // library part id (ComponentDef.id)
      "ref": "R1",
      "position": { "x": 10, "y": 3 },   // grid units, 1 unit = 1.27 mm
      "rotation": 0,             // 0 | 90 | 180 | 270, clockwise
      "mirror": false,
      "props": { "value": "4.7k" },      // SI strings; keys from ComponentDef.props
      "modelId": "m_…",          // optional: project SPICE model overriding the built-in model
      "kicad": { "symbol": "Device:R", "footprint": "Resistor_SMD:R_0603_1608Metric", "fields": {} }  // optional overrides
    }],
    "wires":  [{ "id": "w_…", "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }] }],
    "labels": [{ "id": "l_…", "name": "out", "position": { "x": 10, "y": 8 }, "rotation": 0 }]
  },
  "simulation": {
    "analysis": "op" | "tran" | "ac",
    "tran": { "stop": "10m", "step": "10u", "start": "0", "uic": false },
    "ac": { "sweep": "dec", "points": 20, "start": "1", "stop": "1MEG" },
    "probes": [{ "id": "p_…", "kind": "voltage", "target": { "netName": "out" }, "label": "Vout", "color": "#4fc3f7" }]
  },
  "models": [{                   // imported SPICE models travel with the project
    "id": "m_…", "name": "2N3904", "kind": "model" | "subckt", "text": ".model 2N3904 NPN(...)",
    "provenance": "vendor", "manufacturer": "…", "partNumber": "…", "source": "file name or URL", "pins": ["C","B","E"]
  }],
  "kicad": { "projectPath": "…", "lastExport": "ISO-8601", "notes": [] }
}
```

## Connectivity rules
- Pin tips and wire vertices are connection points. A point that lies on a wire segment joins it (T-junction, drawn
  with a dot). Wires that merely cross do **not** connect.
- Labels connect the point they sit on; labels with the same name are one net. Labels named `GND` or `0` are ground.
- Every Ground symbol is SPICE node `0`.

## Opening a project elsewhere
`parseProject` never throws. It reports invalid JSON, schema mismatches, part types the installation lacks
(`project-missing-part`), and components referencing models not stored in the file (`project-missing-model`).
Those parts are kept in the file but cannot be simulated until resolved.

## Recovery
While there are unsaved edits, the desktop app writes `%APPDATA%/sparkbench/recovery/autosave.sbproj` every 5 s and offers
to restore it on the next start. Saves are atomic (write temp file, then rename).
