// Small, safe markdown parser for release notes. It produces a tree that React renders as text nodes, so raw
// HTML in a release body can never reach the DOM: tags are stripped (their text kept), comments dropped, images
// become links, and only http(s) links survive.

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "list"; ordered: boolean; items: { depth: number; c: Inline[] }[] }
  | { t: "code"; v: string }
  | { t: "quote"; c: Inline[] }
  | { t: "hr" };

/** Only absolute http(s) URLs; anything else (javascript:, data:, file:, relative) is refused. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (!/^https?:\/\//i.test(h)) return null;
  try {
    const u = new URL(h);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch { return null; }
}

/** Remove HTML comments and tags, keeping the text between tags. */
export function stripHtml(s: string): string {
  return s.replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/<\/?[A-Za-z][^<>]*>/g, "");
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const push = (n: Inline) => { if (text) { out.push({ t: "text", v: text }); text = ""; } out.push(n); };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_[\]()#!<>-]/.test(rest[1])) { text += rest[1]; i += 2; continue; }
    if ((m = /^`([^`]+)`/.exec(rest))) { push({ t: "code", v: m[1] }); i += m[0].length; continue; }
    if ((m = /^!?\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(rest))) {
      const href = safeHref(m[2]);
      const label = m[1] || m[2];
      if (href) push({ t: "link", href, c: parseInline(label) });
      else text += label;
      i += m[0].length; continue;
    }
    if ((m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) {
      const href = safeHref(m[1]);
      if (href) push({ t: "link", href, c: [{ t: "text", v: m[1] }] }); else text += m[1];
      i += m[0].length; continue;
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) { push({ t: "strong", c: parseInline(m[2]) }); i += m[0].length; continue; }
    if ((m = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_])/.exec(rest)) && !(m[1] === "_" && /\w/.test(src[i - 1] ?? ""))) {
      push({ t: "em", c: parseInline(m[2]) }); i += m[0].length; continue;
    }
    if ((m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)) && !/\w/.test(src[i - 1] ?? "")) {
      const href = safeHref(m[0]);
      if (href) { push({ t: "link", href, c: [{ t: "text", v: m[0] }] }); i += m[0].length; continue; }
    }
    text += src[i]; i++;
  }
  if (text) out.push({ t: "text", v: text });
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const lines = stripHtml(md.replace(/\r\n?/g, "\n")).split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => { if (para.length) { blocks.push({ t: "para", c: parseInline(para.join(" ")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (/^\s*(```|~~~)/.test(line)) {
      endPara();
      const fence = line.trim().slice(0, 3);
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) code.push(lines[i]);
      blocks.push({ t: "code", v: code.join("\n") });
      continue;
    }
    if (!line.trim()) { endPara(); continue; }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { endPara(); blocks.push({ t: "heading", level: m[1].length, c: parseInline(m[2]) }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { endPara(); blocks.push({ t: "hr" }); continue; }
    if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) { endPara(); blocks.push({ t: "quote", c: parseInline(m[1]) }); continue; }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      endPara();
      const ordered = /\d/.test(m[2]);
      const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
      const prev = blocks[blocks.length - 1];
      const item = { depth, c: parseInline(m[3]) };
      if (prev && prev.t === "list" && (prev.ordered === ordered || depth > 0)) prev.items.push(item);
      else blocks.push({ t: "list", ordered, items: [item] });
      continue;
    }
    // A continuation line of the previous list item.
    const prev = blocks[blocks.length - 1];
    if (!para.length && prev?.t === "list" && /^\s+\S/.test(line)) {
      const it = prev.items[prev.items.length - 1];
      it.c = [...it.c, { t: "text", v: " " }, ...parseInline(line.trim())];
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}
