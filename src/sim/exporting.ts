// Result export: CSV of traces, .cir netlist, PNG of the plot. Electron uses a native save dialog
// (sb:file:saveAs); a plain browser falls back to a download.
import { host } from "../core/host";
import type { SimResult, Vector } from "../core/types";

export interface CsvColumn { label: string; vector: Vector }

const num = (v: number) => (Number.isFinite(v) ? String(v) : "");
const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * CSV with the sweep variable first. Transient: one column per trace. AC: magnitude, dB and phase per trace.
 * Operating point: one row of values.
 */
export function resultToCsv(result: SimResult, columns: CsvColumn[]): string {
  const rows: string[] = [];
  if (result.analysis === "op") {
    rows.push(columns.map((c) => quote(`${c.label} (${c.vector.unit})`)).join(","));
    rows.push(columns.map((c) => num(c.vector.real[0])).join(","));
    return rows.join("\n") + "\n";
  }
  const x = result.x!;
  const ac = result.analysis === "ac";
  const head = [ac ? "frequency (Hz)" : "time (s)"];
  for (const c of columns) {
    if (ac) head.push(`|${c.label}| (${c.vector.unit})`, `${c.label} (dB)`, `${c.label} phase (deg)`);
    else head.push(`${c.label} (${c.vector.unit})`);
  }
  rows.push(head.map(quote).join(","));
  for (let i = 0; i < x.real.length; i++) {
    const r = [num(x.real[i])];
    for (const c of columns) {
      const re = c.vector.real[i], im = c.vector.imag?.[i] ?? 0;
      if (ac) { const m = Math.hypot(re, im); r.push(num(m), num(20 * Math.log10(m)), num(Math.atan2(im, re) * 180 / Math.PI)); }
      else r.push(num(re));
    }
    rows.push(r.join(","));
  }
  return rows.join("\n") + "\n";
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save text with a native dialog in Electron, or as a browser download. Resolves to the saved path/name, or null if cancelled. */
export async function saveText(text: string, defaultName: string, filter: { name: string; extensions: string[] }): Promise<string | null> {
  if (host.available) {
    const r = await host.invoke<{ path: string } | null>("sb:file:saveAs", { text, defaultName, filters: [filter] });
    return r?.path ?? null;
  }
  download(defaultName, new Blob([text], { type: "text/plain" }));
  return defaultName;
}

/** PNG export. The text-only save IPC can't write binary, so this is a download in both Electron and the browser. */
export function savePng(canvas: HTMLCanvasElement, defaultName: string): Promise<string | null> {
  return new Promise((resolve) => canvas.toBlob((b) => { if (!b) return resolve(null); download(defaultName, b); resolve(defaultName); }, "image/png"));
}

export const safeFileName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "untitled";
