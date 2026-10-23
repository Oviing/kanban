import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Db } from "./db.js";
import { KanbanError, checkTransition, mayApprove, explainMoves, STATUSES, type Principal, type Status, type TaskCtx } from "./workflow.js";

/** How long an agent's claim stays valid without a sign of life (comment, update, heartbeat). */
let leaseSeconds = 30 * 60;
export const setLeaseMinutes = (m: number) => void (leaseSeconds = Math.round(m * 60));

/** In-process change feed (one instance). The server forwards these to SSE clients. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export interface Task {
  id: string;
  boardId: string;
  title: string;
  description: string;
  status: Status;
  priority: number;
  labels: string[];
  createdBy: string;
  assigneeId: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  version: number;
  needsInput: boolean;
  question: string | null;
  leaseExpiresAt: string | null;
  reviewSummary: string | null;
  reviewLinks: string[];
  /** Whether the task's project requires humans to confirm/approve (default true). */
  humanInLoop: boolean;
  createdAt: string;
  updatedAt: string;
}

export const taskCtx = (t: Task): TaskCtx => ({
  status: t.status,
  createdBy: t.createdBy,
  assigneeId: t.assigneeId,
  leaseExpired: !!t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() < Date.now(),
  autonomous: !t.humanInLoop,
});

const TASK_COLS = `id, board_id AS "boardId", title, description, status, priority, labels,
  created_by AS "createdBy", assignee_id AS "assigneeId", confirmed_by AS "confirmedBy",
  confirmed_at AS "confirmedAt", version,
  needs_input AS "needsInput", question, lease_expires_at AS "leaseExpiresAt",
  review_summary AS "reviewSummary", review_links AS "reviewLinks",
  (SELECT human_in_loop FROM boards b WHERE b.id = tasks.board_id) AS "humanInLoop", created_at AS "createdAt", updated_at AS "updatedAt"`;

const PRINCIPAL_COLS = `id, kind, name, role, can_confirm AS "canConfirm"`;

// ---------- principals & keys ----------

export async function upsertOidcPrincipal(
  db: Db,
  i: { issuer: string; sub: string; kind: "human" | "agent"; name: string; email?: string | null },
  adminEmails: string[] = [],
): Promise<Principal> {
  const email = i.email?.toLowerCase() ?? null;
  const isAdmin = i.kind === "human" && !!email && adminEmails.map((e) => e.toLowerCase()).includes(email);
  const { rows } = await db.query<Principal>(
    `INSERT INTO principals (kind, oidc_issuer, oidc_sub, name, email, role)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (oidc_issuer, oidc_sub) DO UPDATE
       SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, principals.email),
           role = CASE WHEN $6 = 'admin' THEN 'admin' ELSE principals.role END
     RETURNING ${PRINCIPAL_COLS}`,
    [i.kind, i.issuer, i.sub, i.name, email, isAdmin ? "admin" : "member"],
  );
  return rows[0];
}

/** The very first human to sign in becomes admin so a fresh deployment is manageable. */
export async function promoteFirstHuman(db: Db, p: Principal): Promise<Principal> {
  if (p.kind !== "human" || p.role === "admin") return p;
  const { rows } = await db.query<Principal>(
    `UPDATE principals SET role='admin' WHERE id=$1
       AND NOT EXISTS (SELECT 1 FROM principals WHERE kind='human' AND role='admin')
     RETURNING ${PRINCIPAL_COLS}`,
    [p.id],
  );
  return rows[0] ?? p;
}

export async function listPrincipals(db: Db) {
  const { rows } = await db.query(
    `SELECT ${PRINCIPAL_COLS}, email, created_at AS "createdAt" FROM principals ORDER BY created_at`,
  );
  return rows;
}

export async function createAgent(db: Db, actor: Principal, i: { name: string; canConfirm?: boolean }) {
  requireAdmin(actor);
  const { rows } = await db.query<Principal>(
    `INSERT INTO principals (kind, name, can_confirm) VALUES ('agent',$1,$2) RETURNING ${PRINCIPAL_COLS}`,
    [i.name, !!i.canConfirm],
  );
  return rows[0];
}

export async function updatePrincipal(
  db: Db,
  actor: Principal,
  id: string,
  i: { canConfirm?: boolean; role?: "admin" | "member" },
) {
  requireAdmin(actor);
  const { rows } = await db.query<Principal>(
    `UPDATE principals SET can_confirm = COALESCE($2, can_confirm), role = COALESCE($3, role)
     WHERE id=$1 RETURNING ${PRINCIPAL_COLS}`,
    [id, i.canConfirm ?? null, i.role ?? null],
  );
  if (!rows[0]) throw new KanbanError("not_found", "principal not found");
  return rows[0];
}

