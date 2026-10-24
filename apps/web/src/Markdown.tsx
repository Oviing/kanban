import { Fragment, useMemo } from "react";
import { parseMarkdown, type Inline } from "./markdown";

function inline(nodes: Inline[]): React.ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text": return n.v.split("\n").map((l, j) => <Fragment key={`${i}-${j}`}>{j > 0 && <br />}{l}</Fragment>);
      case "code": return <code key={i}>{n.v}</code>;
      case "b": return <strong key={i}>{inline(n.c)}</strong>;
      case "i": return <em key={i}>{inline(n.c)}</em>;
      case "a": return <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{inline(n.c)}</a>;
      case "mention": return <span key={i} className="mention">{n.v}</span>;
    }
  });
}

/** Renders a safe Markdown subset (bold, italic, code, links, lists) with highlighted @mentions of known people. */
export function Markdown({ text, names }: { text: string; names?: string[] }) {
  const blocks = useMemo(() => parseMarkdown(text, names), [text, names]);
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.t === "p" ? <p key={i}>{inline(b.c)}</p>
        : b.t === "code" ? <pre key={i}><code>{b.v}</code></pre>
        : b.t === "ul" ? <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
        : <ol key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>)}
    </div>
  );
}
