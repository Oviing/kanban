const HUES = [["#AF52DE", "#7D3AC1"], ["#32ADE6", "#0A84C8"], ["#FF9F0A", "#E08400"], ["#30B454", "#1F8A3C"], ["#FF5E78", "#D93A56"], ["#5E5CE6", "#4543C4"]];

/** Round initial in a stable colour per name; humans get neutral grey. */
export function Avatar({ name, kind, size = 20 }: { name: string; kind?: string; size?: number }) {
  const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length;
  const bg = kind === "human" ? "linear-gradient(145deg,#A1A1A6,#636366)" : `linear-gradient(145deg,${HUES[h][0]},${HUES[h][1]})`;
  return <span className="av" style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: bg }} aria-hidden="true">{name[0]?.toUpperCase()}</span>;
}

/** Lease as a ring: green while healthy, orange under 10 minutes or expired. */
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
