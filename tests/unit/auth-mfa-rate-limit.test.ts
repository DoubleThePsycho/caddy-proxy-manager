/**
 * Better Auth's per-client limit on the two-factor endpoints (3 requests per
 * 10 seconds), on top of the per-challenge and per-account limits that
 * auth-mfa.test.ts covers. It is on unless AUTH_RATE_LIMIT_ENABLED=false.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { APP_BASE_URL, AuthBrowser } from '../helpers/mfa-browser';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';

let database: AppDatabase;

const PASSWORD = 'Correct-Horse-9!';

let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-mfa-rate-');
  process.env.BASE_URL = APP_BASE_URL;
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  vi.resetModules();
  const { getAuth } = await import('../../src/lib/auth-server');
  const userModel = await import('../../src/lib/models/user');
  await userModel.createUser({
    email: 'limited@example.com', username: 'limited', role: 'user', provider: 'credentials', subject: 'limited',
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
  });
  handler = getAuth().handler;
});

afterAll(async () => {
  await database.close();
  vi.resetModules();
});

describe('two-factor endpoints rate limit', () => {
  it('answers 429 after 3 attempts within 10 seconds from one client', async () => {
    const b = new AuthBrowser(() => handler);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await b.post('/two-factor/verify-totp', { code: '000000' })).status);
    }
    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });
});
