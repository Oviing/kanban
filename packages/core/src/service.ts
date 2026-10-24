import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Db } from "./db.js";
import { KanbanError, checkTransition, explainMoves, STATUSES, type Principal, type Status, type TaskCtx } from "./workflow.js";

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
  /** Suggested one-click answers the asker offered with the question (may be empty). */
  questionOptions: string[];
  /** Who asked the pending question; they cannot answer it. */
  questionBy: string | null;
  leaseExpiresAt: string | null;
  reviewSummary: string | null;
  reviewLinks: string[];
  createdAt: string;
  updatedAt: string;
}

export const taskCtx = (t: Task): TaskCtx => ({
  status: t.status,
  createdBy: t.createdBy,
  assigneeId: t.assigneeId,
  leaseExpired: !!t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() < Date.now(),
});

const TASK_COLS = `id, board_id AS "boardId", title, description, status, priority, labels,
  created_by AS "createdBy", assignee_id AS "assigneeId", confirmed_by AS "confirmedBy",
  confirmed_at AS "confirmedAt", version,
  needs_input AS "needsInput", question, question_options AS "questionOptions", question_by AS "questionBy", lease_expires_at AS "leaseExpiresAt",
  review_summary AS "reviewSummary", review_links AS "reviewLinks",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface Org { id: string; name: string; slug: string }
export async function defaultOrg(db: Db): Promise<Org> {
  const { rows } = await db.query<Org>(`SELECT id, name, slug FROM organizations ORDER BY created_at LIMIT 1`);
  return rows[0];
}

// ---------- principals & keys ----------

type OidcIdentity = { issuer: string; sub: string; kind: "human" | "agent"; name: string; email?: string | null };
/**
 * Find or create the principal for an IdP identity. `orgId` is the organization a new person joins (default: the
 * built-in one, which suits single-tenant installs). Pass `null` for identity only: the person joins nothing and
 * the caller creates or picks an organization (multi-tenant sign-up).
 */
export async function upsertOidcPrincipal(db: Db, i: OidcIdentity, adminEmails: string[], orgId: null): Promise<{ id: string; kind: "human" | "agent"; name: string }>;
export async function upsertOidcPrincipal(db: Db, i: OidcIdentity, adminEmails?: string[], orgId?: string): Promise<Principal>;
export async function upsertOidcPrincipal(db: Db, i: OidcIdentity, adminEmails: string[] = [], orgId?: string | null): Promise<any> {
  const email = i.email?.toLowerCase() ?? null;
  const isAdmin = i.kind === "human" && !!email && adminEmails.map((e) => e.toLowerCase()).includes(email);
  const org = orgId === null ? null : orgId ?? (await defaultOrg(db)).id;
  return db.tx(async (t) => {
    const { rows } = await t.query<{ id: string }>(
      `INSERT INTO principals (kind, oidc_issuer, oidc_sub, name, email, org_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (oidc_issuer, oidc_sub) DO UPDATE
         SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, principals.email)
       RETURNING id`,
      [i.kind, i.issuer, i.sub, i.name, email, i.kind === "agent" ? org : null],
    );
    const id = rows[0].id;
    if (!org) return { id, kind: i.kind, name: i.name };
    if (i.kind === "human") {
      // First sight joins `org`; later sign-ins keep their memberships (an admin email still promotes).
      const known = (await t.query(`SELECT 1 FROM memberships WHERE principal_id=$1`, [id])).rows[0];
      if (!known || orgId)
        await t.query(
          `INSERT INTO memberships (org_id, principal_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (org_id, principal_id) DO UPDATE SET role = CASE WHEN $3 = 'admin' THEN 'admin' ELSE memberships.role END`,
          [org, id, isAdmin ? "admin" : "member"],
        );
      else if (isAdmin) await t.query(`UPDATE memberships SET role='admin' WHERE principal_id=$1 AND org_id=$2`, [id, org]);
    }
    return (await getPrincipal(t, id, i.kind === "human" ? org : undefined))!;
  });
}

/** The very first human to sign in becomes admin so a fresh deployment is manageable. */
export async function promoteFirstHuman(db: Db, p: Principal): Promise<Principal> {
  if (p.kind !== "human" || p.role === "admin") return p;
  await db.query(
    `UPDATE memberships SET role='admin' WHERE principal_id=$1 AND org_id=$2
       AND NOT EXISTS (SELECT 1 FROM memberships WHERE org_id=$2 AND role='admin')`,
    [p.id, p.orgId],
  );
  return (await getPrincipal(db, p.id, p.orgId)) ?? p;
}

/** People and agents of the actor's organization. */
export async function listPrincipals(db: Db, actor: Principal) {
  const { rows } = await db.query(
    `SELECT p.id, p.kind, p.name, COALESCE(m.role, 'member') AS role, p.email, p.created_at AS "createdAt"
     FROM principals p LEFT JOIN memberships m ON m.principal_id = p.id AND m.org_id = $1
     WHERE p.org_id = $1 OR m.org_id = $1 ORDER BY p.created_at`,
    [actor.orgId],
  );
  return rows;
}

export async function createAgent(db: Db, actor: Principal, i: { name: string }) {
  requireAdmin(actor);
  const { rows } = await db.query<Principal>(
    `INSERT INTO principals (kind, name, org_id) VALUES ('agent',$1,$2) RETURNING id, kind, name, 'member' AS role, org_id AS "orgId"`,
    [i.name, actor.orgId],
  );
  return rows[0];
}

export async function updatePrincipal(
  db: Db,
  actor: Principal,
  id: string,
  i: { role?: "admin" | "member" },
) {
  requireAdmin(actor);
  return db.tx(async (t) => {
    // Serialize role changes per org so two admins can't demote each other past "at least one admin".
    await t.query(`SELECT 1 FROM memberships WHERE org_id=$1 AND role='admin' FOR UPDATE`, [actor.orgId]);
    const cur = [await getPrincipal(t, id, actor.orgId)];
    if (!cur[0]) throw new KanbanError("not_found", "principal not found");
    if (i.role && i.role !== cur[0].role) {
      if (cur[0].kind !== "human") throw new KanbanError("invalid", "only people have roles");
      if (i.role === "member") {
        const { rows } = await t.query(`SELECT 1 FROM memberships WHERE org_id=$1 AND role='admin' AND principal_id<>$2 LIMIT 1`, [actor.orgId, id]);
        if (!rows[0]) throw new KanbanError("invalid", "at least one admin is required");
      }
      await t.query(`UPDATE memberships SET role=$3 WHERE org_id=$1 AND principal_id=$2`, [actor.orgId, id, i.role]);
    }
    return (await getPrincipal(t, id, actor.orgId))!;
  });
}

// ---------- organizations ----------

/** Open sign-up must not let one account mint unlimited workspaces. */
const MAX_ORGS_PER_PERSON = 10;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

/** Create an organization; its creator becomes its admin. */
export async function createOrg(db: Db, creatorId: string, name: string): Promise<Org> {
  if (!name?.trim()) throw new KanbanError("invalid", "name is required");
  return db.tx(async (t) => {
    if (Number((await t.query(`SELECT count(*) AS n FROM memberships WHERE principal_id=$1`, [creatorId])).rows[0].n) >= MAX_ORGS_PER_PERSON)
      throw new KanbanError("invalid", `you can belong to at most ${MAX_ORGS_PER_PERSON} organizations`);
    const base = slugify(name);
    const taken = (await t.query(`SELECT 1 FROM organizations WHERE slug=$1`, [base])).rows[0];
    const { rows } = await t.query<Org>(
      `INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id, name, slug`,
      [name.trim(), taken ? `${base}-${randomBytes(3).toString("hex")}` : base],
    );
    await t.query(`INSERT INTO memberships (org_id, principal_id, role) VALUES ($1,$2,'admin')`, [rows[0].id, creatorId]);
    return rows[0];
  });
}

export async function findOrg(db: Db, idOrSlug: string): Promise<Org | null> {
  const { rows } = await db.query<Org>(`SELECT id, name, slug FROM organizations WHERE slug=$1 OR id::text=$1`, [idOrSlug]);
  return rows[0] ?? null;
}

/** Take a person out of the actor's organization (never the last admin). Their past work stays attributed to them. */
export async function removeMember(db: Db, actor: Principal, id: string) {
  requireAdmin(actor);
  await db.tx(async (t) => {
    await t.query(`SELECT 1 FROM memberships WHERE org_id=$1 AND role='admin' FOR UPDATE`, [actor.orgId]);
    const target = await getPrincipal(t, id, actor.orgId);
    if (!target) throw new KanbanError("not_found", "member not found");
    if (target.kind !== "human") throw new KanbanError("invalid", "only people can be removed here");
    const admins = (await t.query(`SELECT 1 FROM memberships WHERE org_id=$1 AND role='admin' AND principal_id<>$2 LIMIT 1`, [actor.orgId, id])).rows[0];
    if (!admins && target.role === "admin") throw new KanbanError("invalid", "at least one admin is required");
    await t.query(`DELETE FROM memberships WHERE org_id=$1 AND principal_id=$2`, [actor.orgId, id]);
    await t.query(`UPDATE tasks SET assignee_id=NULL, lease_expires_at=NULL WHERE assignee_id=$2 AND board_id IN (SELECT id FROM boards WHERE org_id=$1)`, [actor.orgId, id]);
  });
}

// ---------- invites ----------

const INVITE_DAYS = 7;

/** An invite is a link: the token is shown once, only its hash is stored. `email` (optional) pins who may accept it. */
export async function createInvite(db: Db, actor: Principal, i: { email?: string; role?: "admin" | "member" }) {
  requireAdmin(actor);
  const token = `inv_${randomBytes(24).toString("base64url")}`;
  const { rows } = await db.query(
    `INSERT INTO invites (org_id, email, role, token_hash, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))
     RETURNING id, email, role, expires_at AS "expiresAt"`,
    [actor.orgId, (i.email ?? "").trim().toLowerCase(), i.role ?? "member", hashKey(token), actor.id, INVITE_DAYS],
  );
  return { ...rows[0], token };
}

export async function listInvites(db: Db, actor: Principal) {
  requireAdmin(actor);
  const { rows } = await db.query(
    `SELECT id, email, role, expires_at AS "expiresAt" FROM invites
     WHERE org_id=$1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [actor.orgId],
  );
  return rows;
}

