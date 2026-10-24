import { serve } from "@hono/node-server";
import pg from "pg";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { ensureDefaultBoard, migrate, pgDb, pgliteDb, setLeaseMinutes, verifyApiKey, type Db } from "@kanban/core";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { makeBearerAuth } from "./auth/bearer.js";

const cfg = loadConfig();
setLeaseMinutes(cfg.leaseMinutes);

let db: Db;
if (cfg.databaseUrl) {
  db = pgDb(new pg.Pool({ connectionString: cfg.databaseUrl }));
} else {
  // Embedded Postgres (PGlite): zero setup for local use. One process only; use DATABASE_URL for anything bigger.
  const { PGlite } = await import("@electric-sql/pglite");
  mkdirSync(cfg.dataDir, { recursive: true });
  db = pgliteDb(new PGlite(`${cfg.dataDir}/pglite`));
  console.log(`Using embedded database in ${cfg.dataDir}/pglite`);
}
await migrate(db);
await ensureDefaultBoard(db);

const authenticateBearer = cfg.oidc
  ? makeBearerAuth(db, { issuer: cfg.oidc.issuer, audience: cfg.oidc.audience })
  : (token: string) => verifyApiKey(db, token); // no IdP: API keys only

// WEB_DIST lets a bundled/packaged install (npx, image) place the UI anywhere; default is the repo layout.
const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = createApp({
  db,
  cfg,
  authenticateBearer,
  webRoot: existsSync(webDist) ? relative(process.cwd(), webDist) || "." : undefined,
});

serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (i) => {
  console.log(`agent-kanban listening on http://${cfg.host}:${i.port}`);
  if (cfg.authMode === "none")
    console.warn(
      "\n⚠  AUTH_MODE=none: there is NO authentication. Anyone who can reach this port can read and change everything\n" +
        "   and can act as any agent. Use only on localhost or a network you control.\n",
    );
});
