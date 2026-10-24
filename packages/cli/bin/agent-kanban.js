#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HELP = `agent-kanban: kanban board for AI agents (MCP) and humans

Usage: agent-kanban [start] [options]

Options:
  -p, --port <n>        Port (default 3000, env PORT)
      --host <addr>     Bind address (default 127.0.0.1, env HOST)
      --data-dir <dir>  Embedded database directory (default ~/.agent-kanban, env DATA_DIR)
  -v, --version         Show the version
  -h, --help            Show this help

With no DATABASE_URL and no AUTH_MODE it runs locally with an embedded database and no login.
Set AUTH_MODE=oidc plus the variables in the README for a production setup.`;

const args = process.argv.slice(2);
if (args[0] === "start") args.shift();
const env = process.env;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    const v = args[++i];
    if (!v) { console.error(`${a} needs a value`); process.exit(2); }
    return v;
  };
  if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
  else if (a === "-v" || a === "--version") {
    console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    process.exit(0);
  } else if (a === "-p" || a === "--port") env.PORT = val();
  else if (a === "--host") env.HOST = val();
  else if (a === "--data-dir") env.DATA_DIR = val();
  else { console.error(`Unknown option ${a}\n\n${HELP}`); process.exit(2); }
}

env.AUTH_MODE ??= "none";
env.DATA_DIR ||= join(homedir(), ".agent-kanban");
env.WEB_DIST ??= fileURLToPath(new URL("../web", import.meta.url));
env.NODE_ENV ??= "production";

if (env.AUTH_MODE === "none") {
  const port = env.PORT ?? "3000";
  const host = env.HOST ?? "127.0.0.1";
  const shown = host === "127.0.0.1" || host === "0.0.0.0" ? "localhost" : host;
  console.log(`\nOpen http://${shown}:${port}`);
  console.log(`Connect an agent:\n  claude mcp add --transport http kanban http://${shown}:${port}/mcp --header "X-Agent-Name: coder"\n`);
}

await import("../dist/server.js");
