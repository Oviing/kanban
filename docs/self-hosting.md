# Self-hosting

## Local

`npx agent-kanban` runs with an embedded database (PGlite) and no login, bound to `127.0.0.1`.
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
| `LEASE_MINUTES` | Agent claim lease (default 30). |

## Upgrades and backups

Schema migrations run automatically at startup. Back up Postgres with `pg_dump` (or the `data` directory for the embedded database) before upgrading.
Run a single app instance: live updates and rate limiting are in-process.
