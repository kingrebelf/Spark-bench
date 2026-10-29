// PCB generation with KiCad's own pcbnew (bundled Python), driven by KiCad's netlist of the exported
// schematic: KiCad's net names, references, footprints and symbol paths, so KiCad's "Update PCB from
// Schematic" later recognises every footprint. Footprints are placed as a starting point only; nothing is routed.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseKicadNetlist } from "../netlist";
import { splitLibId } from "../symbols";
import { runPython, type KicadInstall } from "./install";
import type { KicadLibraries } from "./libs";

export interface PcbFootprintIn {
  ref: string; value: string; fpId: string; libPath: string; fpName: string;
  /** "/<symbol uuid>" for root-sheet symbols. */
  path: string; sheetname: string; sheetfile: string;
  /** pad number → net name */
  pads: Record<string, string>;
  /** Symbol fields copied onto the footprint, as KiCad's Update PCB does (Datasheet, Description, user fields). */
  fields: Record<string, string>;
  /** Schematic position (any unit), used to keep schematic neighbours together. */
  sch?: { x: number; y: number };
}

export interface PcbResult {
  pcbPath: string;
  placed: { ref: string; fpId: string; x: number; y: number; kept: boolean }[];
  removed: string[];
  replaced: string[];
  /** Parts that could not go on the board, with the reason. */
  skipped: { ref: string; reason: string }[];
  nets: number;
  outline: { x: number; y: number; w: number; h: number } | null;
  keptTracks: number;
  mode: "new" | "update";
  backup?: string;
}

const SCRIPT = String.raw`
import json, sys, pcbnew

cfg = json.load(open(sys.argv[1], encoding="utf-8"))
out = {"placed": [], "removed": [], "replaced": [], "skipped": [], "nets": 0, "outline": None, "keptTracks": 0}
MM = pcbnew.FromMM

if cfg.get("update"):
    board = pcbnew.LoadBoard(cfg["pcb"])
else:
    board = pcbnew.NewBoard(cfg["pcb"])

# ---- nets
nets = {}
for name in cfg["nets"]:
    ni = board.FindNet(name)
    if ni is None:
        ni = pcbnew.NETINFO_ITEM(board, name)
        board.Add(ni)
    nets[name] = ni
out["nets"] = len(nets)

existing = {fp.GetReference(): fp for fp in board.GetFootprints()}
wanted = {f["ref"] for f in cfg["footprints"]}

def bbox(fp):
    b = fp.GetBoundingBox(True)
    return b.GetX(), b.GetY(), b.GetWidth(), b.GetHeight()

def load(f):
    fp = pcbnew.FootprintLoad(f["libPath"], f["fpName"])
    if fp is None:
        return None
    lib, name = f["fpId"].split(":", 1)
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp

def assign(fp, f):
    fp.SetReference(f["ref"])
    fp.SetValue(f["value"])
    fp.SetPath(pcbnew.KIID_PATH(f["path"]))
    fp.SetSheetname(f["sheetname"])
    fp.SetSheetfile(f["sheetfile"])
    for k, v in f.get("fields", {}).items():
        fp.SetField(k, v)
    for pad in fp.Pads():
        n = pad.GetNumber()
        net = f["pads"].get(n)
        if net is not None and net in nets:
            pad.SetNet(nets[net])
        elif n:
            pad.SetNetCode(0)

# ---- update: keep placement of footprints that still exist, by reference
for ref, fp in list(existing.items()):
    if ref not in wanted:
        board.Remove(fp)
        out["removed"].append(ref)

fresh = []
for f in cfg["footprints"]:
    old = existing.get(f["ref"])
    if old is not None and str(old.GetFPID().GetUniStringLibId()) == f["fpId"]:
        assign(old, f)
        p = old.GetPosition()
        out["placed"].append({"ref": f["ref"], "fpId": f["fpId"], "x": pcbnew.ToMM(p.x), "y": pcbnew.ToMM(p.y), "kept": True})
        continue
    fp = load(f)
    if fp is None:
        out["skipped"].append({"ref": f["ref"], "reason": "footprint %s could not be loaded" % f["fpId"]})
        continue
    if old is not None:
        # footprint changed: replace in place, same position/rotation/side
        fp.SetPosition(old.GetPosition())
        fp.SetOrientation(old.GetOrientation())
        if old.GetLayer() != fp.GetLayer():
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT if hasattr(pcbnew, "FLIP_DIRECTION_LEFT_RIGHT") else False)
        board.Remove(old)
        assign(fp, f)
        board.Add(fp)
        out["replaced"].append(f["ref"])
        p = fp.GetPosition()
        out["placed"].append({"ref": f["ref"], "fpId": f["fpId"], "x": pcbnew.ToMM(p.x), "y": pcbnew.ToMM(p.y), "kept": True})
        continue
    assign(fp, f)
    fresh.append((f, fp))

# ---- place new footprints: rows in schematic order (top-to-bottom bands, left-to-right),
# so parts that are neighbours in the schematic start out as neighbours on the board.
gap = MM(cfg.get("gapMm", 2.0))
if fresh:
    def key(item):
        s = item[0].get("sch") or {"x": 0, "y": 0}
        return (round(s["y"] / 12.7), s["x"])
    fresh.sort(key=key)
    areas = 0
    for f, fp in fresh:
        x, y, w, h = bbox(fp)
        areas += (w + gap) * (h + gap)
    rowmax = max(int(areas ** 0.5 * 1.4), max(bbox(fp)[2] for _, fp in fresh) + gap)
    if cfg.get("update") and existing:
        eb = board.GetBoardEdgesBoundingBox()
        ox, oy = (eb.GetRight() + MM(10), eb.GetTop()) if eb.GetWidth() > 0 else (MM(100), MM(100))
    else:
        ox, oy = MM(100), MM(100)
    cx, cy, rowh = 0, 0, 0
    band = None
    for f, fp in fresh:
        x, y, w, h = bbox(fp)
        b = key((f, fp))[0]
        if cx > 0 and (cx + w > rowmax or (band is not None and b != band and cx > rowmax * 0.6)):
            cx, cy, rowh = 0, cy + rowh + gap, 0
        band = b
        # move so the bounding box's top-left lands on (ox+cx, oy+cy)
        pos = fp.GetPosition()
        fp.SetPosition(pcbnew.VECTOR2I(int(ox + cx + (pos.x - x)), int(oy + cy + (pos.y - y))))
        board.Add(fp)
        p = fp.GetPosition()
        out["placed"].append({"ref": f["ref"], "fpId": f["fpId"], "x": pcbnew.ToMM(p.x), "y": pcbnew.ToMM(p.y), "kept": False})
        cx += w + gap
        rowh = max(rowh, h)

# ---- board outline (new boards only; an existing outline is never touched)
if not cfg.get("update") or board.GetBoardEdgesBoundingBox().GetWidth() == 0:
    fps = list(board.GetFootprints())
    if fps:
        xs, ys, xe, ye = [], [], [], []
        for fp in fps:
            x, y, w, h = bbox(fp)
            xs.append(x); ys.append(y); xe.append(x + w); ye.append(y + h)
        m = MM(cfg.get("marginMm", 5.0))
        x0, y0, x1, y1 = min(xs) - m, min(ys) - m, max(xe) + m, max(ye) + m
        r = pcbnew.PCB_SHAPE(board)
        r.SetShape(pcbnew.SHAPE_T_RECT)
        r.SetStart(pcbnew.VECTOR2I(int(x0), int(y0)))
        r.SetEnd(pcbnew.VECTOR2I(int(x1), int(y1)))
        r.SetLayer(pcbnew.Edge_Cuts)
        r.SetWidth(MM(0.1))
        board.Add(r)
        out["outline"] = {"x": pcbnew.ToMM(x0), "y": pcbnew.ToMM(y0), "w": pcbnew.ToMM(x1 - x0), "h": pcbnew.ToMM(y1 - y0)}

out["keptTracks"] = len(board.GetTracks())
board.BuildConnectivity()
pcbnew.SaveBoard(cfg["pcb"], board)
print("SPARKBENCH_RESULT " + json.dumps(out))
`;

