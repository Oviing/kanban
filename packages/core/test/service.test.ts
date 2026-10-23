import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  addComment, setHumanInLoop, answerInput, heartbeatTask, inbox, requestInput, createBoard, listBoards, listTasks, renameBoard, claimTask, confirmTask, createAgent, createApiKey, createTask, getTask, KanbanError,
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
  agentB = await createAgent(db, admin, { name: "reviewer", canConfirm: true });
});

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as KanbanError).code);

describe("workflow", () => {
  it("agent tasks start proposed; humans may pre-confirm", async () => {
    expect((await createTask(db, agentA, { title: "t" })).status).toBe("proposed");
    expect((await createTask(db, human, { title: "t", confirmed: true })).status).toBe("confirmed");
    expect((await createTask(db, agentA, { title: "t", confirmed: true })).status).toBe("proposed");
  });

  it("confirmation rules", async () => {
    const t = await createTask(db, agentB, { title: "t" });
    expect(await code(confirmTask(db, agentB, t.id))).toBe("forbidden"); // own task
    expect(await code(confirmTask(db, agentA, t.id))).toBe("forbidden"); // no can_confirm
    expect((await confirmTask(db, human, t.id)).confirmedBy).toBe(human.id);
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
    const full = await getTask(db, t.id);
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
    const full = await getTask(db, t.id);
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
    expect((await listTasks(db, { boardId: a.id })).map((t) => t.title)).toEqual(["in a"]);
    expect(await code(createBoard(db, agentA, "Nope"))).toBe("forbidden");
    expect((await renameBoard(db, human, a.id, "Alpha 2")).name).toBe("Alpha 2");
    expect((await listBoards(db)).map((x) => x.name)).toEqual(expect.arrayContaining(["Alpha 2", "Beta"]));
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
    expect((await getTask(db, t.id)).events.map((e: any) => e.type)).toContain("taken_over");
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
    // the assignee agent, lacking approval rights, sees nothing; a confirming agent sees review but not its own work
    expect(await inbox(db, agentA)).toHaveLength(0);
    expect((await inbox(db, agentB)).map((i) => i.kind)).toContain("review");

    expect(await code(answerInput(db, agentA, t.id, "x"))).toBe("forbidden");
    await answerInput(db, human, t.id, "postgres");
    expect((await inbox(db, human)).map((i) => i.kind)).not.toContain("input");
    expect((await getTask(db, t.id)).comments.map((c: any) => c.body)).toEqual(["Question: which db?", "Answer: postgres"]);
    expect(await code(answerInput(db, human, t.id, "again"))).toBe("invalid");
  });
});

describe("autonomous projects (human-in-the-loop off)", () => {
  it("only admins can switch it; default is on", async () => {
    const b = await createBoard(db, human, "Auto");
    expect(b.humanInLoop).toBe(true);
    expect(await code(setHumanInLoop(db, human, b.id, false))).toBe("forbidden");
    expect(await code(createBoard(db, human, "Auto2", false))).toBe("forbidden");
    expect((await setHumanInLoop(db, admin, b.id, false)).humanInLoop).toBe(false);
  });

  it("agents confirm, work and approve each other without humans", async () => {
    const b = await createBoard(db, admin, "Auto", false);
    // before: gated
    const gated = await createBoard(db, human, "Gated");
    const g = await createTask(db, agentA, { title: "g", boardId: gated.id });
    expect(await code(confirmTask(db, agentA, g.id))).toBe("forbidden");

    const worker = await createAgent(db, admin, { name: "plain" }); // no can_confirm
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
    expect((await moveTask(db, agentA, t.id, "done")).status).toBe("done"); // another agent, no can_confirm

    // switching back restores the gate
    await setHumanInLoop(db, admin, b.id, true);
    const q = await createTask(db, agentA, { title: "q", boardId: b.id });
    expect(await code(confirmTask(db, agentA, q.id))).toBe("forbidden");
  });
});
