// SI value parsing/formatting shared by the editor, netlister and plots.
// Accepts SPICE-style suffixes (case-insensitive except M vs m handling below).

const SUFFIX: Record<string, number> = {
  T: 1e12, G: 1e9, MEG: 1e6, M: 1e6, k: 1e3, K: 1e3,
  m: 1e-3, u: 1e-6, "µ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

/**
 * Parse "4.7k", "10u", "1MEG", "2.2nF", "5 V", "1e-3". Unit letters after the
 * multiplier are ignored. "M" means mega (engineering convention, shown in UI);
 * "m" means milli. Returns NaN when the text is not a number.
 */
export function parseSI(input: string | number): number {
  if (typeof input === "number") return input;
  const s = input.trim().replace(/Ω|ohms?/gi, "");
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(meg|MEG|Meg|[TGMkKmuµnpf])?\s*(?:V|A|F|H|Hz|s|sec|W|deg|°|%)?$/.exec(s);
  if (!m) return NaN;
  const base = parseFloat(m[1]);
  const suf = m[2];
  if (!suf) return base;
  if (/^meg$/i.test(suf)) return base * 1e6;
  return base * (SUFFIX[suf] ?? 1);
}

const PREFIXES: [number, string][] = [
  [1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""],
  [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"],
];

/** Format 4700 -> "4.7 kΩ" with `digits` significant figures. */
export function formatSI(value: number, unit = "", digits = 4): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`.trim();
  if (value === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(value);
  for (const [scale, p] of PREFIXES) {
    if (abs >= scale * 0.9999999) {
      const n = Number((value / scale).toPrecision(digits));
      return `${n} ${p}${unit}`.trim();
    }
  }
  const n = Number((value / 1e-15).toPrecision(digits));
  return `${n} f${unit}`.trim();
}

/** Convert an SI number to a SPICE literal ngspice understands unambiguously. */
export function toSpiceNumber(value: number): string {
  return Number.isFinite(value) ? value.toExponential(9).replace(/\.?0+e/, "e") : "0";
}
