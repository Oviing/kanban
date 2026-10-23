import { serve } from "@hono/node-server";
import pg from "pg";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { ensureDefaultBoard, migrate, pgDb, setLeaseMinutes } from "@kanban/core";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { makeBearerAuth } from "./auth/bearer.js";

const cfg = loadConfig();
setLeaseMinutes(cfg.leaseMinutes);
const db = pgDb(new pg.Pool({ connectionString: cfg.databaseUrl }));
await migrate(db);
await ensureDefaultBoard(db);

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = createApp({
  db,
  cfg,
  authenticateBearer: makeBearerAuth(db, { issuer: cfg.oidc.issuer, audience: cfg.oidc.audience }),
  webRoot: existsSync(webDist) ? relative(process.cwd(), webDist) || "." : undefined,
});

serve({ fetch: app.fetch, port: cfg.port }, (i) => console.log(`agent-kanban listening on :${i.port}`));