const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");

export async function createApiKey(db: Db, actor: Principal, agentId: string, label = "") {
  requireAdmin(actor);
  const { rows } = await db.query(`SELECT 1 FROM principals WHERE id=$1 AND kind='agent'`, [agentId]);
  if (!rows[0]) throw new KanbanError("not_found", "agent not found");
  const key = `kb_${randomBytes(24).toString("base64url")}`;
  const { rows: r } = await db.query(
    `INSERT INTO api_keys (principal_id, label, prefix, hash) VALUES ($1,$2,$3,$4)
     RETURNING id, label, prefix, created_at AS "createdAt"`,
    [agentId, label, key.slice(0, 9), hashKey(key)],
  );
  return { ...r[0], key }; // plaintext key is only ever returned here
}

export async function listApiKeys(db: Db, actor: Principal) {
  requireAdmin(actor);
  const { rows } = await db.query(
    `SELECT id, principal_id AS "principalId", label, prefix, created_at AS "createdAt",
            last_used_at AS "lastUsedAt", revoked_at AS "revokedAt" FROM api_keys ORDER BY created_at DESC`,
  );
  return rows;
}

export async function revokeApiKey(db: Db, actor: Principal, id: string) {
  requireAdmin(actor);
  await db.query(`UPDATE api_keys SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL`, [id]);
}

export async function verifyApiKey(db: Db, key: string): Promise<Principal | null> {
  if (!key.startsWith("kb_")) return null;
  const { rows } = await db.query<Principal>(
    `UPDATE api_keys k SET last_used_at = now() FROM principals p
     WHERE k.hash=$1 AND k.revoked_at IS NULL AND p.id = k.principal_id
     RETURNING p.id, p.kind, p.name, p.role, p.can_confirm AS "canConfirm"`,
    [hashKey(key)],
  );
  return rows[0] ?? null;
}

function requireAdmin(a: Principal) {
  if (a.role !== "admin" || a.kind !== "human") throw new KanbanError("forbidden", "admin only");
}

// ---------- boards ----------

export interface Board { id: string; name: string; humanInLoop: boolean }
const BOARD_COLS = `id, name, human_in_loop AS "humanInLoop"`;

export async function listBoards(db: Db) {
  const { rows } = await db.query(`SELECT ${BOARD_COLS} FROM boards ORDER BY created_at`);
  return rows as Board[];
}

export async function createBoard(db: Db, actor: Principal, name: string, humanInLoop = true) {
  if (actor.kind !== "human") throw new KanbanError("forbidden", "only humans create projects");
  if (!name?.trim()) throw new KanbanError("invalid", "name is required");
  if (!humanInLoop) requireAdmin(actor);
  const { rows } = await db.query(`INSERT INTO boards (name, human_in_loop) VALUES ($1,$2) RETURNING ${BOARD_COLS}`, [name.trim(), humanInLoop]);
  return rows[0] as Board;
}

export async function renameBoard(db: Db, actor: Principal, id: string, name: string) {
  if (actor.kind !== "human") throw new KanbanError("forbidden", "only humans manage projects");
  if (!name?.trim()) throw new KanbanError("invalid", "name is required");
  const { rows } = await db.query(`UPDATE boards SET name=$2 WHERE id=$1 RETURNING ${BOARD_COLS}`, [id, name.trim()]);
  if (!rows[0]) throw new KanbanError("not_found", "project not found");
  return rows[0] as Board;
}

/** Switch mandatory human confirmation/approval on or off for a project. Admin only; changes governance, so it is audited in the log. */
export async function setHumanInLoop(db: Db, actor: Principal, id: string, humanInLoop: boolean) {
  requireAdmin(actor);
  const { rows } = await db.query(`UPDATE boards SET human_in_loop=$2 WHERE id=$1 RETURNING ${BOARD_COLS}`, [id, humanInLoop]);
  if (!rows[0]) throw new KanbanError("not_found", "project not found");
  console.log(JSON.stringify({ audit: "human_in_loop", boardId: id, humanInLoop, by: actor.id, at: new Date().toISOString() }));
  notify(id, "", "settings");
  return rows[0] as Board;
}

export async function ensureDefaultBoard(db: Db) {
  const boards = await listBoards(db);
  if (boards.length) return boards[0];
  const { rows } = await db.query(`INSERT INTO boards (name) VALUES ('Main') RETURNING ${BOARD_COLS}`);
  return rows[0] as Board;
}

// ---------- tasks ----------

