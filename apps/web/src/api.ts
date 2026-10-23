export type Status = "proposed" | "confirmed" | "in_progress" | "review" | "done";
export const COLUMNS: { status: Status; title: string }[] = [
  { status: "proposed", title: "Proposed" },
  { status: "confirmed", title: "Confirmed" },
  { status: "in_progress", title: "In progress" },
  { status: "review", title: "Review" },
  { status: "done", title: "Done" },
];

export interface Principal { id: string; kind: "human" | "agent"; name: string; role: "admin" | "member"; canConfirm: boolean }
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
