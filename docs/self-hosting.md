# Self-hosting

## Local

`npm install -g @joelkischkel/agent-kanban`, then `agent-kanban` (or `npx @joelkischkel/agent-kanban` without installing) runs with an embedded database (PGlite) and no login, bound to `127.0.0.1`.
Flags: `--port`, `--host`, `--data-dir` (default `~/.agent-kanban`). Back up by copying the data directory while stopped.

## Cloud

`docker-compose.cloud.yml` runs the app, Postgres 16 and Caddy (automatic HTTPS). You need a domain pointing at the host,
ports 80/443 open, and an OpenID Connect provider (register `https://$DOMAIN/auth/callback`).

```bash
cp deploy/cloud.env.example .env && $EDITOR .env
docker compose -f docker-compose.cloud.yml up -d
curl https://$DOMAIN/healthz
```

Set `APP_IMAGE=ghcr.io/oviing/kanban:<version>` to use a published image instead of building.

## Environment

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres URL. Unset = embedded database in `DATA_DIR` (single process only). |
| `PUBLIC_URL` | External URL users browse to (https in production). |
| `SESSION_SECRET` | 32+ random chars (`openssl rand -hex 32`). |
| `AUTH_MODE` | `oidc` (default for the server and image) or `none` (CLI default; local/private only). |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_AUDIENCE`, `OIDC_ADMIN_EMAILS` | See README. Set `OIDC_AUDIENCE` in production. |
| `DATA_DIR` | Embedded database location (`/app/data` in the image). |
| `WEB_DIST` | Override the directory of the built UI. |
| `MULTI_TENANT` | `true` turns the deployment into a multi-organization service (OIDC mode only). See below. |
| `LEASE_MINUTES` | Agent claim lease (default 30). |

## Multi-tenant (many organizations, one MCP endpoint)

Everything (boards, tasks, agents, API keys, live updates) belongs to an **organization**; organizations never see each other.
Existing installs are migrated into one organization called "Default" and keep working unchanged.

With `MULTI_TENANT=true`:

- **People** get their own organization the first time they sign in, can create more (header menu → *New organization…*), and join others through an **invite link** (Admin → People → *Create invite link*; one use, 7 days, optionally pinned to an email). A person can belong to several organizations and switch between them. Roles (admin/member) are per organization; `OIDC_ADMIN_EMAILS` and "first human becomes admin" only apply to the Default organization.
- **Agents** belong to exactly one organization. Every organization admin creates agents and API keys in *their* Admin page; the key alone selects the tenant, so all organizations use the same URL: `claude mcp add --transport http kanban https://kanban.example.com/mcp --header "Authorization: Bearer kb_…"`.
- **OIDC agent tokens** (client credentials) must carry the claim `kanban_org` with the organization's id or slug (map it in your IdP, e.g. a hard-coded claim per client); tokens without it are rejected.

Isolation is enforced in the service layer (`packages/core/src/service.ts`): every query is scoped by the caller's organization, tasks are only loaded through `load()`, and the live event stream is filtered per organization. `packages/core/test/service.test.ts` ("tenant isolation") exercises every function with a foreign id; keep it green when adding features.

### Sign in with Google for everyone

Google is a standard OIDC provider, so open sign-up needs only configuration:

1. Google Cloud Console → APIs & Services → Credentials → *Create credentials* → *OAuth client ID* → *Web application*. Add `<PUBLIC_URL>/auth/callback` as an authorized redirect URI (`http://localhost:3000/auth/callback` works for local tests). On the consent screen choose *External* and publish the app (testing mode only admits listed users).
2. Set `OIDC_ISSUER=https://accounts.google.com`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `MULTI_TENANT=true`; leave `OIDC_AUDIENCE` unset. The login page then shows "Sign in with Google".
3. Agents can't use Google tokens: they connect with the `kb_…` API keys created in Admin.

Notes: in multi-tenant mode only a *verified* email counts (invites are pinned to emails), and one person can belong to at most 10 organizations. Don't combine Google with `MULTI_TENANT=false` unless the server is otherwise restricted: any Google user could then join the Default organization.

## Upgrades and backups

Schema migrations run automatically at startup. Back up Postgres with `pg_dump` (or the `data` directory for the embedded database) before upgrading.
Run a single app instance: live updates and rate limiting are in-process.
