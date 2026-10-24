import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { serializeSigned } from "hono/utils/cookie";
import { createAgent, createApiKey, verifyApiKey, migrate, pgliteDb, upsertOidcPrincipal, type Db, type Principal } from "@kanban/core";
import { createApp } from "../src/app.js";
import { makeBearerAuth } from "../src/auth/bearer.js";
import type { Config } from "../src/config.js";

const ISS = "https://idp.test/realms/x";
const cfg: Config = {
  authMode: "oidc", host: "0.0.0.0", dataDir: "", allowedHosts: ["kanban.test"],
  port: 0, databaseUrl: "", publicUrl: "https://kanban.test", sessionSecret: "s".repeat(40),
  oidc: { issuer: ISS, clientId: "web", audience: "kanban", scope: "openid", allowInsecure: false }, adminEmails: [], leaseMinutes: 30,
};

let db: Db, app: ReturnType<typeof createApp>, admin: Principal, human: Principal;
let privateKey: CryptoKey, otherKey: CryptoKey;

beforeAll(async () => {
  db = pgliteDb(new PGlite());
  await migrate(db);
  const kp = await generateKeyPair("RS256");
  otherKey = (await generateKeyPair("RS256")).privateKey;
  privateKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), alg: "RS256", kid: "k1" };
  app = createApp({
    db, cfg,
    authenticateBearer: makeBearerAuth(db, { issuer: ISS, audience: "kanban", getKey: createLocalJWKSet({ keys: [jwk] }) }),
  });
  admin = await upsertOidcPrincipal(db, { issuer: ISS, sub: "adm", kind: "human", name: "Ada", email: "a@x" }, ["a@x"]);
  human = await upsertOidcPrincipal(db, { issuer: ISS, sub: "hum", kind: "human", name: "Hal" });
});

