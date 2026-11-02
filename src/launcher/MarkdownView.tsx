// Renders the safe markdown tree from ./markdown. Everything is a React text node; links open in the system browser.
import { Fragment, useMemo } from "react";
import { launcherApi } from "./api";
import { parseMarkdown, type Inline } from "./markdown";

function Inlines({ c }: { c: Inline[] }) {
  return <>{c.map((n, i) => {
    switch (n.t) {
      case "text": return <Fragment key={i}>{n.v}</Fragment>;
      case "code": return <code key={i}>{n.v}</code>;
      case "strong": return <strong key={i}><Inlines c={n.c} /></strong>;
      case "em": return <em key={i}><Inlines c={n.c} /></em>;
      case "link": return <a key={i} href={n.href} title={n.href} onClick={(e) => { e.preventDefault(); launcherApi.openExternal(n.href); }}><Inlines c={n.c} /></a>;
    }
  })}</>;
}

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className="md">{blocks.map((b, i) => {
    switch (b.t) {
      case "heading": { const H = (`h${Math.min(6, b.level + 2)}`) as "h3"; return <H key={i}><Inlines c={b.c} /></H>; }
      case "para": return <p key={i}><Inlines c={b.c} /></p>;
      case "quote": return <blockquote key={i}><Inlines c={b.c} /></blockquote>;
      case "code": return <pre key={i}><code>{b.v}</code></pre>;
      case "hr": return <hr key={i} />;
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return <L key={i}>{b.items.map((it, j) => <li key={j} style={it.depth ? { marginLeft: it.depth * 16 } : undefined}><Inlines c={it.c} /></li>)}</L>;
      }
    }
  })}</div>;
}
