import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Opens Postgres when a URL is given, otherwise an embedded PGlite database
 * (`memory://` for tests, or a directory path), and applies migrations.
 */
export async function openDatabase(opts: { databaseUrl?: string; dataDir?: string; inMemory?: boolean }): Promise<Database> {
  if (opts.databaseUrl) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const sql = postgres(opts.databaseUrl, { max: 10, onnotice: () => {} });
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => sql.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const client = new PGlite(opts.inMemory ? undefined : join(opts.dataDir ?? 'data', 'pglite'));
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}

export { schema };
