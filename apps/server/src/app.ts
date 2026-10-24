import { Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getPrincipal, upsertOidcPrincipal, type Db, type Principal } from "@kanban/core";
import type { Config } from "./config.js";
import { apiRoutes, type Env } from "./api/routes.js";
import { buildMcpServer } from "./mcp/server.js";
import { oidcRoutes } from "./auth/oidc.js";
import { readSession } from "./auth/session.js";
import { rateLimit } from "./ratelimit.js";

export interface AppDeps {
  db: Db;
  cfg: Config;
  /** Resolves an `Authorization: Bearer` token (API key or OIDC JWT) to a principal. */
  authenticateBearer: (token: string) => Promise<Principal | null>;
  /** Directory with the built web UI, if any. */
  webRoot?: string;
}

export function createApp({ db, cfg, authenticateBearer, webRoot }: AppDeps) {
  const app = new Hono<Env>();
  const origin = new URL(cfg.publicUrl).origin;
  const metadataUrl = `${cfg.publicUrl}/.well-known/oauth-protected-resource`;

  app.use("*", secureHeaders());

  app.get("/healthz", async (c) => {
    await db.query("SELECT 1");
    return c.json({ ok: true });
  });

  // RFC 9728: lets OAuth-capable MCP clients discover which IdP to use.
  if (cfg.oidc)
    app.get("/.well-known/oauth-protected-resource", (c) =>
      c.json({
        resource: `${cfg.publicUrl}/mcp`,
        authorization_servers: [cfg.oidc!.issuer],
        bearer_methods_supported: ["header"],
      }),
    );

  const unauthorized = (c: any, error?: string) => {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"${error ? `, error="${error}"` : ""}`);
    return c.json({ error: "unauthorized" }, 401);
  };

  const authn: MiddlewareHandler<Env> = async (c, next) => {
    const h = c.req.header("authorization");
    let p: Principal | null = null;
    if (h) {
      const m = /^Bearer\s+(.+)$/i.exec(h);
      p = m ? await authenticateBearer(m[1]) : null;
      if (!p) return unauthorized(c, "invalid_token");
      c.set("via", "bearer");
    } else {
      const pid = await readSession(c, cfg);
      // The UI says which of the person's organizations it is working in; default is their oldest.
      const org = c.req.header("x-org") || c.req.query("org") || undefined; // EventSource can only use the query string
      if (org && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org)) return c.json({ error: "invalid", message: "malformed organization id" }, 400);
      p = pid ? await getPrincipal(db, pid, org) : null;
      if (!p) return pid ? c.json({ error: "forbidden", message: org ? "not a member of that organization" : "no organization" }, 403) : unauthorized(c);
      c.set("via", "session");
      // Cookie-authenticated writes must come from our own origin (CSRF defence in depth on top of SameSite=Lax).
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== origin)
        return c.json({ error: "forbidden", message: "bad origin" }, 403);
    }
    c.set("principal", p);
    await next();
  };

  // ---- no-auth mode ----
  // Everyone reaching the server is trusted, so the only defences are network placement and the checks below,
  // which stop *other websites in the user's browser* from driving the board (CSRF / DNS rebinding).
  const guardNoAuth: MiddlewareHandler<Env> = async (c, next) => {
    const host = new URL(c.req.url).host.toLowerCase();
    if (!cfg.allowedHosts.includes(host)) return c.json({ error: "forbidden", message: `host ${host} not allowed (see ALLOWED_HOSTS)` }, 403);
    const o = c.req.header("origin");
    if (o && o !== "null") {
      let oh = "";
      try { oh = new URL(o).host.toLowerCase(); } catch {}
      if (!cfg.allowedHosts.includes(oh)) return c.json({ error: "forbidden", message: "cross-origin request blocked" }, 403);
    } else if (o === "null") return c.json({ error: "forbidden", message: "cross-origin request blocked" }, 403);
    await next();
  };
  const cleanName = (raw: string | undefined, fallback: string) =>
    (raw ?? "").replace(/[^\p{L}\p{N} ._@-]/gu, "").trim().slice(0, 64) || fallback;

  /**
   * Without auth, agents identify themselves with an `X-Agent-Name` header (self-declared, not verified);
   * a valid API key still wins. Browser requests to /api act as the built-in local admin.
   */
  const authnNone: MiddlewareHandler<Env> = async (c, next) => {
    const h = c.req.header("authorization");
    const agentName = c.req.header("x-agent-name");
    let p: Principal | null = null;
    if (h) {
      const m = /^Bearer\s+(.+)$/i.exec(h);
      p = m ? await authenticateBearer(m[1]) : null;
      if (!p) return unauthorized(c, "invalid_token");
      c.set("via", "bearer");
    } else if (agentName || c.req.path === "/mcp") {
      const name = cleanName(agentName, "agent");
      p = await upsertOidcPrincipal(db, { issuer: "local", sub: `agent:${name.toLowerCase()}`, kind: "agent", name });
      c.set("via", "bearer");
    } else {
      p = await upsertOidcPrincipal(db, { issuer: "local", sub: "local-user", kind: "human", name: "Local user", email: "local@localhost" }, ["local@localhost"]);
      c.set("via", "session");
    }
    c.set("principal", p);
    await next();
  };
  const authMw = cfg.authMode === "none" ? [guardNoAuth, authnNone] : [authn];

  const ip = (c: any) => c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";

  if (cfg.oidc) {
    app.use("/auth/*", rateLimit(30, 60_000, ip));
    app.route("/", oidcRoutes(db, cfg));
  } else app.get("/auth/login", (c) => c.redirect("/"));

  for (const mw of authMw) app.use("/api/*", mw);
  app.route("/api", apiRoutes(db, { authMode: cfg.authMode, leaseMinutes: cfg.leaseMinutes, multiTenant: cfg.multiTenant }));

  app.use("/mcp", rateLimit(600, 60_000, (c) => c.req.header("authorization")?.slice(-16) ?? ip(c)));
  for (const mw of authMw) app.use("/mcp", mw);
  app.all("/mcp", async (c) => {
    if (c.get("via") !== "bearer") return c.json({ error: "forbidden", message: "MCP requires a bearer token" }, 403);
    // Stateless: a fresh server per request, bound to the caller's identity.
    const server = buildMcpServer(db, c.get("principal"));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  if (webRoot) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
  }
  return app;
}
