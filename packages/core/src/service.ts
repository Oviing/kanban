import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Db } from "./db.js";
import { KanbanError, checkTransition, STATUSES, type Principal, type Status } from "./workflow.js";

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
  createdAt: string;
  updatedAt: string;
}

const TASK_COLS = `id, board_id AS "boardId", title, description, status, priority, labels,
  created_by AS "createdBy", assignee_id AS "assigneeId", confirmed_by AS "confirmedBy",
  confirmed_at AS "confirmedAt", version, created_at AS "createdAt", updated_at AS "updatedAt"`;

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

export async function listBoards(db: Db) {
  const { rows } = await db.query(`SELECT id, name FROM boards ORDER BY created_at`);
  return rows as { id: string; name: string }[];
}

export async function createBoard(db: Db, actor: Principal, name: string) {
  if (actor.kind !== "human") throw new KanbanError("forbidden", "only humans create boards");
  const { rows } = await db.query(`INSERT INTO boards (name) VALUES ($1) RETURNING id, name`, [name]);
  return rows[0] as { id: string; name: string };
}

export async function ensureDefaultBoard(db: Db) {
  const boards = await listBoards(db);
  if (boards.length) return boards[0];
  const { rows } = await db.query(`INSERT INTO boards (name) VALUES ('Main') RETURNING id, name`);
  return rows[0] as { id: string; name: string };
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
  /** Humans (and approving agents) may skip the proposal step. */
  confirmed?: boolean;
}

export async function createTask(db: Db, actor: Principal, i: CreateTaskInput): Promise<Task> {
  if (!i.title?.trim()) throw new KanbanError("invalid", "title is required");
  const task = await db.tx(async (t) => {
    const boardId = i.boardId ?? (await ensureDefaultBoard(t)).id;
    const preConfirm = !!i.confirmed && actor.kind === "human";
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
    await logEvent(t, id, actor, "updated", { fields: Object.keys(i).filter((k) => k !== "expectedVersion") });
    return rows[0];
  });
  notify(task.boardId, id, "updated");
  return task;
}

/** Move a task along the workflow. Side effects (assignee, confirmation stamp) depend on the target status. */
export async function moveTask(db: Db, actor: Principal, id: string, to: Status): Promise<Task> {
  const task = await db.tx(async (t) => {
    const cur = await load(t, id, true);
    checkTransition(actor, cur, to);
    const claim = to === "in_progress" && cur.status === "confirmed";
    const release = to === "confirmed" && cur.status === "in_progress";
    const confirm = to === "confirmed" && cur.status === "proposed";
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET status=$2,
         assignee_id = CASE WHEN $3 THEN $1::uuid WHEN $4 THEN NULL ELSE assignee_id END,
         confirmed_by = CASE WHEN $5 THEN $1::uuid ELSE confirmed_by END,
         confirmed_at = CASE WHEN $5 THEN now() ELSE confirmed_at END,
         version=version+1, updated_at=now()
       WHERE id=$6 RETURNING ${TASK_COLS}`,
      [actor.id, to, claim, release, confirm, id],
    );
    const type = confirm ? "confirmed" : claim ? "claimed" : release ? "released" : "moved";
    await logEvent(t, id, actor, type, { from: cur.status, to });
    return rows[0];
  });
  notify(task.boardId, id, "moved");
  return task;
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
