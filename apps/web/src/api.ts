export type Status = "proposed" | "confirmed" | "in_progress" | "review" | "done";
export const COLUMNS: { status: Status; title: string }[] = [
  { status: "proposed", title: "Proposed" },
  { status: "confirmed", title: "Confirmed" },
  { status: "in_progress", title: "In progress" },
  { status: "review", title: "Review" },
  { status: "done", title: "Done" },
];

export interface Principal { id: string; kind: "human" | "agent"; name: string; role: "admin" | "member"; authMode?: "oidc" | "none"; leaseMinutes?: number }
export interface Task {
  id: string; boardId: string; title: string; description: string; status: Status; priority: number;
  labels: string[]; createdBy: string; assigneeId: string | null; confirmedBy: string | null; version: number;
  needsInput: boolean; question: string | null; leaseExpiresAt: string | null;
  reviewSummary: string | null; reviewLinks: string[];
  /** What the current user may do with this task: target status -> allowed (+ reason if not). */
  moves: Record<Status, { ok: boolean; reason?: string }>;
}
export type InboxKind = "confirm" | "review" | "input" | "stale";
export interface InboxItem { kind: InboxKind; task: Task }
export const isStale = (t: Task) => t.status === "in_progress" && !!t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() < Date.now();
export const isLive = (t: Task) => t.status === "in_progress" && !!t.leaseExpiresAt && !isStale(t);
export interface TaskDetail extends Task {
  comments: { id: string; body: string; createdAt: string; authorName: string; authorKind: string }[];
  events: { id: number; type: string; payload: any; createdAt: string; actorName: string; actorKind: string }[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? data.error ?? res.statusText);
  return data;
}

export type AgentState = "working" | "blocked" | "stale" | "idle";
export interface AgentRow {
  id: string; name: string; state: AgentState; lastActiveAt: string | null; activity: number[];
  tasks: { id: string; title: string; status: Status; needsInput: boolean; question: string | null; leaseExpiresAt: string | null }[];
}
export interface Overview {
  agents: AgentRow[];
  kpis: { agentsActive: number; agentsTotal: number; waitingOnHuman: number; staleLeases: number; doneToday: number };
  pipeline: Record<Status, number>;
}
export interface ActivityItem {
  id: number; type: string; payload: { from?: string; to?: string; summary?: string; question?: string; status?: string }; createdAt: string;
  taskId: string; taskTitle: string; actorName: string; actorKind: "human" | "agent";
}

export const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
/** Minutes until the lease runs out (negative once expired). */
export const leaseMinutesLeft = (t: { leaseExpiresAt: string | null }) =>
  t.leaseExpiresAt ? (() => { const ms = new Date(t.leaseExpiresAt).getTime() - Date.now(); return ms >= 0 ? Math.ceil(ms / 60000) : -Math.ceil(-ms / 60000); })() : null;
export const hostOf = (l: string) => { try { const u = new URL(l); return u.host + u.pathname.replace(/\/$/, ""); } catch { return l; } };

export function describeEvent(e: { type: string; payload: ActivityItem["payload"] }): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "created": return p.status === "confirmed" ? "created" : "proposed";
    case "confirmed": return "confirmed";
    case "claimed": return "claimed";
    case "taken_over": return "took over";
    case "released": return "released";
    case "commented": return "commented on";
    case "assigned": return "assigned";
    case "updated": return "edited";
    case "input_requested": return "asked a question on";
    case "input_answered": return "answered a question on";
    case "moved": return p.to === "review" ? "submitted for review" : p.to === "done" ? "approved" : p.to ? `moved to ${p.to.replace("_", " ")}` : "moved";
    default: return e.type;
  }
}
