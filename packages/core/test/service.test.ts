import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  addComment, listActivity, overview, answerInput, assignTask, heartbeatTask, inbox, requestInput, createBoard, listBoards, listTasks, renameBoard, claimTask, confirmTask, createAgent, createApiKey, updatePrincipal, createOrg, getPrincipal, listOrgs, listPrincipals, listApiKeys, createInvite, acceptInvite, listInvites, removeMember, createTask, getTask, updateTask, KanbanError,
  migrate, moveTask, pgliteDb, revokeApiKey, upsertOidcPrincipal, verifyApiKey, type Db, type Principal,
} from "../src/index.js";

let db: Db;
let admin: Principal, human: Principal, agentA: Principal, agentB: Principal;

beforeEach(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db);
  admin = await upsertOidcPrincipal(db, { issuer: "i", sub: "a", kind: "human", name: "Ada", email: "ada@x.io" }, ["ada@x.io"]);
  human = await upsertOidcPrincipal(db, { issuer: "i", sub: "h", kind: "human", name: "Hal" });
  agentA = await createAgent(db, admin, { name: "coder" });
  agentB = await createAgent(db, admin, { name: "reviewer" });
});

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as KanbanError).code);

describe("workflow", () => {
  it("tasks start proposed unless created pre-confirmed (agents and humans alike)", async () => {
    expect((await createTask(db, agentA, { title: "t" })).status).toBe("proposed");
    expect((await createTask(db, human, { title: "t", confirmed: true })).status).toBe("confirmed");
    expect((await createTask(db, agentA, { title: "t", confirmed: true })).status).toBe("confirmed");
  });

  it("confirmation rules", async () => {
    const t = await createTask(db, agentB, { title: "t" });
    expect((await confirmTask(db, agentA, t.id)).confirmedBy).toBe(agentA.id); // any agent may confirm
    const u = await createTask(db, agentB, { title: "u" });
    expect((await confirmTask(db, human, u.id)).confirmedBy).toBe(human.id);
  });

  it("full lifecycle with separation of duties", async () => {
    const t = await createTask(db, human, { title: "t", confirmed: true });
    expect((await claimTask(db, agentA, t.id)).assigneeId).toBe(agentA.id);
    expect(await code(claimTask(db, agentB, t.id))).toBe("forbidden"); // held, lease live
    expect(await code(moveTask(db, agentA, t.id, "review"))).toBe("invalid"); // summary required
    await moveTask(db, agentA, t.id, "review", { summary: "implemented", links: ["https://x/pr/1"] });
    expect(await code(moveTask(db, agentA, t.id, "done"))).toBe("forbidden");
    expect((await moveTask(db, agentB, t.id, "done")).status).toBe("done");
    expect(await code(moveTask(db, human, t.id, "proposed"))).toBe("invalid");
    const full = await getTask(db, admin, t.id);
    expect(full).toMatchObject({ reviewSummary: "implemented", reviewLinks: ["https://x/pr/1"] });
    expect(full.events.map((e: any) => e.type)).toEqual(["created", "claimed", "moved", "moved"]);
  });

  it("concurrent claims: exactly one wins", async () => {
    const t = await createTask(db, human, { title: "t", confirmed: true });
    const res = await Promise.all([claimTask(db, agentA, t.id), claimTask(db, agentB, t.id)].map(code));
    expect(res.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("comments are attributed", async () => {
    const t = await createTask(db, agentA, { title: "t" });
    await addComment(db, agentA, t.id, "hello");
    const full = await getTask(db, admin, t.id);
    expect(full.comments[0]).toMatchObject({ body: "hello", authorKind: "agent" });
  });
});

describe("api keys", () => {
  it("verify, then reject after revoke; plaintext never stored", async () => {
    const k = await createApiKey(db, admin, agentA.id, "ci");
    expect((await verifyApiKey(db, k.key))?.id).toBe(agentA.id);
    const { rows } = await db.query(`SELECT hash FROM api_keys`);
    expect(JSON.stringify(rows)).not.toContain(k.key);
    await revokeApiKey(db, admin, k.id);
    expect(await verifyApiKey(db, k.key)).toBeNull();
    expect(await verifyApiKey(db, "kb_bogus")).toBeNull();
  });
  it("only admins manage keys", async () => {
    expect(await code(createApiKey(db, human, agentA.id))).toBe("forbidden");
  });
});

describe("projects", () => {
  it("tasks are scoped to their project; only humans manage projects", async () => {
    const a = await createBoard(db, human, "Alpha");
    const b = await createBoard(db, human, "Beta");
    await createTask(db, agentA, { title: "in a", boardId: a.id });
    await createTask(db, agentA, { title: "in b", boardId: b.id });
    expect((await listTasks(db, admin, { boardId: a.id })).map((t) => t.title)).toEqual(["in a"]);
    expect((await createBoard(db, agentA, "By agent")).name).toBe("By agent");
    expect((await renameBoard(db, human, a.id, "Alpha 2")).name).toBe("Alpha 2");
    expect((await listBoards(db, admin)).map((x) => x.name)).toEqual(expect.arrayContaining(["Alpha 2", "Beta"]));
    expect(await code(createTask(db, agentA, { title: "x", boardId: "00000000-0000-0000-0000-000000000000" }))).toBe("not_found");
  });
});

describe("leases", () => {
  const expire = (id: string) => db.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id=$1`, [id]);

  it("agent claims get a lease; human claims do not; activity renews it", async () => {
    const t = await createTask(db, human, { title: "t", confirmed: true });
    const claimed = await claimTask(db, agentA, t.id);
    expect(new Date(claimed.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    await expire(t.id);
    await addComment(db, agentA, t.id, "still here");
    expect(new Date((await heartbeatTask(db, agentA, t.id)).leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    const h = await createTask(db, human, { title: "h", confirmed: true });
    expect((await claimTask(db, human, h.id)).leaseExpiresAt).toBeNull();
  });

  it("another agent can take over only after the lease expires", async () => {
    const t = await createTask(db, human, { title: "t", confirmed: true });
    await claimTask(db, agentA, t.id);
    expect(await code(claimTask(db, agentB, t.id))).toBe("forbidden");
    expect(await code(claimTask(db, agentA, t.id))).toBe("forbidden"); // already yours
    await expire(t.id);
    expect((await inbox(db, human)).map((i) => i.kind)).toContain("stale");
    const taken = await claimTask(db, agentB, t.id);
    expect(taken.assigneeId).toBe(agentB.id);
    expect(taken.leaseExpiresAt).not.toBeNull();
    expect((await getTask(db, admin, t.id)).events.map((e: any) => e.type)).toContain("taken_over");
  });
});

describe("inbox & questions", () => {
  it("surfaces confirmations, reviews and questions to the right people", async () => {
    const proposed = await createTask(db, agentA, { title: "p" });
    const t = await createTask(db, human, { title: "w", confirmed: true });
    await claimTask(db, agentA, t.id);
    await requestInput(db, agentA, t.id, "which db?");
    await moveTask(db, agentA, t.id, "review", { summary: "s" });

    const forHuman = (await inbox(db, human)).map((i) => `${i.kind}:${i.task.id}`);
    expect(forHuman).toEqual(expect.arrayContaining([`confirm:${proposed.id}`, `review:${t.id}`, `input:${t.id}`]));
    // the assignee agent sees nothing of its own work; another agent sees the review
    expect((await inbox(db, agentA)).map((i) => i.kind)).not.toContain("review");
    expect((await inbox(db, agentB)).map((i) => i.kind)).toContain("review");

    expect(await code(answerInput(db, agentA, t.id, "x"))).toBe("forbidden"); // not its own question
    await answerInput(db, human, t.id, "postgres");
    expect((await inbox(db, human)).map((i) => i.kind)).not.toContain("input");
    expect((await getTask(db, admin, t.id)).comments.map((c: any) => c.body)).toEqual(["Question: which db?", "Answer: postgres"]);
    expect(await code(answerInput(db, human, t.id, "again"))).toBe("invalid");
  });
});

describe("questions and reassignment", () => {
  it("the requester cannot answer, even when not the assignee", async () => {
    const t = await createTask(db, human, { title: "q", confirmed: true });
    await claimTask(db, agentA, t.id);
    await requestInput(db, agentB, t.id, "who?");
    expect(await code(answerInput(db, agentB, t.id, "me"))).toBe("forbidden");
    expect((await inbox(db, agentB)).map((i) => i.kind)).not.toContain("input");
    expect((await answerInput(db, agentA, t.id, "ok")).needsInput).toBe(false);
  });

  it("questions can carry suggested answers, which are cleaned and replaced by the next question", async () => {
    const t = await createTask(db, human, { title: "opts", confirmed: true });
    await claimTask(db, agentA, t.id);
    const asked = await requestInput(db, agentA, t.id, "mock or retry?", [" mock ", "retry", "retry", ""]);
    expect(asked.questionOptions).toEqual(["mock", "retry"]);
    expect((await listActivity(db, admin, {})).find((e) => e.type === "input_requested")?.payload).toMatchObject({ options: ["mock", "retry"] });
    expect(await code(requestInput(db, agentA, t.id, "q", Array.from({ length: 7 }, (_, i) => `o${i}`)))).toBe("invalid");
    expect(await code(requestInput(db, agentA, t.id, "q", ["x".repeat(81)]))).toBe("invalid");
    expect((await requestInput(db, agentA, t.id, "plain?")).questionOptions).toEqual([]);
  });

  it("reassigning an in-progress task refreshes or clears the lease", async () => {
    const t = await createTask(db, human, { title: "r", confirmed: true });
    await claimTask(db, agentA, t.id);
    expect((await assignTask(db, agentB, t.id, human.id)).leaseExpiresAt).toBeNull();
    expect((await assignTask(db, agentB, t.id, agentB.id)).leaseExpiresAt).not.toBeNull();
  });
});

describe("agents working without humans", () => {
  it("agents confirm, work and approve each other without humans", async () => {
    const b = await createBoard(db, admin, "Auto");

    const worker = await createAgent(db, admin, { name: "plain" });
    const t = await createTask(db, worker, { title: "auto", boardId: b.id, confirmed: true });
    expect(t.status).toBe("confirmed"); // agent may skip proposal here
    const p = await createTask(db, worker, { title: "own", boardId: b.id });
    expect((await confirmTask(db, worker, p.id)).status).toBe("confirmed"); // even its own

    await claimTask(db, worker, t.id);
    await requestInput(db, worker, t.id, "q?");
    expect(await code(answerInput(db, worker, t.id, "me"))).toBe("forbidden"); // not its own question
    await answerInput(db, agentA, t.id, "go");
    await moveTask(db, worker, t.id, "review", { summary: "ok" });
    expect(await code(moveTask(db, worker, t.id, "done"))).toBe("forbidden"); // still no self-approval
    expect((await moveTask(db, agentA, t.id, "done")).status).toBe("done"); // another agent
  });
});

describe("supervision views", () => {
  it("overview reports agent states, kpis and pipeline; activity is newest first", async () => {
    const mk = async (title: string) => createTask(db, human, { title, confirmed: true });
    const live = await mk("live"), asking = await mk("asking"), old = await mk("old"), done = await mk("done");
    await claimTask(db, agentA, live.id);
    const worker2 = await createAgent(db, admin, { name: "w2" });
    const worker3 = await createAgent(db, admin, { name: "w3" });
    await claimTask(db, worker2, asking.id); await requestInput(db, worker2, asking.id, "q?");
    await claimTask(db, worker3, old.id);
    await db.query(`UPDATE tasks SET lease_expires_at = now() - interval '2 minutes' WHERE id=$1`, [old.id]);
    await claimTask(db, agentB, done.id); await moveTask(db, agentB, done.id, "review", { summary: "s" }); await moveTask(db, human, done.id, "done");

    const o = await overview(db, admin);
    const st = Object.fromEntries(o.agents.map((a) => [a.name, a.state]));
    expect(st).toMatchObject({ coder: "working", w2: "blocked", w3: "stale", reviewer: "idle" });
    expect(o.kpis).toMatchObject({ agentsActive: 2, agentsTotal: 4, staleLeases: 1, doneToday: 1, waitingOnHuman: 1 });
    expect(o.pipeline).toMatchObject({ in_progress: 3, done: 1 });
    expect(o.agents.find((a) => a.name === "coder")!.activity.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const feed = await listActivity(db, admin, { limit: 5 });
    expect(feed).toHaveLength(5);
    expect(feed[0].id).toBeGreaterThan(feed[1].id);
    expect(feed[0]).toMatchObject({ actorName: "Hal", type: "moved" });
  });
});

describe("user management", () => {
  it("promotes and demotes people, never agents, never the last admin", async () => {
    expect((await updatePrincipal(db, admin, human.id, { role: "admin" })).role).toBe("admin");
    expect((await updatePrincipal(db, admin, human.id, { role: "member" })).role).toBe("member");
    expect(await code(updatePrincipal(db, admin, agentA.id, { role: "admin" }))).toBe("invalid");
    expect(await code(updatePrincipal(db, admin, admin.id, { role: "member" }))).toBe("invalid");
    expect(await code(updatePrincipal(db, human, human.id, { role: "admin" }))).toBe("forbidden");
  });
});

describe("tenant isolation", () => {
  let owner: Principal, bAgent: Principal, bBoard: { id: string }, bTask: { id: string }, orgB: { id: string };
  beforeEach(async () => {
    const u = await upsertOidcPrincipal(db, { issuer: "i", sub: "bob", kind: "human", name: "Bob" }, [], null);
    orgB = await createOrg(db, u.id, "Beta Corp");
    owner = (await getPrincipal(db, u.id, orgB.id))!;
    bAgent = await createAgent(db, owner, { name: "b-coder" });
    bBoard = await createBoard(db, owner, "B board");
    bTask = await createTask(db, bAgent, { title: "secret", boardId: bBoard.id, confirmed: true });
  });

  it("memberships carry per-org roles; agents belong to exactly one org", async () => {
    expect(owner).toMatchObject({ role: "admin", orgId: orgB.id });
    expect((await getPrincipal(db, admin.id))!.orgId).not.toBe(orgB.id); // Ada still lives in the default org
    expect(await getPrincipal(db, admin.id, orgB.id)).toBeNull(); // and is no member of B
    expect(bAgent.orgId).toBe(orgB.id);
    expect((await listOrgs(db, owner.id)).map((o) => o.id)).toEqual([orgB.id]);
  });

  it("reads never leak across orgs", async () => {
    expect(await listTasks(db, admin)).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: bTask.id })]));
    expect((await listTasks(db, admin, { boardId: bBoard.id }))).toEqual([]);
    expect((await listBoards(db, admin)).map((b) => b.id)).not.toContain(bBoard.id);
    expect((await listBoards(db, owner)).map((b) => b.id)).toEqual([bBoard.id]);
    expect((await listPrincipals(db, admin)).map((p) => p.id)).not.toEqual(expect.arrayContaining([bAgent.id, owner.id]));
    expect((await listPrincipals(db, owner)).map((p) => p.id).sort()).toEqual([bAgent.id, owner.id].sort());
    expect((await inbox(db, admin)).map((i) => i.task.id)).not.toContain(bTask.id);
    expect((await listActivity(db, admin, {})).map((e) => e.taskId)).not.toContain(bTask.id);
    expect((await overview(db, admin)).agents.map((a) => a.id)).not.toContain(bAgent.id);
    expect((await listApiKeys(db, admin)).length).toBe(0);
  });

  it("every id-based call on another org's task is not_found", async () => {
    const id = bTask.id;
    const calls = [
      () => getTask(db, admin, id), () => updateTask(db, admin, id, { title: "x" }), () => moveTask(db, admin, id, "in_progress"),
      () => claimTask(db, agentA, id), () => heartbeatTask(db, agentA, id), () => requestInput(db, admin, id, "q?"),
      () => answerInput(db, admin, id, "a"), () => assignTask(db, admin, id, null), () => addComment(db, admin, id, "hi"),
    ];
    for (const c of calls) expect(await code(c())).toBe("not_found");
    expect((await getTask(db, owner, id)).title).toBe("secret"); // untouched
  });

  it("writes can't target another org's board, assignee, agent, key or role", async () => {
    expect(await code(createTask(db, admin, { title: "x", boardId: bBoard.id }))).toBe("not_found");
    expect(await code(renameBoard(db, admin, bBoard.id, "hijack"))).toBe("not_found");
    const mine = await createTask(db, admin, { title: "mine", confirmed: true });
    expect(await code(assignTask(db, admin, mine.id, bAgent.id))).toBe("not_found");
    expect(await code(createApiKey(db, admin, bAgent.id))).toBe("not_found");
    const k = await createApiKey(db, owner, bAgent.id);
    await revokeApiKey(db, admin, k.id); // silently a no-op across orgs
    expect((await verifyApiKey(db, k.key))?.orgId).toBe(orgB.id);
    expect(await code(updatePrincipal(db, admin, owner.id, { role: "member" }))).toBe("not_found");
  });
});

describe("invites and members", () => {
  it("an invite link adds a person to the org once, optionally only for one email", async () => {
    const eve = await upsertOidcPrincipal(db, { issuer: "i", sub: "eve", kind: "human", name: "Eve", email: "eve@x.io" }, [], null);
    const mallory = await upsertOidcPrincipal(db, { issuer: "i", sub: "mal", kind: "human", name: "Mal", email: "mal@x.io" }, [], null);
    const inv = await createInvite(db, admin, { email: "Eve@x.io", role: "member" });
    expect(await code(createInvite(db, human, {}))).toBe("forbidden");
    expect((await listInvites(db, admin)).map((i) => i.id)).toEqual([inv.id]);
    expect(await code(acceptInvite(db, mallory.id, inv.token))).toBe("forbidden"); // wrong email
    expect(await code(acceptInvite(db, eve.id, "inv_bogus"))).toBe("not_found");
    const org = await acceptInvite(db, eve.id, inv.token);
    expect((await getPrincipal(db, eve.id, org.id))).toMatchObject({ role: "member", orgId: admin.orgId });
    expect(await code(acceptInvite(db, eve.id, inv.token))).toBe("not_found"); // spent
    expect(await listInvites(db, admin)).toEqual([]);
    await db.query(`UPDATE invites SET accepted_at=NULL, expires_at=now()-interval '1 minute'`);
    expect(await code(acceptInvite(db, mallory.id, inv.token))).toBe("not_found"); // expired
  });

  it("removing a member unassigns their tasks and never the last admin", async () => {
    const t = await createTask(db, human, { title: "mine", confirmed: true });
    await assignTask(db, human, t.id, human.id);
    await removeMember(db, admin, human.id);
    expect(await getPrincipal(db, human.id, admin.orgId)).toBeNull();
    expect((await getTask(db, admin, t.id)).assigneeId).toBeNull();
    expect(await code(removeMember(db, admin, admin.id))).toBe("invalid");
    expect(await code(removeMember(db, admin, agentA.id))).toBe("invalid");
    expect(await code(removeMember(db, admin, human.id))).toBe("not_found");
  });
});

describe("open sign-up limits", () => {
  it("a person can't mint unlimited organizations", async () => {
    const u = await upsertOidcPrincipal(db, { issuer: "i", sub: "spam", kind: "human", name: "Spam" }, [], null);
    for (let i = 0; i < 10; i++) await createOrg(db, u.id, `Org ${i}`);
    expect(await code(createOrg(db, u.id, "One too many"))).toBe("invalid");
  });
});
