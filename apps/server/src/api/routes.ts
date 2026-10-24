import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  STATUSES, KanbanError, addComment, answerInput, assignTask, explainMoves, heartbeatTask, inbox, listActivity, overview, requestInput, taskCtx, bus, createAgent, createApiKey, createBoard, renameBoard, createTask, getTask,
  listApiKeys, listBoards, listPrincipals, listTasks, moveTask, revokeApiKey, updatePrincipal, updateTask,
  type Db, type Principal, type Task,
} from "@kanban/core";

export type Env = { Variables: { principal: Principal; via: "session" | "bearer" } };

const status = z.enum(STATUSES);
const createBody = z.object({
  title: z.string().min(1), description: z.string().optional(), priority: z.number().int().min(0).max(4).optional(),
  labels: z.array(z.string()).optional(), boardId: z.string().uuid().optional(), confirmed: z.boolean().optional(),
});
const patchBody = createBody.omit({ confirmed: true, boardId: true }).partial().extend({ expectedVersion: z.number().int().optional() });

export function apiRoutes(db: Db, opts: { authMode: "oidc" | "none"; leaseMinutes: number } = { authMode: "oidc", leaseMinutes: 30 }) {
  const api = new Hono<Env>();
  const me = (c: any) => c.get("principal") as Principal;
  /** Attach what this caller may do next, so the UI can show only valid drop targets. */
  const withMoves = <T extends Task>(p: Principal, t: T) => ({
    ...t,
    moves: Object.fromEntries(explainMoves(p, taskCtx(t)).map((m) => [m.to, { ok: m.ok, reason: m.reason }])),
  });

  api.onError((e, c) => {
    if (e instanceof KanbanError) {
      const s = { not_found: 404, forbidden: 403, invalid: 400, conflict: 409 }[e.code] as 404;
      return c.json({ error: e.code, message: e.message }, s);
    }
    if (e instanceof z.ZodError) return c.json({ error: "invalid", message: e.message }, 400);
    console.error(e);
    return c.json({ error: "internal" }, 500);
  });

  api.get("/me", (c) => c.json({ ...me(c), authMode: opts.authMode, leaseMinutes: opts.leaseMinutes }));
  api.get("/overview", async (c) => c.json(await overview(db, c.req.query("boardId"))));
  api.get("/activity", async (c) => c.json(await listActivity(db, { boardId: c.req.query("boardId"), limit: Number(c.req.query("limit") ?? 30) || 30 })));
  api.get("/boards", async (c) => c.json(await listBoards(db)));
  api.post("/boards", async (c) => {
    const b = z.object({ name: z.string().min(1) }).parse(await c.req.json());
    return c.json(await createBoard(db, me(c), b.name), 201);
  });

  api.patch("/boards/:id", async (c) => {
    const b = z.object({ name: z.string().min(1) }).parse(await c.req.json());
    const id = c.req.param("id");
    return c.json(await renameBoard(db, me(c), id, b.name));
  });

  api.get("/tasks", async (c) => {
    const q = c.req.query();
    const tasks = await listTasks(db, { boardId: q.boardId, status: q.status ? status.parse(q.status) : undefined, assigneeId: q.assigneeId, label: q.label });
    return c.json(tasks.map((t) => withMoves(me(c), t)));
  });
  api.post("/tasks", async (c) => c.json(await createTask(db, me(c), createBody.parse(await c.req.json())), 201));
  api.get("/tasks/:id", async (c) => c.json(withMoves(me(c), await getTask(db, c.req.param("id")))));
  api.get("/inbox", async (c) => c.json((await inbox(db, me(c))).map((i) => ({ kind: i.kind, task: withMoves(me(c), i.task) }))));
  api.patch("/tasks/:id", async (c) => c.json(await updateTask(db, me(c), c.req.param("id"), patchBody.parse(await c.req.json()))));
  api.post("/tasks/:id/move", async (c) => {
    const b = z.object({ to: status, summary: z.string().optional(), links: z.array(z.string()).optional() }).parse(await c.req.json());
    return c.json(await moveTask(db, me(c), c.req.param("id"), b.to, { summary: b.summary, links: b.links }));
  });
  api.post("/tasks/:id/heartbeat", async (c) => c.json(await heartbeatTask(db, me(c), c.req.param("id"))));
  api.post("/tasks/:id/input", async (c) =>
    c.json(await requestInput(db, me(c), c.req.param("id"), z.object({ question: z.string().min(1) }).parse(await c.req.json()).question)));
  api.post("/tasks/:id/answer", async (c) =>
    c.json(await answerInput(db, me(c), c.req.param("id"), z.object({ answer: z.string().min(1) }).parse(await c.req.json()).answer)));
  api.post("/tasks/:id/assign", async (c) =>
    c.json(await assignTask(db, me(c), c.req.param("id"), z.string().uuid().nullable().parse((await c.req.json()).assigneeId))));
  api.post("/tasks/:id/comments", async (c) =>
    c.json(await addComment(db, me(c), c.req.param("id"), z.object({ body: z.string().min(1) }).parse(await c.req.json()).body), 201));

  api.get("/principals", async (c) => c.json(await listPrincipals(db)));
  api.post("/agents", async (c) =>
    c.json(await createAgent(db, me(c), z.object({ name: z.string().min(1) }).parse(await c.req.json())), 201));
  api.patch("/principals/:id", async (c) =>
    c.json(await updatePrincipal(db, me(c), c.req.param("id"), z.object({ role: z.enum(["admin", "member"]).optional() }).parse(await c.req.json()))));

  api.get("/api-keys", async (c) => c.json(await listApiKeys(db, me(c))));
  api.post("/api-keys", async (c) => {
    const b = z.object({ agentId: z.string().uuid(), label: z.string().optional() }).parse(await c.req.json());
    return c.json(await createApiKey(db, me(c), b.agentId, b.label), 201);
  });
  api.delete("/api-keys/:id", async (c) => {
    await revokeApiKey(db, me(c), c.req.param("id"));
    return c.body(null, 204);
  });

  // Live updates: the UI refetches on every change event.
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const on = (e: unknown) => void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      bus.on("change", on);
      stream.onAbort(() => {
        bus.off("change", on);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(25_000);
      }
    }),
  );

  return api;
}
