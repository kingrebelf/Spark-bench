// KiCad S-expression reader/writer.
// Atoms keep their raw text (quotes, escapes, number formatting) so a file KiCad wrote
// comes back byte-identical after parse → write. The writer reproduces KiCad's own
// pretty-printer (common/io/kicad/kicad_io_utils.cpp `Prettify`): one list per line,
// tab indentation, lists of atoms on one line, runs of (xy ..) packed up to column 99.

export interface SAtom { t: "atom"; raw: string }
export interface SList { t: "list"; items: SExpr[] }
export type SExpr = SAtom | SList;

// ------------------------------------------------------------------ construction

/** Bare (unquoted) atom: symbols and numbers. */
export const sym = (s: string): SAtom => ({ t: "atom", raw: s });
/** Quoted string atom with KiCad escaping. */
export const str = (s: string): SAtom => ({ t: "atom", raw: quote(s) });
/** Number atom, formatted like KiCad (no exponent, trailing zeros trimmed). */
export const num = (n: number, decimals = 4): SAtom => ({ t: "atom", raw: fmtNum(n, decimals) });
export const list = (head: string, ...items: (SExpr | string | number | null | undefined | false)[]): SList => ({
  t: "list",
  items: [sym(head), ...items.filter((i): i is SExpr | string | number => i !== null && i !== undefined && i !== false)
    .map((i) => (typeof i === "string" ? sym(i) : typeof i === "number" ? num(i) : i))],
});

export function fmtNum(n: number, decimals = 4): string {
  if (!Number.isFinite(n)) throw new Error(`Cannot write non-finite number ${n}`);
  let s = n.toFixed(decimals);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}

export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}
export function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, -1);
  return body.replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
}

// ------------------------------------------------------------------ access helpers

export const isList = (e: SExpr | undefined): e is SList => !!e && e.t === "list";
/** Head symbol of a list ("symbol", "wire", ...). */
export const head = (e: SExpr | undefined): string | undefined =>
  isList(e) && e.items[0]?.t === "atom" ? e.items[0].raw : undefined;
/** Decoded value of the i-th item (1 = first argument). */
export function arg(e: SList | undefined, i = 1): string | undefined {
  const a = e?.items[i];
  return a && a.t === "atom" ? unquote(a.raw) : undefined;
}
export function numArg(e: SList | undefined, i = 1): number {
  return Number(arg(e, i));
}
export function children(e: SList | undefined, name?: string): SList[] {
  if (!e) return [];
  return e.items.filter((x): x is SList => isList(x) && (name === undefined || head(x) === name));
}
export function child(e: SList | undefined, name: string): SList | undefined {
  return e?.items.find((x): x is SList => isList(x) && head(x) === name);
}
/** First child list matching `name` whose first argument equals `value` (e.g. property "Reference"). */
export function childWith(e: SList | undefined, name: string, value: string): SList | undefined {
  return children(e, name).find((c) => arg(c) === value);
}
export function clone<T extends SExpr>(e: T): T {
  return (e.t === "atom" ? { t: "atom", raw: e.raw } : { t: "list", items: e.items.map(clone) }) as T;
}

// ------------------------------------------------------------------ parsing

export class SexprError extends Error {}

export function parse(text: string): SList {
  const r = parseAll(text);
  const lists = r.filter(isList);
  if (lists.length !== 1) throw new SexprError(`Expected one top-level list, found ${lists.length}`);
  return lists[0];
}

export function parseAll(text: string): SExpr[] {
  const stack: SList[] = [];
  const top: SExpr[] = [];
  let i = 0;
  const n = text.length;
  const push = (e: SExpr) => (stack.length ? stack[stack.length - 1].items.push(e) : top.push(e));
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    if (c === 40 /* ( */) { const l: SList = { t: "list", items: [] }; push(l); stack.push(l); i++; continue; }
    if (c === 41 /* ) */) {
      if (!stack.length) throw new SexprError(`Unbalanced ')' at offset ${i}`);
      stack.pop(); i++; continue;
    }
    if (c === 34 /* " */) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 92 /* \ */) { j += 2; continue; }
        if (d === 34) break;
        j++;
      }
      if (j >= n) throw new SexprError(`Unterminated string at offset ${i}`);
      push({ t: "atom", raw: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 13 || d === 40 || d === 41) break;
      j++;
    }
    push({ t: "atom", raw: text.slice(i, j) });
    i = j;
  }
  if (stack.length) throw new SexprError(`Unclosed list (${stack.length} open) at end of input`);
  return top;
}

// ------------------------------------------------------------------ writing

/** Single-line form, one space between tokens. */
export function compact(e: SExpr): string {
  if (e.t === "atom") return e.raw;
  return `(${e.items.map(compact).join(" ")})`;
}

/** KiCad-formatted text with trailing newline, as eeschema/pcbnew write files (CRLF on Windows). */
export function write(e: SExpr, eol: "\n" | "\r\n" = "\n"): string {
  const t = prettify(compact(e));
  return eol === "\n" ? t : t.replace(/\n/g, eol);
}

/** Line ending used by an existing file (KiCad writes CRLF on Windows, LF elsewhere). */
export const eolOf = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n");

/** Port of KiCad's Prettify() (non-compact mode). */
export function prettify(src: string): string {
  const XY_LIMIT = 99;
  const WRAP = 72;
  let out = "";
  let depth = 0;
  let last = "";
  let inQuote = false;
  let spaced = false;
  let multiLine = false;
  let inXY = false;
  let column = 0;
  let backslashes = 0;
  const ws = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  const tabs = (k: number) => "\t".repeat(k);
  const nextNonWs = (i: number) => { let j = i; while (j < src.length && ws(src[j])) j++; return src[j] ?? ""; };
  const isXY = (i: number) => src[i + 1] === "x" && src[i + 2] === "y" && src[i + 3] === " ";

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ws(ch) && !inQuote) {
      const next = nextNonWs(i);
      if (!spaced && depth > 0 && last !== "(" && next !== ")" && next !== "(") {
        if (inXY || column < WRAP) { out += " "; column++; }
        else { out += `\n${tabs(depth)}`; column = depth; multiLine = true; }
        spaced = true;
      }
      continue;
    }
    spaced = false;
    if (ch === "(" && !inQuote) {
      const curXY = isXY(i);
      if (out.length === 0) { out += "("; column++; }
      else if (inXY && curXY && column < XY_LIMIT) { out += " ("; column += 2; }
      else { out += `\n${tabs(depth)}(`; column = depth + 1; }
      inXY = curXY;
      depth++;
    } else if (ch === ")" && !inQuote) {
      if (depth > 0) depth--;
      if (last === ")" || multiLine) { out += `\n${tabs(depth)})`; column = depth + 1; multiLine = false; }
      else { out += ")"; column++; }
    } else {
      if (ch === "\\") backslashes++;
      else if (ch === '"' && (backslashes & 1) === 0) inQuote = !inQuote;
      if (ch !== "\\") backslashes = 0;
      out += ch;
      column++;
    }
    last = ch;
  }
  return out + "\n";
}
