/** A deliberately small Markdown subset, parsed to a tree (never to HTML) so rendering needs no sanitiser. */
export type Inline =
  | { t: "text"; v: string } | { t: "code"; v: string } | { t: "b" | "i"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] } | { t: "mention"; v: string };
export type Block =
  | { t: "p"; c: Inline[] } | { t: "code"; v: string } | { t: "ul" | "ol"; items: Inline[][] };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseInline(src: string, names: string[] = []): Inline[] {
  const rules: { re: RegExp; make: (m: RegExpExecArray) => Inline }[] = [
    { re: /`([^`\n]+)`/, make: (m) => ({ t: "code", v: m[1] }) },
    { re: /\*\*([^*\n]+?)\*\*/, make: (m) => ({ t: "b", c: parseInline(m[1], names) }) },
    { re: /(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/, make: (m) => ({ t: "i", c: parseInline(m[1], names) }) },
    { re: /(?<![\w])_([^_\s][^_\n]*?)_(?![\w])/, make: (m) => ({ t: "i", c: parseInline(m[1], names) }) },
    { re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, make: (m) => ({ t: "a", href: m[2], c: parseInline(m[1], names) }) },
    { re: /https?:\/\/[^\s<]*[^\s<.,;:!?)\]]/, make: (m) => ({ t: "a", href: m[0], c: [{ t: "text", v: m[0] }] }) },
  ];
  const clean = names.map((n) => n.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (clean.length) rules.push({ re: new RegExp(`(?<![\\w@])@(${clean.map(esc).join("|")})(?![\\p{L}\\p{N}_])`, "iu"), make: (m) => ({ t: "mention", v: m[0] }) });

  const out: Inline[] = [];
  let rest = src;
  while (rest) {
    let best: { i: number; m: RegExpExecArray; make: (m: RegExpExecArray) => Inline } | null = null;
    for (const r of rules) {
      const m = r.re.exec(rest);
      if (m && (!best || m.index < best.i)) best = { i: m.index, m, make: r.make };
    }
    if (!best) { out.push({ t: "text", v: rest }); break; }
    if (best.i > 0) out.push({ t: "text", v: rest.slice(0, best.i) });
    out.push(best.make(best.m));
    rest = rest.slice(best.i + best.m[0].length);
  }
  return out;
}

export function parseMarkdown(src: string, names: string[] = []): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n"), names) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ t: "code", v: code.join("\n") });
      continue;
    }
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const kind = /\d/.test(li[1]) ? "ol" : "ul";
      const last = blocks[blocks.length - 1];
      const item = parseInline(li[2], names);
      if (last && last.t === kind) last.items.push(item); else blocks.push({ t: kind, items: [item] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}