export async function revokeInvite(db: Db, actor: Principal, id: string) {
  requireAdmin(actor);
  await db.query(`DELETE FROM invites WHERE id=$1 AND org_id=$2`, [id, actor.orgId]);
}

/** Join the organization an invite belongs to. One-time: the invite is spent on success. */
export async function acceptInvite(db: Db, personId: string, token: string): Promise<Org> {
  return db.tx(async (t) => {
    const { rows } = await t.query<{ id: string; orgId: string; email: string; role: "admin" | "member" }>(
      `SELECT id, org_id AS "orgId", email, role FROM invites WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hashKey(token)],
    );
    const inv = rows[0];
    if (!inv) throw new KanbanError("not_found", "invite not found or expired");
    const who = (await t.query<{ kind: string; email: string | null }>(`SELECT kind, email FROM principals WHERE id=$1`, [personId])).rows[0];
    if (who?.kind !== "human") throw new KanbanError("forbidden", "only people can accept invites");
    if (inv.email && inv.email !== who.email?.toLowerCase()) throw new KanbanError("forbidden", "this invite was sent to a different email address");
    await t.query(
      `INSERT INTO memberships (org_id, principal_id, role) VALUES ($1,$2,$3) ON CONFLICT (org_id, principal_id) DO NOTHING`,
      [inv.orgId, personId, inv.role],
    );
    await t.query(`UPDATE invites SET accepted_at = now() WHERE id=$1`, [inv.id]);
    return (await t.query<Org>(`SELECT id, name, slug FROM organizations WHERE id=$1`, [inv.orgId])).rows[0];
  });
}

/** Organizations a person belongs to, oldest first. */
export async function listOrgs(db: Db, principalId: string): Promise<(Org & { role: "admin" | "member" })[]> {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.slug, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.principal_id=$1 ORDER BY m.created_at`,
    [principalId],
  );
  return rows;
}

const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");

export async function createApiKey(db: Db, actor: Principal, agentId: string, label = "") {
  requireAdmin(actor);
  const { rows } = await db.query(`SELECT 1 FROM principals WHERE id=$1 AND kind='agent' AND org_id=$2`, [agentId, actor.orgId]);
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
            last_used_at AS "lastUsedAt", revoked_at AS "revokedAt" FROM api_keys
     WHERE principal_id IN (SELECT id FROM principals WHERE org_id=$1) ORDER BY created_at DESC`,
    [actor.orgId],
  );
  return rows;
}

export async function revokeApiKey(db: Db, actor: Principal, id: string) {
  requireAdmin(actor);
  await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL
       AND principal_id IN (SELECT id FROM principals WHERE org_id=$2)`,
    [id, actor.orgId],
  );
}

export async function verifyApiKey(db: Db, key: string): Promise<Principal | null> {
  if (!key.startsWith("kb_")) return null;
  const { rows } = await db.query<Principal>(
    `UPDATE api_keys k SET last_used_at = now() FROM principals p
     WHERE k.hash=$1 AND k.revoked_at IS NULL AND p.id = k.principal_id
     RETURNING p.id, p.kind, p.name, 'member' AS role, p.org_id AS "orgId"`,
    [hashKey(key)],
  );
  return rows[0] ?? null;
}

function requireAdmin(a: Principal) {
  if (a.role !== "admin") throw new KanbanError("forbidden", "admin only");
}

// ---------- boards ----------

export interface Board { id: string; name: string }
const BOARD_COLS = `id, name`;

export async function listBoards(db: Db, actor: Principal) {
  const { rows } = await db.query(`SELECT ${BOARD_COLS} FROM boards WHERE org_id=$1 ORDER BY created_at`, [actor.orgId]);
  return rows as Board[];
}

export async function createBoard(db: Db, actor: Principal, name: string) {
  if (!name?.trim()) throw new KanbanError("invalid", "name is required");
  const { rows } = await db.query(`INSERT INTO boards (name, org_id) VALUES ($1,$2) RETURNING ${BOARD_COLS}`, [name.trim(), actor.orgId]);
  return rows[0] as Board;
}

export async function renameBoard(db: Db, actor: Principal, id: string, name: string) {
  if (!name?.trim()) throw new KanbanError("invalid", "name is required");
  const { rows } = await db.query(`UPDATE boards SET name=$2 WHERE id=$1 AND org_id=$3 RETURNING ${BOARD_COLS}`, [id, name.trim(), actor.orgId]);
  if (!rows[0]) throw new KanbanError("not_found", "project not found");
  return rows[0] as Board;
}

export async function ensureDefaultBoard(db: Db, orgId: string) {
  const first = await db.query(`SELECT ${BOARD_COLS} FROM boards WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]);
  if (first.rows[0]) return first.rows[0] as Board;
  const { rows } = await db.query(`INSERT INTO boards (name, org_id) VALUES ('Main',$1) RETURNING ${BOARD_COLS}`, [orgId]);
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

const notify = (orgId: string, boardId: string, taskId: string, type: string) => bus.emit("change", { orgId, boardId, taskId, type });

/** The one place a task is fetched by id: a task of another organization simply doesn't exist for the actor. */
async function load(db: Db, actor: Principal, id: string, lock = false): Promise<Task> {
  const { rows } = await db.query<Task>(
    `SELECT ${TASK_COLS} FROM tasks WHERE id=$1 AND board_id IN (SELECT id FROM boards WHERE org_id=$2)${lock ? " FOR UPDATE" : ""}`,
    [id, actor.orgId],
  );
  if (!rows[0]) throw new KanbanError("not_found", "task not found");
  return rows[0];
}

export interface CreateTaskInput {
  boardId?: string;
  title: string;
  description?: string;
  priority?: number;
  labels?: string[];
  /** Skip the proposal step: the task is created already confirmed. */
  confirmed?: boolean;
}

export async function createTask(db: Db, actor: Principal, i: CreateTaskInput): Promise<Task> {
  if (!i.title?.trim()) throw new KanbanError("invalid", "title is required");
  const task = await db.tx(async (t) => {
    const boardId = i.boardId ?? (await ensureDefaultBoard(t, actor.orgId)).id;
    if (!(await t.query(`SELECT 1 FROM boards WHERE id=$1 AND org_id=$2`, [boardId, actor.orgId])).rows[0]) throw new KanbanError("not_found", "project not found");
    const preConfirm = !!i.confirmed;
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
  notify(actor.orgId, task.boardId, task.id, "created");
  return task;
}

export async function getTask(db: Db, actor: Principal, id: string) {
  const task = await load(db, actor, id);
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

export async function listTasks(db: Db, actor: Principal, f: ListFilter = {}): Promise<Task[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (cond: string, v: unknown) => (params.push(v), where.push(cond.replace("?", `$${params.length}`)));
  add("board_id IN (SELECT id FROM boards WHERE org_id = ?)", actor.orgId);
  if (f.boardId) add("board_id = ?", f.boardId);
  if (f.status) {
    if (!STATUSES.includes(f.status)) throw new KanbanError("invalid", `unknown status ${f.status}`);
    add("status = ?", f.status);
  }
  if (f.assigneeId) add("assignee_id = ?", f.assigneeId);
  if (f.label) add("? = ANY(labels)", f.label);
  const { rows } = await db.query<Task>(
    `SELECT ${TASK_COLS} FROM tasks WHERE ${where.join(" AND ")}
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
    const cur = await load(t, actor, id, true);
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
  notify(actor.orgId, task.boardId, id, "updated");
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
    const cur = await load(t, actor, id, true);
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
  notify(actor.orgId, task.boardId, id, "moved");
  return task;
}

/** Agents call this while working on a long step so the claim does not look abandoned. */
export async function heartbeatTask(db: Db, actor: Principal, id: string): Promise<Task> {
  const cur = await load(db, actor, id);
  if (cur.status !== "in_progress" || cur.assigneeId !== actor.id)
    throw new KanbanError("invalid", "you do not hold this task");
  await touchLease(db, id, actor);
  return load(db, actor, id);
}

export async function requestInput(db: Db, actor: Principal, id: string, question: string, options: string[] = []): Promise<Task> {
  if (!question?.trim()) throw new KanbanError("invalid", "question is required");
  const opts = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
  if (opts.length > 6 || opts.some((o) => o.length > 80)) throw new KanbanError("invalid", "at most 6 options of up to 80 characters");
  const task = await db.tx(async (t) => {
    const cur = await load(t, actor, id, true);
    if (cur.status === "done") throw new KanbanError("invalid", "task is done");
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET needs_input=true, question=$2, question_by=$3, question_options=$4, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${TASK_COLS}`,
      [id, question.trim(), actor.id, opts],
    );
    await t.query(`INSERT INTO comments (task_id, author_id, body) VALUES ($1,$2,$3)`, [id, actor.id, `Question: ${question.trim()}`]);
    await touchLease(t, id, actor);
    await logEvent(t, id, actor, "input_requested", { question: question.trim(), ...(opts.length ? { options: opts } : {}) });
    return rows[0];
  });
  notify(actor.orgId, task.boardId, id, "input_requested");
  return task;
}

export async function answerInput(db: Db, actor: Principal, id: string, answer: string): Promise<Task> {
  if (!answer?.trim()) throw new KanbanError("invalid", "answer is required");
  const task = await db.tx(async (t) => {
    const cur = await load(t, actor, id, true);
    if (cur.questionBy === actor.id) throw new KanbanError("forbidden", "you cannot answer your own question");
    if (!cur.needsInput) throw new KanbanError("invalid", "no question is pending on this task");
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET needs_input=false, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${TASK_COLS}`,
      [id],
    );
    await t.query(`INSERT INTO comments (task_id, author_id, body) VALUES ($1,$2,$3)`, [id, actor.id, `Answer: ${answer.trim()}`]);
    await logEvent(t, id, actor, "input_answered");
    return rows[0];
  });
  notify(actor.orgId, task.boardId, id, "input_answered");
  return task;
}

export type InboxKind = "confirm" | "review" | "input" | "stale";
export interface InboxItem { kind: InboxKind; task: Task }

/** Everything currently waiting on this principal to make a decision. */
export async function inbox(db: Db, actor: Principal): Promise<InboxItem[]> {
  const { rows } = await db.query<Task>(
    `SELECT ${TASK_COLS} FROM tasks WHERE status <> 'done' AND (status IN ('proposed','review') OR needs_input OR lease_expires_at < now())
       AND board_id IN (SELECT id FROM boards WHERE org_id = $1)
     ORDER BY priority DESC, updated_at`,
    [actor.orgId],
  );
  const can = (t: Task, to: Status) => explainMoves(actor, taskCtx(t)).find((m) => m.to === to)!.ok;
  const out: InboxItem[] = [];
  for (const t of rows) {
    if (t.status === "proposed" && can(t, "confirmed")) out.push({ kind: "confirm", task: t });
    if (t.status === "review" && can(t, "done")) out.push({ kind: "review", task: t });
    if (t.needsInput && t.questionBy !== actor.id) out.push({ kind: "input", task: t });
    if (t.status === "in_progress" && taskCtx(t).leaseExpired) out.push({ kind: "stale", task: t });
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
    const cur = await load(t, actor, id, true);
    if (cur.status === "proposed" || cur.status === "done")
      throw new KanbanError("invalid", `cannot assign a ${cur.status} task`);
    if (assigneeId) {
      if (!(await getPrincipal(t, assigneeId, actor.orgId))) throw new KanbanError("not_found", "assignee not found");
    }
    const { rows } = await t.query<Task>(
      `UPDATE tasks SET assignee_id=$2, version=version+1, updated_at=now(),
         lease_expires_at = CASE WHEN status='in_progress' AND EXISTS (SELECT 1 FROM principals WHERE id=$2 AND kind='agent')
                                 THEN now() + make_interval(secs => $3) ELSE NULL END
       WHERE id=$1 RETURNING ${TASK_COLS}`,
      [id, assigneeId, leaseSeconds],
    );
    await logEvent(t, id, actor, "assigned", { assigneeId });
    return rows[0];
  });
  notify(actor.orgId, task.boardId, id, "assigned");
  return task;
}