/** Build the pcbnew input from KiCad's netlist of the schematic. */
export function pcbInputFromNetlist(netlistText: string, libs: KicadLibraries, schPos: Record<string, { x: number; y: number }> = {}) {
  const nl = parseKicadNetlist(netlistText);
  const padNets = new Map<string, Record<string, string>>();
  for (const n of nl.nets) for (const d of n.nodes) {
    if (!padNets.has(d.ref)) padNets.set(d.ref, {});
    padNets.get(d.ref)![d.pin] = n.name;
  }
  const footprints: PcbFootprintIn[] = [];
  const skipped: { ref: string; reason: string }[] = [];
  for (const c of nl.components) {
    if (c.ref.startsWith("#")) continue;
    if (!c.footprint) { skipped.push({ ref: c.ref, reason: "no footprint assigned" }); continue; }
    const { lib, name } = splitLibId(c.footprint);
    const libPath = libs.footprintLibPath(lib);
    if (!libPath || !libs.footprintFile(c.footprint)) { skipped.push({ ref: c.ref, reason: `footprint ${c.footprint} is not installed` }); continue; }
    footprints.push({
      ref: c.ref, value: c.value, fpId: c.footprint, libPath, fpName: name,
      path: `/${c.tstamps[0] ?? ""}`, sheetname: c.fields.Sheetname ?? "/", sheetfile: c.fields.Sheetfile ?? "",
      pads: padNets.get(c.ref) ?? {}, sch: schPos[c.ref],
      // All symbol fields except the ones KiCad handles separately, as Update PCB from Schematic copies them.
      fields: Object.fromEntries(Object.entries(c.fields).filter(([key]) => !["Reference", "Value", "Footprint", "Sheetname", "Sheetfile"].includes(key) && !key.startsWith("ki_"))),
    });
  }
  const nets = [...new Set(nl.nets.map((n) => n.name))];
  return { footprints, nets, skipped };
}

export async function generatePcb(k: KicadInstall, libs: KicadLibraries, opts: {
  pcbPath: string; netlistText: string; update: boolean; schPos?: Record<string, { x: number; y: number }>;
}): Promise<PcbResult> {
  const input = pcbInputFromNetlist(opts.netlistText, libs, opts.schPos);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sb-pcbnew-"));
  const script = path.join(tmp, "sparkbench_pcb.py");
  const cfgFile = path.join(tmp, "input.json");
  let backup: string | undefined;
  let update = opts.update;
  try { await fs.access(opts.pcbPath); } catch { update = false; }
  if (update) {
    backup = `${opts.pcbPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    await fs.copyFile(opts.pcbPath, backup);
  }
  await fs.writeFile(script, SCRIPT, "utf8");
  await fs.writeFile(cfgFile, JSON.stringify({ pcb: opts.pcbPath, update, nets: input.nets, footprints: input.footprints }), "utf8");
  try {
    const r = runPython(k, script, [cfgFile]);
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("SPARKBENCH_RESULT "));
    if (r.code !== 0 || !line) throw new Error(`pcbnew failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-6).join(" ")}`);
    const res = JSON.parse(line.slice("SPARKBENCH_RESULT ".length));
    return { pcbPath: opts.pcbPath, ...res, skipped: [...input.skipped, ...res.skipped], mode: update ? "update" : "new", backup };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
