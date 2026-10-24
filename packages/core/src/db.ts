import pg from "pg";

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
}

export function pgDb(pool: pg.Pool): Db {
  const wrap = (c: pg.Pool | pg.PoolClient): Db => ({
    query: (sql, params) => c.query(sql, params as any[]) as any,
    tx: async (fn) => {
      if (!("release" in c)) {
        const client = await (c as pg.Pool).connect();
        try {
          await client.query("BEGIN");
          const out = await fn(wrap(client));
          await client.query("COMMIT");
          return out;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      return fn(wrap(c)); // already inside a transaction
    },
  });
  return wrap(pool);
}

/** Adapter for @electric-sql/pglite (used in tests). */
export function pgliteDb(pglite: any): Db {
  const wrap = (c: any): Db => ({
    query: (sql, params) => c.query(sql, params),
    tx: (fn) => (c.transaction ? c.transaction((t: any) => fn(wrap(t))) : fn(wrap(c))),
  });
  return wrap(pglite);
}
