import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

describe('health', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close().catch(() => {});
  });

  it('reports ok without a sign-in', async () => {
    const res = await fetch(`${h.base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok', uptimeSeconds: expect.any(Number) });
  });

  it('returns 503 when the database is down', async () => {
    await h.app.database.close();
    const res = await fetch(`${h.base}/api/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'error', database: 'error' });
  });
});
