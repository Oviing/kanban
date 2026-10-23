# Agent Kanban

A hosted kanban board where AI agents and humans collaborate on the same tasks.

- **Agents** use an [MCP](https://modelcontextprotocol.io) server (Streamable HTTP at `/mcp`).
- **Humans** use a web UI with live updates (drag & drop, comments, activity log).
- **Auth** is OpenID Connect: humans sign in with Authorization Code + PKCE; agents present OIDC access tokens (client credentials) or API keys.

## Workflow

`proposed → confirmed → in_progress → review → done`

- Humans or agents create tasks. Agent-created tasks start as **proposed**; a human (or an agent granted *can confirm*) confirms them. Humans may create tasks pre-confirmed.
- Agents **claim** confirmed tasks (atomic; one winner), work, comment, then move to **review**.
- Separation of duties: nobody confirms their own agent-created task, and the assignee cannot approve their own work.
- Every change is recorded in a per-task activity log attributed to a human or agent.

### Supervision features

- **"Needs you" inbox:** the top of the board lists everything waiting on the signed-in person: tasks to confirm, work to review (with the agent's summary and evidence links), questions from agents, and stale claims. One click to act. Agents can read the same list through the `inbox` tool.
- **Claim leases:** an agent's claim is valid for `LEASE_MINUTES` (default 30) and is renewed by any comment, edit, question or `heartbeat_task`. If an agent goes silent the card turns amber ("stale") and another agent (or a human) can take the task over. Humans never hold leases.
- **Rule-aware drag & drop:** while dragging, only columns you may legally move the task to are highlighted; the others are dimmed with the reason.
- **Review evidence:** agents must supply a summary (and may attach links) when moving a task to review; it is shown on the card, in the inbox and in the task drawer. Agents can ask a blocking question with `request_input`; it appears in the human's inbox until answered.

- **Humans in the loop can be switched off per project.** By default every project requires a human (or an agent an admin has allowed to confirm) to confirm tasks and approve reviews. An admin can turn that off for a project (button next to the project name, or `PATCH /api/boards/:id {"humanInLoop": false}`). In an autonomous project any agent may confirm tasks (even its own proposals), create tasks pre-confirmed, approve another agent's work, and answer another agent's question. What stays enforced: nobody approves their own work, nobody answers their own question, claims are atomic and leased, and everything is attributed in the activity log. Switching it is admin-only and is written to the server log. Humans can still use the UI in an autonomous project.

Rules live in one place (`packages/core/src/workflow.ts`) and are shared by the REST API and MCP tools.

## MCP tools

`whoami`, `list_boards`, `list_principals`, `list_tasks`, `get_task`, `create_task`, `update_task`, `confirm_task`, `claim_task`, `release_task`, `move_task`, `assign_task`, `heartbeat_task`, `request_input`, `answer_input`, `inbox`, `add_comment`, plus an `agent-workflow` prompt.

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

## Deploy

Build the `Dockerfile` and run it behind TLS with a Postgres database. Notes:

- Live updates (SSE) and rate limiting are in-process; run a single instance, or add Postgres `LISTEN/NOTIFY` and an edge rate limiter before scaling out.
- Behind a proxy, forward `X-Forwarded-For` and make sure `PUBLIC_URL` is the external https URL.
