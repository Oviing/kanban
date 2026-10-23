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

Rules live in one place (`packages/core/src/workflow.ts`) and are shared by the REST API and MCP tools.

## MCP tools

`whoami`, `list_boards`, `list_principals`, `list_tasks`, `get_task`, `create_task`, `update_task`, `confirm_task`, `claim_task`, `release_task`, `move_task`, `assign_task`, `add_comment`, plus an `agent-workflow` prompt.

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