export async function addComment(db: Db, actor: Principal, taskId: string, body: string) {
  if (!body?.trim()) throw new KanbanError("invalid", "comment body is required");
  const out = await db.tx(async (t) => {
    const task = await load(t, actor, taskId);
    const { rows } = await t.query(
      `INSERT INTO comments (task_id, author_id, body) VALUES ($1,$2,$3)
       RETURNING id, body, created_at AS "createdAt"`,
      [taskId, actor.id, body.trim()],
    );
    await touchLease(t, taskId, actor);
    await logEvent(t, taskId, actor, "commented");
    return { comment: rows[0], boardId: task.boardId };
  });
  notify(actor.orgId, out.boardId, taskId, "commented");
  return out.comment;
}

/** A principal in the context of one organization (default: a person's oldest one). Null if they don't belong there. */
export async function getPrincipal(db: Db, id: string, orgId?: string): Promise<Principal | null> {
  const { rows } = await db.query<Principal>(
    `SELECT p.id, p.kind, p.name, COALESCE(m.role, 'member') AS role, COALESCE(m.org_id, p.org_id) AS "orgId"
     FROM principals p
     LEFT JOIN LATERAL (SELECT org_id, role FROM memberships WHERE principal_id = p.id AND ($2::uuid IS NULL OR org_id = $2) ORDER BY created_at LIMIT 1) m ON true
     WHERE p.id = $1 AND COALESCE(m.org_id, p.org_id) IS NOT NULL AND ($2::uuid IS NULL OR COALESCE(m.org_id, p.org_id) = $2)`,
    [id, orgId ?? null],
  );
  return rows[0] ?? null;
}