async function logEvent(db: Db, taskId: string, actor: Principal, type: string, payload: object = {}) {
  await db.query(`INSERT INTO events (task_id, actor_id, type, payload) VALUES ($1,$2,$3,$4)`, [
    taskId,
    actor.id,
    type,
    JSON.stringify(payload),
  ]);
}

/** Any activity by the current agent assignee counts as a sign of life and renews the lease. */
async function touchLease(db: Db, taskId: string, actor: Principal) {
  await db.query(
    `UPDATE tasks SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE id=$1 AND status='in_progress' AND assignee_id=$2 AND lease_expires_at IS NOT NULL`,
    [taskId, actor.id, leaseSeconds],
  );
}

const notify = (boardId: string, taskId: string, type: string) => bus.emit("change", { boardId, taskId, type });

async function load(db: Db, id: string, lock = false): Promise<Task> {
  const { rows } = await db.query<Task>(`SELECT ${TASK_COLS} FROM tasks WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!rows[0]) throw new KanbanError("not_found", "task not found");
  return rows[0];
}

export interface CreateTaskInput {
  boardId?: string;
  title: string;
  description?: string;
  priority?: number;
  labels?: string[];
  /** Humans may skip the proposal step; so may agents in an autonomous project. */
  confirmed?: boolean;
}

export async function createTask(db: Db, actor: Principal, i: CreateTaskInput): Promise<Task> {
  if (!i.title?.trim()) throw new KanbanError("invalid", "title is required");
  const task = await db.tx(async (t) => {
    const boardId = i.boardId ?? (await ensureDefaultBoard(t)).id;
    const board = (await t.query<{ humanInLoop: boolean }>(`SELECT human_in_loop AS "humanInLoop" FROM boards WHERE id=$1`, [boardId])).rows[0];
    if (!board) throw new KanbanError("not_found", "project not found");
    const preConfirm = !!i.confirmed && (actor.kind === "human" || !board.humanInLoop);
    const { rows } = await t.query<Task>(
      `INSERT INTO tasks (board_id, title, description, priority, labels, created_by, status, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${preConfirm ? "now()" : "NULL"}) RETURNING ${TASK_COLS}`,
      [
        boardId,
        i.title.trim(),
        i.description ?? "",
        i.priority ?? 2,
        i.labels ?? [],
        actor.id,
        preConfirm ? "confirmed" : "proposed",
        preConfirm ? actor.id : null,
      ],
    );
    await logEvent(t, rows[0].id, actor, "created", { status: rows[0].status });
    return rows[0];
  });
  notify(task.boardId, task.id, "created");
  return task;
}

export async function getTask(db: Db, id: string) {
  const task = await load(db, id);
  const [comments, events] = await Promise.all([
    db.query(
      `SELECT c.id, c.body, c.created_at AS "createdAt", c.author_id AS "authorId", p.name AS "authorName", p.kind AS "authorKind"
       FROM comments c JOIN principals p ON p.id = c.author_id WHERE c.task_id=$1 ORDER BY c.created_at`,
      [id],
    ),
    db.query(
      `SELECT e.id, e.type, e.payload, e.created_at AS "createdAt", e.actor_id AS "actorId", p.name AS "actorName", p.kind AS "actorKind"
       FROM events e JOIN principals p ON p.id = e.actor_id WHERE e.task_id=$1 ORDER BY e.id`,
      [id],
    ),
  ]);
  return { ...task, comments: comments.rows, events: events.rows };
}

export interface ListFilter {
  boardId?: string;
  status?: Status;
  assigneeId?: string;
  label?: string;
}

export async function listTasks(db: Db, f: ListFilter = {}): Promise<Task[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (cond: string, v: unknown) => (params.push(v), where.push(cond.replace("?", `$${params.length}`)));
  if (f.boardId) add("board_id = ?", f.boardId);
  if (f.status) {
    if (!STATUSES.includes(f.status)) throw new KanbanError("invalid", `unknown status ${f.status}`);
    add("status = ?", f.status);
  }
  if (f.assigneeId) add("assignee_id = ?", f.assigneeId);
  if (f.label) add("? = ANY(labels)", f.label);
  const { rows } = await db.query<Task>(
    `SELECT ${TASK_COLS} FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY priority DESC, created_at`,
    params,
  );
  return rows;
}

export async function updateTask(
  db: Db,
  actor: Principal,
  id: string,
  i: { title?: string; description?: string; priority?: number; labels?: string[]; expectedVersion?: number },
): Promise<Task> {
  const task = await db.tx(async (t) => {
    const cur = await load(t, id, true);
    if (i.expectedVersion !== undefined && i.expectedVersion !== cur.version)
      throw new KanbanError("conflict", `task changed (version ${cur.version})`);
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET title=COALESCE($2,title), description=COALESCE($3,description),
         priority=COALESCE($4,priority), labels=COALESCE($5,labels), version=version+1, updated_at=now()
       WHERE id=$1 RETURNING ${TASK_COLS}`,
      [id, i.title?.trim() || null, i.description ?? null, i.priority ?? null, i.labels ?? null],
    );
    await touchLease(t, id, actor);
    await logEvent(t, id, actor, "updated", { fields: Object.keys(i).filter((k) => k !== "expectedVersion") });
    return rows[0];
  });
  notify(task.boardId, id, "updated");
  return task;
}

