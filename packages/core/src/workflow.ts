export const STATUSES = ["proposed", "confirmed", "in_progress", "review", "done"] as const;
export type Status = (typeof STATUSES)[number];

export class KanbanError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "invalid" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export interface Principal {
  id: string;
  kind: "human" | "agent";
  name: string;
  role: "admin" | "member";
  canConfirm: boolean;
}

/**
 * Who may approve work: any human, or an agent explicitly granted can_confirm.
 * In an autonomous project (human-in-the-loop switched off) every agent may.
 */
export const mayApprove = (p: Principal, autonomous = false) => p.kind === "human" || p.canConfirm || autonomous;

export interface TaskCtx {
  status: Status;
  createdBy: string;
  assigneeId: string | null;
  /** True when an agent's claim lease has run out (humans never hold leases). */
  leaseExpired: boolean;
  /** The project runs without mandatory human confirmation/approval. */
  autonomous: boolean;
}

type Rule = (actor: Principal, t: TaskCtx) => string | null; // null = allowed, string = reason denied

const isAssignee = (a: Principal, t: TaskCtx) => t.assigneeId === a.id || a.role === "admin";

/** Table-driven transitions. `from -> to` maps to a permission check. */
const RULES: Record<string, Rule> = {
  "proposed->confirmed": (a, t) =>
    !mayApprove(a, t.autonomous)
      ? "this principal may not confirm tasks"
      : a.kind === "agent" && t.createdBy === a.id && !t.autonomous
        ? "an agent cannot confirm a task it created"
        : null,
  "confirmed->in_progress": (a, t) =>
    t.assigneeId && t.assigneeId !== a.id ? "task is already claimed" : null,
  // Take over a stale claim: only possible once the holder's lease has expired.
  "in_progress->in_progress": (a, t) =>
    t.assigneeId === a.id
      ? "you already hold this task"
      : !t.leaseExpired
        ? "held by another assignee whose lease has not expired"
        : null,
  "in_progress->confirmed": (a, t) => (isAssignee(a, t) ? null : "only the assignee can release a task"),
  "in_progress->review": (a, t) => (isAssignee(a, t) ? null : "only the assignee can submit for review"),
  "review->done": (a, t) =>
    !mayApprove(a, t.autonomous)
      ? "this principal may not approve work"
      : t.assigneeId === a.id
        ? "the assignee cannot approve their own work"
        : null,
  "review->in_progress": (a, t) => (mayApprove(a, t.autonomous) ? null : "this principal may not request changes"),
};

export function checkTransition(actor: Principal, task: TaskCtx, to: Status): void {
  const rule = RULES[`${task.status}->${to}`];
  if (!rule) throw new KanbanError("invalid", `cannot move a task from ${task.status} to ${to}`);
  const denied = rule(actor, task);
  if (denied) throw new KanbanError("forbidden", denied);
}

export const allowedTargets = (from: Status) =>
  Object.keys(RULES)
    .filter((k) => k.startsWith(`${from}->`))
    .map((k) => k.split("->")[1] as Status);

export interface MoveOption {
  to: Status;
  ok: boolean;
  reason?: string;
}

/** For every status: may this actor move the task there, and if not, why not. Drives rule-aware drag & drop. */
export function explainMoves(actor: Principal, task: TaskCtx): MoveOption[] {
  return STATUSES.map((to) => {
    try {
      checkTransition(actor, task, to);
      return { to, ok: true };
    } catch (e) {
      return { to, ok: false, reason: (e as Error).message };
    }
  });
}