// ---------- supervision views ----------

export interface ActivityItem {
  id: number; type: string; payload: Record<string, unknown>; createdAt: string;
  taskId: string; taskTitle: string; boardId: string;
  actorId: string; actorName: string; actorKind: "human" | "agent";
}

/** Newest-first change feed across tasks, optionally for one project. */
export async function listActivity(db: Db, actor: Principal, f: { boardId?: string; limit?: number } = {}): Promise<ActivityItem[]> {
  const params: unknown[] = [Math.min(Math.max(f.limit ?? 30, 1), 200), actor.orgId];
  let where = "WHERE t.board_id IN (SELECT id FROM boards WHERE org_id = $2)";
  if (f.boardId) (params.push(f.boardId), (where += " AND t.board_id = $3"));
  const { rows } = await db.query<ActivityItem>(
    `SELECT e.id, e.type, e.payload, e.created_at AS "createdAt", e.task_id AS "taskId", t.title AS "taskTitle",
            t.board_id AS "boardId", p.id AS "actorId", p.name AS "actorName", p.kind AS "actorKind"
     FROM events e JOIN tasks t ON t.id = e.task_id JOIN principals p ON p.id = e.actor_id
     ${where} ORDER BY e.id DESC LIMIT $1`,
    params,
  );
  return rows;
}

