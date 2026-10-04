/**
 * isSignInNameTaken and signInEmailConflict (src/lib/sign-in-names.ts)
 * became asynchronous. They keep every sign-in name pointing at one account:
 * a username another account uses (as username, email address or portal
 * name) is refused when an administrator sets it (src/lib/models/user.ts)
 * and when ADMIN_USERNAME is applied (src/lib/init-db.ts).
 *
 * `if (isSignInNameTaken(…) || signInEmailConflict(…))` without await is
 * always true, which refuses every name; a check that never matches lets one
 * name reach two accounts. The call sites are covered in both directions by
 * user-sign-in-username-admin.test.ts (setting or creating with a taken or a
 * free username or email) and init-admin.test.ts (ADMIN_USERNAME taken or
 * free); this file pins the predicates' own results, and the user model path
 * once more.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { isSignInNameTaken, signInEmailConflict, SIGN_IN_NAME_TAKEN_MESSAGE } from '@/src/lib/sign-in-names';
import { setUserSignInUsername } from '@/src/lib/models/user';
import { first } from '@/src/lib/db/ops';

const ALICE = 2;
const BOB = 3;

async function insertUser(id: number, email: string, username: string | null) {
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id, email, name: email, username, role: 'user', provider: 'credentials', subject: email, status: 'active',
    createdAt: now, updatedAt: now,
  });
}

async function usernameOf(id: number): Promise<string | null | undefined> {
  return (await first(ctx.db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, id)).limit(1)))?.username;
}

beforeEach(async () => {
  ctx.db = createTestDb();
  await insertUser(ALICE, 'alice@example.com', 'alice');
  await insertUser(BOB, 'bob@example.com', null);
});

describe('isSignInNameTaken', () => {
  it('returns a real boolean', async () => {
    expect(await isSignInNameTaken(ctx.db, BOB, 'alice')).toBe(true);
    expect(await isSignInNameTaken(ctx.db, BOB, 'alice@example.com')).toBe(true);
    expect(await isSignInNameTaken(ctx.db, ALICE, 'alice')).toBe(false);
    expect(await isSignInNameTaken(ctx.db, BOB, 'carol')).toBe(false);
    expect(await isSignInNameTaken(ctx.db, null, 'alice')).toBe(true);
  });
});

describe('signInEmailConflict', () => {
  it('returns the reason as a string, or null', async () => {
    expect(await signInEmailConflict(ctx.db, BOB, 'ALICE@example.com')).toBe('A user with this email already exists');
    expect(await signInEmailConflict(ctx.db, BOB, 'alice@localhost')).toMatch(/signs in with the name before @localhost/);
    expect(await signInEmailConflict(ctx.db, ALICE, 'alice@example.com')).toBeNull();
    expect(await signInEmailConflict(ctx.db, BOB, 'bob.new@example.com')).toBeNull();
  });
});

describe('setting a username (src/lib/models/user.ts)', () => {
  it("refuses another account's username or email address and keeps the old one", async () => {
    await expect(setUserSignInUsername(BOB, 'alice')).rejects.toThrow(SIGN_IN_NAME_TAKEN_MESSAGE);
    await expect(setUserSignInUsername(BOB, 'alice@example.com')).rejects.toThrow(SIGN_IN_NAME_TAKEN_MESSAGE);
    expect(await usernameOf(BOB)).toBeNull();
  });

  it('sets a name nobody else uses', async () => {
    await expect(setUserSignInUsername(BOB, 'bobby')).resolves.toMatchObject({ user: { username: 'bobby' }, previousUsername: null });
    expect(await usernameOf(BOB)).toBe('bobby');
  });
});
