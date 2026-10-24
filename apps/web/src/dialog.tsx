import { useEffect, useRef, useState } from "react";

interface Req { title: string; description?: string; label: string; placeholder?: string; initial?: string; confirm: string; multiline: boolean; optional: boolean; resolve: (v: string | null) => void }
let show: ((r: Req) => void) | null = null;

/** In-app replacement for window.prompt: resolves with the text, "" when left blank (optional only), or null when cancelled. */
export const askText = (r: Omit<Req, "resolve" | "multiline" | "optional" | "confirm"> & { multiline?: boolean; optional?: boolean; confirm?: string }) =>
  new Promise<string | null>((resolve) => {
    if (!show) return resolve(null);
    show({ multiline: false, optional: false, confirm: "OK", ...r, resolve });
  });

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => { show = (r) => { opener.current = document.activeElement; setValue(r.initial ?? ""); setReq(r); }; return () => { show = null; }; }, []);
  useEffect(() => { if (req) field.current?.focus(); }, [req]);

  if (!req) return null;
  const close = (v: string | null) => { req.resolve(v); setReq(null); (opener.current as HTMLElement | null)?.focus?.(); };
  const submit = () => { const v = value.trim(); if (v || req.optional) close(v); };
  const props = {
    ref: field, id: "dlg-field", value, placeholder: req.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setValue(e.target.value),
  };

  return (
    <>
      <div className="scrim dlg-scrim" onClick={() => close(null)} />
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); close(null); }
          else if (e.key === "Enter" && (!req.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }}>
        <h2 id="dlg-title">{req.title}</h2>
        {req.description && <p className="dlg-desc">{req.description}</p>}
        <label htmlFor="dlg-field">{req.label}</label>
        {req.multiline ? <textarea rows={4} {...props} /> : <input {...props} />}
        <div className="dlg-actions">
          <button onClick={() => close(null)}>Cancel</button>
          <button className="primary" disabled={!req.optional && !value.trim()} onClick={submit}>{req.confirm}</button>
        </div>
      </div>
    </>
  );
}