export type AgentState = "working" | "blocked" | "stale" | "idle";
export interface AgentRow {
  id: string; name: string; state: AgentState;
  lastActiveAt: string | null;
  /** Events per 5-minute bucket over the last hour, oldest first (12 values). */
  activity: number[];
  tasks: { id: string; title: string; status: Status; needsInput: boolean; question: string | null; leaseExpiresAt: string | null }[];
}
export interface Overview {
  agents: AgentRow[];
  kpis: { agentsActive: number; agentsTotal: number; waitingOnHuman: number; staleLeases: number; doneToday: number };
  pipeline: Record<Status, number>;
}

/** One-call summary for the "Agents" supervision screen. */
export async function overview(db: Db, actor: Principal, boardId?: string): Promise<Overview> {
  const tasks = await listTasks(db, actor, { boardId });
  const [agents, last, buckets, done] = await Promise.all([
    db.query<{ id: string; name: string }>(
      `SELECT id, name FROM principals WHERE kind='agent' AND org_id=$1 ORDER BY name`, [actor.orgId]),
    db.query<{ actor: string; at: string }>(`SELECT actor_id AS actor, max(created_at) AS at FROM events GROUP BY actor_id`),
    db.query<{ actor: string; b: number; n: number }>(
      `SELECT actor_id AS actor, floor(extract(epoch FROM (now() - created_at)) / 300)::int AS b, count(*)::int AS n
       FROM events WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2`),
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.payload->>'to' = 'done' AND e.created_at >= date_trunc('day', now())
         AND t.board_id IN (SELECT id FROM boards WHERE org_id = $1) ${boardId ? "AND t.board_id = $2" : ""}`,
      boardId ? [actor.orgId, boardId] : [actor.orgId]),
  ]);
  const lastBy = new Map(last.rows.map((r) => [r.actor, r.at]));
  const rows: AgentRow[] = agents.rows.map((a) => {
    const mine = tasks.filter((t) => t.assigneeId === a.id && t.status === "in_progress");
    const stale = mine.some((t) => taskCtx(t).leaseExpired);
    const state: AgentState = stale ? "stale" : mine.some((t) => t.needsInput) ? "blocked" : mine.length ? "working" : "idle";
    const activity = Array<number>(12).fill(0);
    for (const b of buckets.rows) if (b.actor === a.id && b.b >= 0 && b.b < 12) activity[11 - b.b] = b.n;
    return {
      ...a, state, lastActiveAt: lastBy.get(a.id) ?? null, activity,
      tasks: mine.map((t) => ({ id: t.id, title: t.title, status: t.status, needsInput: t.needsInput, question: t.question, leaseExpiresAt: t.leaseExpiresAt })),
    };
  });
  const pipeline = Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length])) as Record<Status, number>;
  return {
    agents: rows,
    kpis: {
      agentsActive: rows.filter((r) => r.state === "working" || r.state === "blocked").length,
      agentsTotal: rows.length,
      waitingOnHuman: tasks.filter((t) => t.status === "proposed" || t.status === "review" || t.needsInput).length,
      staleLeases: tasks.filter((t) => t.status === "in_progress" && taskCtx(t).leaseExpired).length,
      doneToday: done.rows[0]?.n ?? 0,
    },
    pipeline,
  };
}
