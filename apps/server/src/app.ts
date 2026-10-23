import { Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getPrincipal, type Db, type Principal } from "@kanban/core";
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
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: `${cfg.publicUrl}/mcp`,
      authorization_servers: [cfg.oidc.issuer],
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
      p = pid ? await getPrincipal(db, pid) : null;
      if (!p) return unauthorized(c);
      c.set("via", "session");
      // Cookie-authenticated writes must come from our own origin (CSRF defence in depth on top of SameSite=Lax).
      if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== origin)
        return c.json({ error: "forbidden", message: "bad origin" }, 403);
    }
    c.set("principal", p);
    await next();
  };

  const ip = (c: any) => c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";

  app.use("/auth/*", rateLimit(30, 60_000, ip));
  app.route("/", oidcRoutes(db, cfg));

  app.use("/api/*", authn);
  app.route("/api", apiRoutes(db));

  app.use("/mcp", rateLimit(600, 60_000, (c) => c.req.header("authorization")?.slice(-16) ?? ip(c)));
  app.use("/mcp", authn);
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
