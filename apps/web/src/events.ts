/** One EventSource per tab (browsers allow ~6 HTTP/1.1 connections per origin), shared by every view. */
import { activeOrg } from "./api";
type Cb = () => void;
const subs = new Set<Cb>();
const status = new Set<(live: boolean) => void>();
let es: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function ensure() {
  if (es) return;
  es = new EventSource(activeOrg() ? `/api/events?org=${activeOrg()}` : "/api/events");
  es.onopen = () => status.forEach((f) => f(true));
  es.onerror = () => status.forEach((f) => f(false));
  // A burst of agent activity collapses into one refetch.
  es.addEventListener("change", () => { clearTimeout(timer); timer = setTimeout(() => subs.forEach((f) => f()), 200); });
}
function release() {
  if (subs.size || status.size) return;
  es?.close(); es = null; clearTimeout(timer);
}

export function onChange(cb: Cb) {
  subs.add(cb); ensure();
  return () => { subs.delete(cb); release(); };
}
export function onLive(cb: (live: boolean) => void) {
  status.add(cb); ensure();
  return () => { status.delete(cb); release(); };
}