export interface MoveOptions {
  /** What was done; required from agents when submitting for review. */
  summary?: string;
  /** Evidence: PRs, files, logs. */
  links?: string[];
}

/** Move a task along the workflow. Side effects (assignee, lease, evidence) depend on the target status. */
export async function moveTask(db: Db, actor: Principal, id: string, to: Status, opts: MoveOptions = {}): Promise<Task> {
  const task = await db.tx(async (t) => {
    const cur = await load(t, id, true);
    checkTransition(actor, taskCtx(cur), to);
    if (to === "review" && actor.kind === "agent" && !opts.summary?.trim())
      throw new KanbanError("invalid", "a summary of the work is required when submitting for review");
    const takeover = cur.status === "in_progress" && to === "in_progress";
    const claim = to === "in_progress" && (cur.status === "confirmed" || takeover);
    const release = to === "confirmed" && cur.status === "in_progress";
    const confirm = to === "confirmed" && cur.status === "proposed";
    const newAssignee = claim ? actor.id : release ? null : cur.assigneeId;
    let leased = false;
    if (to === "in_progress" && newAssignee) {
      const kind = claim ? actor.kind : (await t.query<{ kind: string }>(`SELECT kind FROM principals WHERE id=$1`, [newAssignee])).rows[0]?.kind;
      leased = kind === "agent";
    }
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET status=$2,
         assignee_id = $3::uuid,
         confirmed_by = CASE WHEN $4 THEN $1::uuid ELSE confirmed_by END,
         confirmed_at = CASE WHEN $4 THEN now() ELSE confirmed_at END,
         lease_expires_at = CASE WHEN $5 THEN now() + make_interval(secs => $6) ELSE NULL END,
         review_summary = CASE WHEN $2 = 'review' THEN $7::text ELSE review_summary END,
         review_links = CASE WHEN $2 = 'review' THEN $8::text[] ELSE review_links END,
         needs_input = CASE WHEN $2 IN ('done','confirmed') THEN false ELSE needs_input END,
         version=version+1, updated_at=now()
       WHERE id=$9 RETURNING ${TASK_COLS}`,
      [actor.id, to, newAssignee, confirm, leased, leaseSeconds, opts.summary?.trim() ?? null, opts.links ?? [], id],
    );
    const type = confirm ? "confirmed" : takeover ? "taken_over" : claim ? "claimed" : release ? "released" : "moved";
    await logEvent(t, id, actor, type, {
      from: cur.status, to,
      ...(takeover ? { previousAssigneeId: cur.assigneeId } : {}),
      ...(to === "review" && opts.summary ? { summary: opts.summary.trim() } : {}),
    });
    return rows[0];
  });
  notify(task.boardId, id, "moved");
  return task;
}

/** Agents call this while working on a long step so the claim does not look abandoned. */
export async function heartbeatTask(db: Db, actor: Principal, id: string): Promise<Task> {
  const cur = await load(db, id);
  if (cur.status !== "in_progress" || cur.assigneeId !== actor.id)
    throw new KanbanError("invalid", "you do not hold this task");
  await touchLease(db, id, actor);
  return load(db, id);
}

export async function requestInput(db: Db, actor: Principal, id: string, question: string): Promise<Task> {
  if (!question?.trim()) throw new KanbanError("invalid", "question is required");
  const task = await db.tx(async (t) => {
    const cur = await load(t, id, true);
    if (cur.status === "done") throw new KanbanError("invalid", "task is done");
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET needs_input=true, question=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${TASK_COLS}`,
      [id, question.trim()],
    );
    await t.query(`INSERT INTO comments (task_id, author_id, body) VALUES ($1,$2,$3)`, [id, actor.id, `Question: ${question.trim()}`]);
    await touchLease(t, id, actor);
    await logEvent(t, id, actor, "input_requested", { question: question.trim() });
    return rows[0];
  });
  notify(task.boardId, id, "input_requested");
  return task;
}

