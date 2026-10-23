import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  addComment, claimTask, confirmTask, createAgent, createApiKey, createTask, getTask, KanbanError,
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
    expect(await code(claimTask(db, agentB, t.id))).toBe("invalid"); // already in_progress
    await moveTask(db, agentA, t.id, "review");
    expect(await code(moveTask(db, agentA, t.id, "done"))).toBe("forbidden");
    expect((await moveTask(db, agentB, t.id, "done")).status).toBe("done");
    expect(await code(moveTask(db, human, t.id, "proposed"))).toBe("invalid");
    const full = await getTask(db, t.id);
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
