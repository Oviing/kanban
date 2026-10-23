import type { Db } from "./db.js";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE principals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('human','agent')),
    oidc_issuer text,
    oidc_sub text,
    name text NOT NULL,
    email text,
    role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    can_confirm boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (oidc_issuer, oidc_sub)
  );
  CREATE TABLE api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    label text NOT NULL DEFAULT '',
    prefix text NOT NULL,
    hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz
  );
  CREATE TABLE boards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed','confirmed','in_progress','review','done')),
    priority int NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
    labels text[] NOT NULL DEFAULT '{}',
    created_by uuid NOT NULL REFERENCES principals(id),
    assignee_id uuid REFERENCES principals(id),
    confirmed_by uuid REFERENCES principals(id),
    confirmed_at timestamptz,
    version int NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX tasks_board_status ON tasks (board_id, status);
  CREATE TABLE comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES principals(id),
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE events (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES principals(id),
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX events_task ON events (task_id, id);
  `,
  `
  ALTER TABLE tasks ADD COLUMN needs_input boolean NOT NULL DEFAULT false;
  ALTER TABLE tasks ADD COLUMN question text;
  ALTER TABLE tasks ADD COLUMN lease_expires_at timestamptz;
  ALTER TABLE tasks ADD COLUMN review_summary text;
  ALTER TABLE tasks ADD COLUMN review_links text[] NOT NULL DEFAULT '{}';
  `,
  `
  ALTER TABLE boards ADD COLUMN human_in_loop boolean NOT NULL DEFAULT true;
  `,
];

export async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY)`);
  const { rows } = await db.query<{ version: number }>(`SELECT version FROM schema_migrations`);
  const done = new Set(rows.map((r) => r.version));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (done.has(i)) continue;
    await db.tx(async (t) => {
      // Run statements one by one: some drivers reject multi-statement prepared queries.
      for (const stmt of MIGRATIONS[i].split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        await t.query(stmt);
      }
      await t.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [i]);
    });
  }
}