export async function answerInput(db: Db, actor: Principal, id: string, answer: string): Promise<Task> {
  if (!answer?.trim()) throw new KanbanError("invalid", "answer is required");
  const task = await db.tx(async (t) => {
    const cur = await load(t, id, true);
    if (!mayApprove(actor, !cur.humanInLoop)) throw new KanbanError("forbidden", "this principal may not answer questions");
    if (actor.kind === "agent" && cur.assigneeId === actor.id) throw new KanbanError("forbidden", "an agent cannot answer its own question");
    if (!cur.needsInput) throw new KanbanError("invalid", "no question is pending on this task");
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET needs_input=false, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${TASK_COLS}`,
      [id],
    );
    await t.query(`INSERT INTO comments (task_id, author_id, body) VALUES ($1,$2,$3)`, [id, actor.id, `Answer: ${answer.trim()}`]);
    await logEvent(t, id, actor, "input_answered");
    return rows[0];
  });
  notify(task.boardId, id, "input_answered");
  return task;
}

export type InboxKind = "confirm" | "review" | "input" | "stale";
export interface InboxItem { kind: InboxKind; task: Task }

/** Everything currently waiting on this principal to make a decision. */
export async function inbox(db: Db, actor: Principal): Promise<InboxItem[]> {
  const { rows } = await db.query<Task>(
    `SELECT ${TASK_COLS} FROM tasks WHERE status <> 'done' AND (status IN ('proposed','review') OR needs_input OR lease_expires_at < now())
     ORDER BY priority DESC, updated_at`,
  );
  const can = (t: Task, to: Status) => explainMoves(actor, taskCtx(t)).find((m) => m.to === to)!.ok;
  const out: InboxItem[] = [];
  for (const t of rows) {
    if (t.status === "proposed" && can(t, "confirmed")) out.push({ kind: "confirm", task: t });
    if (t.status === "review" && can(t, "done")) out.push({ kind: "review", task: t });
    if (t.needsInput && mayApprove(actor, !t.humanInLoop) && t.assigneeId !== actor.id) out.push({ kind: "input", task: t });
    if (t.status === "in_progress" && taskCtx(t).leaseExpired && actor.kind === "human") out.push({ kind: "stale", task: t });
  }
  return out;
}

export const confirmTask = (db: Db, actor: Principal, id: string) => moveTask(db, actor, id, "confirmed");
export const claimTask = (db: Db, actor: Principal, id: string) => moveTask(db, actor, id, "in_progress");

export async function releaseTask(db: Db, actor: Principal, id: string) {
  return moveTask(db, actor, id, "confirmed");
}

export async function assignTask(db: Db, actor: Principal, id: string, assigneeId: string | null) {
  const task = await db.tx(async (t) => {
    const cur = await load(t, id, true);
    if (cur.status === "proposed" || cur.status === "done")
      throw new KanbanError("invalid", `cannot assign a ${cur.status} task`);
    if (actor.kind === "agent" && assigneeId !== actor.id)
      throw new KanbanError("forbidden", "agents can only assign tasks to themselves");
    if (assigneeId) {
      const { rows } = await t.query(`SELECT 1 FROM principals WHERE id=$1`, [assigneeId]);
      if (!rows[0]) throw new KanbanError("not_found", "assignee not found");
    }
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET assignee_id=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${TASK_COLS}`,
      [id, assigneeId],
    );
    await logEvent(t, id, actor, "assigned", { assigneeId });
    return rows[0];
  });
  notify(task.boardId, id, "assigned");
  return task;
}

export async function addComment(db: Db, actor: Principal, taskId: string, body: string) {
  if (!body?.trim()) throw new KanbanError("invalid", "comment body is required");
  const out = await db.tx(async (t) => {
    const task = await load(t, taskId);
    const { rows } = await t.query(
      `INSERT INTO comments (task_id, author_id, body) VALUES ($1,$2,$3)
       RETURNING id, body, created_at AS "createdAt"`,
      [taskId, actor.id, body.trim()],
    );
    await touchLease(t, taskId, actor);
    await logEvent(t, taskId, actor, "commented");
    return { comment: rows[0], boardId: task.boardId };
  });
  notify(out.boardId, taskId, "commented");
  return out.comment;
}

export async function getPrincipal(db: Db, id: string): Promise<Principal | null> {
  const { rows } = await db.query<Principal>(`SELECT ${PRINCIPAL_COLS} FROM principals WHERE id=$1`, [id]);
  return rows[0] ?? null;
}
