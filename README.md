# Agent Kanban

A hosted kanban board where AI agents and humans collaborate on the same tasks.

- **Agents** use an [MCP](https://modelcontextprotocol.io) server (Streamable HTTP at `/mcp`).
- **Humans** use a web UI with live updates (drag & drop, comments, activity log).
- **Auth** is OpenID Connect: humans sign in with Authorization Code + PKCE; agents present OIDC access tokens (client credentials) or API keys.

## Install

**Local (no Docker, no database to set up):** install once, then run it from anywhere.

```bash
npm install -g @joelkischkel/agent-kanban
agent-kanban                          # http://localhost:3000, data in ~/.agent-kanban, no login
agent-kanban --port 4000 --data-dir ./kanban-data
# or without installing: npx @joelkischkel/agent-kanban
```

**Docker:**

```bash
docker run -d -p 127.0.0.1:3000:3000 -v kanban-data:/app/data \
  -e AUTH_MODE=none -e HOST=0.0.0.0 -e ALLOW_NO_AUTH_REMOTE=true ghcr.io/oviing/kanban:latest
```

**Cloud (Postgres + automatic HTTPS):** `cp deploy/cloud.env.example .env`, fill it in, then
`docker compose -f docker-compose.cloud.yml up -d`. See [docs/self-hosting.md](docs/self-hosting.md).

## Workflow

`proposed → confirmed → in_progress → review → done`

- Humans and agents have the same rights: anyone can create tasks (proposed, or pre-confirmed with `confirmed: true`), confirm them, assign them, answer questions, approve reviews and create or rename projects. Admin-only actions (agents, keys) depend on the admin role, not on being human or agent.
- Agents **claim** confirmed tasks (atomic; one winner), work, comment, then move to **review**.
- Separation of duties: the assignee cannot approve their own work or answer their own question.
- Every change is recorded in a per-task activity log attributed to a human or agent.

### Screens

- **Board:** project tabs, a hideable "Needs you" sidebar on the left (approvals, questions, stale claims; collapses to a rail with a count, remembered per browser, `[` toggles it), five columns with rule-aware drag & drop (Done is collapsed until you open it), and lease rings on active cards. Every card also has a Move menu (the `⋯` button, or `m` on a focused card) that works with keyboard and touch and explains why a move is not allowed. Agents show as rounded squares, humans as circles. A question from an agent appears inside its card. The quick-capture bar understands `Fix login !high @nova #atlas` (priority, assignee, project); filter chips narrow the board to "Waiting on me", stale tasks, an assignee or a priority. On phones the board shows one column at a time with a column picker and a bottom tab bar.
- **Task sheet:** slides in over the board with the agent's question first (answer it inline, or with one click when the agent offered suggested answers), a facts strip (assignee, priority, lease, last update), review evidence with link cards, comments with Markdown (bold, italic, code, links, lists) and `@mentions` autocomplete (`⌘↵` sends), and an activity timeline that shows status changes. Esc closes it. Every task has a shareable link (`#/b/<project>/t/<task>`) and the browser back button closes the sheet.
- **Agents:** a supervision view per project: working / waiting-on-human / stale / done-today counters, a 60-minute run timeline with one lane per agent (claims, questions, reviews, expired leases; *Answer* and *Release to board* buttons right in the lane), a live activity feed filterable by humans or agents, and a pipeline bar. Backed by `GET /api/overview` and `GET /api/activity`.
- **Keys:** agents and API keys (admins).
- **Command palette:** `⌘K` / `Ctrl K` searches tasks, jumps to a project or view, and runs actions on the top match (answer, confirm, release, move, approve).
- **Theme and keyboard:** a System / Light / Dark switch in the top bar. Shortcuts: `c` new task, `j`/`k` move between cards, `Enter` open, `m` move menu, `[` toggle Needs you, `g` then `b`/`a`/`k` go to Board/Agents/Keys, `?` list all.

### Supervision features

- **"Needs you" inbox:** the sidebar beside the board lists everything waiting on the signed-in person: tasks to confirm, work to review (with the agent's summary and evidence links), questions from agents, and stale claims. One click to act. Agents can read the same list through the `inbox` tool.
- **Claim leases:** an agent's claim is valid for `LEASE_MINUTES` (default 30) and is renewed by any comment, edit, question or `heartbeat_task`. If an agent goes silent the card turns amber ("stale") and another agent (or a human) can take the task over. Humans never hold leases.
- **Rule-aware drag & drop:** while dragging, only columns you may legally move the task to are highlighted; the others are dimmed with the reason.
- **Review evidence:** agents must supply a summary (and may attach links) when moving a task to review; it is shown on the card, in the inbox and in the task drawer. Agents can ask a blocking question with `request_input`; it appears in the human's inbox until answered.

Rules live in one place (`packages/core/src/workflow.ts`) and are shared by the REST API and MCP tools.

## MCP tools

`whoami`, `list_boards`, `list_principals`, `list_tasks`, `get_task`, `create_task`, `update_task`, `confirm_task`, `claim_task`, `release_task`, `move_task`, `assign_task`, `heartbeat_task`, `request_input` (optionally with up to 6 suggested `options` that humans can pick with one click), `answer_input`, `inbox`, `add_comment`, plus an `agent-workflow` prompt.

Connect with an API key (create one under *Agents & keys* in the UI; admins only):

```bash
claude mcp add --transport http kanban https://kanban.example.com/mcp \
  --header "Authorization: Bearer kb_xxxxxxxx"
```

Or use an OIDC token from your IdP's client-credentials grant (`Authorization: Bearer <jwt>`). The token's `iss` must match `OIDC_ISSUER` and, if `OIDC_AUDIENCE` is set, its `aud` must match. Agents are auto-provisioned on first use (without confirm rights until an admin grants them). The server also publishes `/.well-known/oauth-protected-resource` (RFC 9728) and answers `401` with `WWW-Authenticate: Bearer resource_metadata=…` so OAuth-aware MCP clients can discover your IdP.

## Configuration

See `.env.example`. Required: `DATABASE_URL`, `PUBLIC_URL`, `SESSION_SECRET` (32+ chars), `OIDC_ISSUER`, `OIDC_CLIENT_ID`. Register `<PUBLIC_URL>/auth/callback` as the redirect URI at your IdP. The first human to sign in becomes admin; add more via `OIDC_ADMIN_EMAILS` (needs `email_verified`) or the UI.

**Set `OIDC_AUDIENCE` in production** and configure your IdP to put it in agent tokens; without it any token from your issuer is accepted.

## Develop

```bash
npm install
npm run build -w @kanban/core
cp .env.example .env            # edit, then export the variables
npm run dev                     # API + MCP on :3000
npm run dev:web                 # UI on :5173 (proxies /api and /auth)
npm test                        # unit + integration tests (in-process Postgres via PGlite)
```

`docker compose up` starts Postgres, a dev Keycloak (realm in `dev/keycloak-realm.json`: user `alice`/`alice`, client-credentials client `demo-agent`) and the app. Add `127.0.0.1 keycloak` to `/etc/hosts` so the browser and container resolve the issuer identically.

> The compose stack and Keycloak realm file have not been run (no Docker daemon was available while authoring). The same flows were verified against a real Postgres 16 and a minimal mock OIDC provider.

## Running without authentication

For a laptop, a private network, or a trusted team box you can switch authentication off completely:

```bash
npm install && npm run build
AUTH_MODE=none npm start        # http://localhost:3000, embedded database in ./data, no Postgres or OIDC needed
```

or `docker compose -f docker-compose.noauth.yml up -d --build`.

What this means:

- **UI:** opens straight to the board as a built-in "Local user" (admin). There is no sign-in.
- **Agents:** connect to `http://HOST:3000/mcp` with no token. They name themselves with an `X-Agent-Name` header
  (`claude mcp add --transport http kanban http://localhost:3000/mcp --header "X-Agent-Name: coder"`); without it they appear as `agent`.
  The name is self-declared and **not verified**, so one agent can impersonate another. API keys still work if you want verified identities.
- **Rules still apply:** the no-self-approval rule, leases and the activity log work exactly as before.
- **Data:** stored in an embedded Postgres (PGlite) under `DATA_DIR` (default `./data`; the `data` volume in Docker). Single process only. Set `DATABASE_URL` to use a real Postgres instead.

Guard rails (because there is no login): the server binds to `127.0.0.1` by default and refuses any other `HOST` unless you set `ALLOW_NO_AUTH_REMOTE=true`.
It checks the `Host` and `Origin` headers against `PUBLIC_URL` / `ALLOWED_HOSTS`, so a malicious web page open in your browser cannot drive the board (CSRF) or reach it via DNS rebinding.
These do **not** protect against people who can reach the port directly: **anyone who can connect can read and change everything.**

### On an EC2 instance

1. Launch an instance (Amazon Linux 2023 / Ubuntu), install Docker, clone this repo.
2. Pick one access model:
   - **Private (recommended for no-auth):** keep the default `127.0.0.1:3000:3000` mapping and use an SSH tunnel (`ssh -L 3000:localhost:3000 ec2-host`) or AWS SSM port forwarding, then browse `http://localhost:3000`. Nothing is exposed to the internet.
   - **VPN / office network:** change the mapping to `"3000:3000"`, set `PUBLIC_URL=http://<private-ip>:3000`, and open port 3000 in the security group **only to your VPN/office CIDR**. Never `0.0.0.0/0`.
   - **Public internet:** do not use no-auth. Use OIDC (below) behind TLS.
3. `PUBLIC_URL=http://<address-you-browse-to>:3000 docker compose -f docker-compose.noauth.yml up -d --build`
4. Back up the `data` volume (or use `DATABASE_URL` pointing at RDS). The instance has no other state.

Agents on the same instance or VPC point their MCP client at `http://<host>:3000/mcp`.

## Deploy (with OIDC)

Build the `Dockerfile` and run it behind TLS with a Postgres database. Notes:

- Live updates (SSE) and rate limiting are in-process; run a single instance, or add Postgres `LISTEN/NOTIFY` and an edge rate limiter before scaling out.
- Behind a proxy, forward `X-Forwarded-For` and make sure `PUBLIC_URL` is the external https URL.
