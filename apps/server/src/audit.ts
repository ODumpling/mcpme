import { desc, lt } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { auditLog } from './db/schema.ts';

export type AuditEntry = Omit<typeof auditLog.$inferInsert, 'id' | 'createdAt'>;

const RETENTION_DAYS = 90;

/** Records who called what. Arguments and results are never stored. */
export class Audit {
  private readonly db: Db;
  private pending = new Set<Promise<unknown>>();

  constructor(db: Db) {
    this.db = db;
  }

  record(entry: AuditEntry): void {
    const p = this.db
      .insert(auditLog)
      .values({ ...entry, error: entry.error?.slice(0, 500) ?? null })
      .catch((err) => console.error('audit write failed', err))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async recent(limit = 200) {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
  }

  async prune(): Promise<void> {
    await this.db.delete(auditLog).where(lt(auditLog.createdAt, new Date(Date.now() - RETENTION_DAYS * 86_400_000)));
  }

  /** Waits for in-flight writes (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
}
