import { useLayoutEffect, useRef, useState } from "react";
import type { Principal } from "./api";

/** Textarea with an @-autocomplete over people and agents. Mentions are plain "@Name" text. */
export function MentionTextarea({ value, onChange, people, onKeyDown, ...rest }: {
  value: string; onChange: (v: string) => void; people: Principal[]; onKeyDown?: (e: React.KeyboardEvent) => void;
  placeholder?: string; "aria-label"?: string; rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const nextCaret = useRef<number | null>(null);
  // Restore the caret in the same commit that applies the inserted mention, before any further typing.
  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    ref.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    setCaret(nextCaret.current);
    nextCaret.current = null;
  }, [value]);

  const m = /(?:^|\s)@([^@\n]{0,30})$/.exec(value.slice(0, caret));
  const q = m?.[1].toLowerCase() ?? "";
  const options = m && !dismissed ? people.filter((p) => p.name.toLowerCase().startsWith(q)).slice(0, 6) : [];
  const open = options.length > 0;

  const pick = (p: Principal) => {
    const start = caret - (m![1].length + 1);
    const next = `${value.slice(0, start)}@${p.name} ${value.slice(caret)}`;
    const pos = start + p.name.length + 2;
    nextCaret.current = pos;
    onChange(next);
    setDismissed(false);
    ref.current?.focus();
  };

  return (
    <div className="mentionbox">
      {open && (
        <div className="mlist" role="listbox" aria-label="Mention">
          {options.map((p, i) => (
            <div key={p.id} role="option" aria-selected={i === sel} onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseMove={() => setSel(i)}>
              {p.name}<small>{p.kind}</small>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref} value={value} {...rest}
        aria-autocomplete="list" aria-expanded={open}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); setSel(0); setDismissed(false); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((sel + 1) % options.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((sel - 1 + options.length) % options.length); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[sel]); return; }
            if (e.key === "Escape") { e.preventDefault(); e.nativeEvent.stopPropagation(); setDismissed(true); return; }
          }
          onKeyDown?.(e);
        }}
      />
    </div>
  );
}
