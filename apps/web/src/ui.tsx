import { useEffect, useState } from "react";

const HUES = [["#AF52DE", "#7D3AC1"], ["#32ADE6", "#0A84C8"], ["#FF9F0A", "#E08400"], ["#30B454", "#1F8A3C"], ["#FF5E78", "#D93A56"], ["#5E5CE6", "#4543C4"]];

/** Initial in a stable colour per name. Agents are rounded squares, humans circles (and neutral grey). */
export function Avatar({ name, kind, size = 20 }: { name: string; kind?: string; size?: number }) {
  const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length;
  const bg = kind === "human" ? "linear-gradient(145deg,#A1A1A6,#636366)" : `linear-gradient(145deg,${HUES[h][0]},${HUES[h][1]})`;
  const radius = kind === "agent" ? Math.round(size * 0.32) : "50%";
  return <span className="av" style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: bg, borderRadius: radius }} aria-hidden="true">{name[0]?.toUpperCase()}</span>;
}

/** Lease as a ring: blue while healthy, orange under 10 minutes or expired. */
export function Ring({ left, total }: { left: number; total: number }) {
  const p = Math.max(0, Math.min(1, left / total));
  const c = 2 * Math.PI * 7.5;
  const warn = left < 10;
  return (
    <svg className="ring" viewBox="0 0 20 20" role="img" aria-label={left < 0 ? "Lease expired" : `${left} minutes left on the lease`}>
      <title>{left < 0 ? `Lease expired ${-left}m ago` : `Lease: ${left}m left`}</title>
      <circle cx="10" cy="10" r="7.5" className="ring-bg" />
      <circle cx="10" cy="10" r="7.5" className={`ring-fg${warn ? " warn" : ""}`} strokeDasharray={`${c * p} ${c}`} />
    </svg>
  );
}

export const Kbd = ({ children }: { children: React.ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function useMedia(query: string) {
  const [m, set] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const q = window.matchMedia(query);
    const h = () => set(q.matches);
    q.addEventListener("change", h);
    return () => q.removeEventListener("change", h);
  }, [query]);
  return m;
}

/** True while the user is typing in a field, so single-key shortcuts must stay out of the way. */
export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
};
