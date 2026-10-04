/**
 * Better Auth's own request rate limits with several replicas
 * (src/lib/auth-server.ts, rateLimit.storage): two Better Auth instances
 * (two module copies, as two replicas build them) count the same client's
 * sign-in attempts together, so the fourth within 10 seconds is refused
 * whichever replica it reaches. On PostgreSQL the counts are rows of
 * auth_rate_limits; on SQLite (one process) they stay in memory and the
 * table stays empty.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_BASE_URL, AuthBrowser } from '../helpers/mfa-browser';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';

let database: AppDatabase;
type Handler = (request: Request) => Promise<Response>;
let first: Handler;
let second: Handler;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-auth-rate-');
  process.env.BASE_URL = APP_BASE_URL;
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  vi.resetModules();
  first = (await import('../../src/lib/auth-server')).getAuth().handler;
  // A second copy of the module: a Better Auth instance of its own.
  vi.resetModules();
  second = (await import('../../src/lib/auth-server')).getAuth().handler;
});

afterAll(async () => {
  await database.close();
  vi.resetModules();
});

describe('Better Auth rate limits across instances', () => {
  it('refuse the fourth sign-in attempt within 10 seconds, whichever instance answers', async () => {
    const toFirst = new AuthBrowser(() => first);
    const toSecond = new AuthBrowser(() => second);
    const body = { email: 'nobody@example.com', password: 'Wrong-Password-1!' };
    const statuses = [
      (await toFirst.post('/sign-in/email', body)).status,
      (await toSecond.post('/sign-in/email', body)).status,
      (await toFirst.post('/sign-in/email', body)).status,
      (await toSecond.post('/sign-in/email', body)).status,
    ];
    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);

    const { appDb } = await import('../../src/lib/db');
    const { authRateLimits } = await import('../../src/lib/db/schema');
    const rows = await appDb.select().from(authRateLimits);
    if (database.dialect === 'postgres') {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ count: 3 });
      expect(rows[0].key).toContain('/sign-in/email');
    } else {
      expect(rows).toEqual([]);
    }
  });
});
