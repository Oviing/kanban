import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  STATUSES, KanbanError, addComment, assignTask, bus, createAgent, createApiKey, createBoard, renameBoard, createTask, getTask,
  listApiKeys, listBoards, listPrincipals, listTasks, moveTask, revokeApiKey, updatePrincipal, updateTask,
  type Db, type Principal,
} from "@kanban/core";

export type Env = { Variables: { principal: Principal; via: "session" | "bearer" } };

const status = z.enum(STATUSES);
const createBody = z.object({
  title: z.string().min(1), description: z.string().optional(), priority: z.number().int().min(0).max(4).optional(),
  labels: z.array(z.string()).optional(), boardId: z.string().uuid().optional(), confirmed: z.boolean().optional(),
});
const patchBody = createBody.omit({ confirmed: true, boardId: true }).partial().extend({ expectedVersion: z.number().int().optional() });

export function apiRoutes(db: Db) {
  const api = new Hono<Env>();
  const me = (c: any) => c.get("principal") as Principal;

  api.onError((e, c) => {
    if (e instanceof KanbanError) {
      const s = { not_found: 404, forbidden: 403, invalid: 400, conflict: 409 }[e.code] as 404;
      return c.json({ error: e.code, message: e.message }, s);
    }
    if (e instanceof z.ZodError) return c.json({ error: "invalid", message: e.message }, 400);
    console.error(e);
    return c.json({ error: "internal" }, 500);
  });

  api.get("/me", (c) => c.json(me(c)));
  api.get("/boards", async (c) => c.json(await listBoards(db)));
  api.post("/boards", async (c) => c.json(await createBoard(db, me(c), z.object({ name: z.string().min(1) }).parse(await c.req.json()).name), 201));

  api.patch("/boards/:id", async (c) =>
    c.json(await renameBoard(db, me(c), c.req.param("id"), z.object({ name: z.string().min(1) }).parse(await c.req.json()).name)));

  api.get("/tasks", async (c) => {
    const q = c.req.query();
    return c.json(await listTasks(db, { boardId: q.boardId, status: q.status ? status.parse(q.status) : undefined, assigneeId: q.assigneeId, label: q.label }));
  });
  api.post("/tasks", async (c) => c.json(await createTask(db, me(c), createBody.parse(await c.req.json())), 201));
  api.get("/tasks/:id", async (c) => c.json(await getTask(db, c.req.param("id"))));
  api.patch("/tasks/:id", async (c) => c.json(await updateTask(db, me(c), c.req.param("id"), patchBody.parse(await c.req.json()))));
  api.post("/tasks/:id/move", async (c) =>
    c.json(await moveTask(db, me(c), c.req.param("id"), status.parse((await c.req.json()).to))));
  api.post("/tasks/:id/assign", async (c) =>
    c.json(await assignTask(db, me(c), c.req.param("id"), z.string().uuid().nullable().parse((await c.req.json()).assigneeId))));
  api.post("/tasks/:id/comments", async (c) =>
    c.json(await addComment(db, me(c), c.req.param("id"), z.object({ body: z.string().min(1) }).parse(await c.req.json()).body), 201));

  api.get("/principals", async (c) => c.json(await listPrincipals(db)));
  api.post("/agents", async (c) =>
    c.json(await createAgent(db, me(c), z.object({ name: z.string().min(1), canConfirm: z.boolean().optional() }).parse(await c.req.json())), 201));
  api.patch("/principals/:id", async (c) =>
    c.json(await updatePrincipal(db, me(c), c.req.param("id"), z.object({ canConfirm: z.boolean().optional(), role: z.enum(["admin", "member"]).optional() }).parse(await c.req.json()))));

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