const sign = (o: { aud?: string; iss?: string; exp?: string; key?: CryptoKey } = {}) =>
  new SignJWT({ client_id: "bot-1" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject("svc-bot-1")
    .setIssuer(o.iss ?? ISS).setAudience(o.aud ?? "kanban").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(o.key ?? privateKey);

async function mcp(token: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("https://kanban.test/mcp"), {
    fetch: (u, i) => Promise.resolve(app.fetch(new Request(u, i))),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return c;
}
const call = async (c: Client, name: string, args: object = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text as string, json: r.isError ? null : JSON.parse(r.content[0].text) };
};
const sessionCookie = async (p: Principal) =>
  (await serializeSigned("kb_session", JSON.stringify({ pid: p.id, exp: Date.now() + 1e6 }), cfg.sessionSecret)).split(";")[0];

describe("auth", () => {
  it("401 + discovery hint without credentials", async () => {
    const r = await app.request("https://kanban.test/mcp", { method: "POST" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
    const meta = await (await app.request("https://kanban.test/.well-known/oauth-protected-resource")).json();
    expect(meta.authorization_servers).toEqual([ISS]);
  });

  it("accepts a valid OIDC JWT and auto-provisions an agent", async () => {
    const c = await mcp(await sign());
    const me = await call(c, "whoami");
    expect(me.json).toMatchObject({ kind: "agent", name: "bot-1", canConfirm: false });
  });

  it.each([
    ["wrong audience", { aud: "other" }],
    ["wrong issuer", { iss: "https://evil" }],
    ["expired", { exp: "-1m" }],
    ["wrong signing key", { key: "other" }],
  ])("rejects JWT: %s", async (_n, o: any) => {
    const token = await sign({ ...o, key: o.key ? otherKey : undefined });
    expect((await app.request("https://kanban.test/api/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("rejects bogus API key", async () => {
    expect((await app.request("https://kanban.test/api/me", { headers: { Authorization: "Bearer kb_nope" } })).status).toBe(401);
  });

  it("session writes require same-origin", async () => {
    const cookie = await sessionCookie(human);
    const body = JSON.stringify({ title: "x" });
    const hdr = { cookie, "content-type": "application/json" };
    expect((await app.request("https://kanban.test/api/tasks", { method: "POST", headers: hdr, body })).status).toBe(403);
    expect((await app.request("https://kanban.test/api/tasks", { method: "POST", headers: { ...hdr, origin: "https://evil.test" }, body })).status).toBe(403);
    expect((await app.request("https://kanban.test/api/tasks", { method: "POST", headers: { ...hdr, origin: cfg.publicUrl }, body })).status).toBe(201);
  });

  it("MCP refuses cookie sessions", async () => {
    const r = await app.request("https://kanban.test/mcp", { method: "POST", headers: { cookie: await sessionCookie(human), origin: cfg.publicUrl } });
    expect(r.status).toBe(403);
  });
});

describe("agents collaborating over MCP", () => {
  it("propose -> human confirms in UI -> claim -> review -> approve", async () => {
    const worker = await createAgent(db, admin, { name: "worker" });
    const reviewer = await createAgent(db, admin, { name: "reviewer", canConfirm: true });
    const w = await mcp((await createApiKey(db, admin, worker.id)).key);
    const r = await mcp((await createApiKey(db, admin, reviewer.id)).key);

    expect((await w.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["create_task", "claim_task", "confirm_task"]));

    const t = (await call(w, "create_task", { title: "Write docs", labels: ["docs"] })).json;
    expect(t.status).toBe("proposed");
    expect((await call(w, "claim_task", { taskId: t.id })).isError).toBe(true); // not confirmed yet

    // Human confirms through the REST API (what the UI does).
    const res = await app.request(`https://kanban.test/api/tasks/${t.id}/move`, {
      method: "POST", body: JSON.stringify({ to: "confirmed" }),
      headers: { cookie: await sessionCookie(human), origin: cfg.publicUrl, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);

    expect((await call(w, "claim_task", { taskId: t.id })).json.assigneeId).toBe(worker.id);
    expect((await call(r, "claim_task", { taskId: t.id })).isError).toBe(true);
    await call(w, "add_comment", { taskId: t.id, body: "done, see PR" });
    expect((await call(w, "move_task", { taskId: t.id, to: "review" })).text).toMatch(/summary/);
    await call(w, "move_task", { taskId: t.id, to: "review", summary: "docs written", links: ["https://x/pr/9"] });
    expect((await call(w, "move_task", { taskId: t.id, to: "done" })).text).toMatch(/forbidden/);
    expect((await call(r, "move_task", { taskId: t.id, to: "done" })).json.status).toBe("done");

    const full = (await call(w, "get_task", { taskId: t.id })).json;
    expect(full.comments[0].authorName).toBe("worker");
    expect(full.events.map((e: any) => e.actorName)).toContain("reviewer");
    expect((await call(w, "list_tasks", { status: "done", label: "docs" })).json).toHaveLength(1);
  });
});

describe("AUTH_MODE=none", () => {
  let open: ReturnType<typeof createApp>;
  const base = "http://localhost:3000";
  beforeAll(() => {
    open = createApp({
      db,
      cfg: { ...cfg, authMode: "none", oidc: null, publicUrl: base, allowedHosts: ["localhost:3000", "203.0.113.7:3000"], sessionSecret: "" },
      authenticateBearer: (t) => verifyApiKey(db, t),
    });
  });
  const json = (path: string, init: RequestInit = {}, url = base) => open.request(url + path, init);

  it("browser acts as the built-in local admin without signing in", async () => {
    const me = await (await json("/api/me")).json();
    expect(me).toMatchObject({ kind: "human", role: "admin", authMode: "none" });
    expect((await json("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "no-auth task" }) })).status).toBe(201);
  });

  it("agents identify by X-Agent-Name; MCP works without any token", async () => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      fetch: (u, i) => Promise.resolve(open.fetch(new Request(u, i))),
      requestInit: { headers: { "X-Agent-Name": "Local Coder" } },
    }));
    const me = await call(c, "whoami");
    expect(me.json).toMatchObject({ kind: "agent", name: "Local Coder", canConfirm: false });
    const t = (await call(c, "create_task", { title: "from local agent" })).json;
    expect(t.status).toBe("proposed");
    expect((await call(c, "confirm_task", { taskId: t.id })).isError).toBeFalsy(); // agents may confirm like humans
  });

  it("an invalid API key is still rejected; a valid one wins over the header", async () => {
    expect((await json("/api/me", { headers: { Authorization: "Bearer kb_nope" } })).status).toBe(401);
    const a = await createAgent(db, admin, { name: "keyed" });
    const k = await createApiKey(db, admin, a.id);
    const me = await (await json("/api/me", { headers: { Authorization: `Bearer ${k.key}`, "X-Agent-Name": "spoof" } })).json();
    expect(me.name).toBe("keyed");
  });

  it("blocks DNS rebinding and cross-site requests from the browser", async () => {
    expect((await json("/api/me", {}, "http://evil.example:3000")).status).toBe(403);
    expect((await json("/api/me", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await json("/api/me", { headers: { Origin: "null" } })).status).toBe(403);
    expect((await json("/api/me", { headers: { Origin: base } })).status).toBe(200);
    expect((await json("/api/me", {}, "http://203.0.113.7:3000")).status).toBe(200); // allowed host (e.g. EC2 IP)
  });

  it("has no OIDC endpoints", async () => {
    expect((await json("/.well-known/oauth-protected-resource")).status).toBe(404);
  });
});
