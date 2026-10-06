/**
 * readCustomRole (ee/custom-roles/store.ts) became asynchronous; every
 * permission check of a custom-role user resolves through it (accessForUser
 * in ee/custom-roles/access.ts, then requireApiPermission in
 * src/lib/api-auth.ts or requirePermission in src/lib/auth.ts).
 *
 * An un-awaited readCustomRole is a Promise: truthy where the code asks
 * whether the role still exists, and without `permissions`. The call sites
 * across the REST API and the dashboard are swept in both directions by
 * custom-roles-route-guards.test.ts and custom-roles-action-guards.test.ts;
 * this file pins the read itself and one guard end to end, with a real API
 * token.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { apiRequest, insertRole, insertToken, insertUser } from '../helpers/custom-roles';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { ApiAuthError, requireApiPermission } from '@/src/lib/api-auth';
import { can } from '@/src/lib/permissions';
import { readCustomRole } from '@/ee/custom-roles/store';
import { accessForUser } from '@/ee/custom-roles/access';

const WRITERS = 1;
const READERS = 2;
const WRITER = 10;
const READER = 11;

beforeEach(async () => {
  ctx.db = createTestDb();
  await insertRole(ctx.db, WRITERS, ['proxy_hosts:read', 'proxy_hosts:write'], [], 'Writers');
  await insertRole(ctx.db, READERS, ['proxy_hosts:read'], [], 'Readers');
  await insertUser(ctx.db, WRITER, 'viewer', WRITERS);
  await insertUser(ctx.db, READER, 'viewer', READERS);
});

/** requireApiPermission with a real API token of `userId`: 'allowed' or the guard's status. */
async function guard(userId: number, permission: 'proxy_hosts:write' | 'proxy_hosts:read'): Promise<'allowed' | number> {
  const token = await insertToken(ctx.db, userId);
  try {
    await requireApiPermission(apiRequest('GET', '/api/v1/proxy-hosts', token), permission);
    return 'allowed';
  } catch (error) {
    if (error instanceof ApiAuthError) return error.status;
    throw error;
  }
}

describe('readCustomRole', () => {
  it('returns the role as stored, not a Promise, and null for one that does not exist', async () => {
    const role = await readCustomRole(ctx.db, WRITERS);
    expect(role).not.toBeInstanceOf(Promise);
    expect(role).toMatchObject({ id: WRITERS, name: 'Writers' });
    expect([...role!.permissions].sort()).toEqual(['proxy_hosts:read', 'proxy_hosts:write']);
    expect(await readCustomRole(ctx.db, 999)).toBeNull();
  });
});

describe('a custom role decides the permission check', () => {
  it('refuses a permission the role lacks, allows one it holds', async () => {
    expect(can(await accessForUser({ id: READER, role: 'viewer', customRoleId: READERS }), 'proxy_hosts:write')).toBe(false);
    expect(can(await accessForUser({ id: WRITER, role: 'viewer', customRoleId: WRITERS }), 'proxy_hosts:write')).toBe(true);
    expect(await guard(READER, 'proxy_hosts:write')).toBe(403);
    expect(await guard(WRITER, 'proxy_hosts:write')).toBe('allowed');
    expect(await guard(READER, 'proxy_hosts:read')).toBe('allowed');
  });

  it('follows the role as stored: taking the permission away refuses, deleting the role grants nothing', async () => {
    await ctx.db.update(schema.customRoles).set({ permissions: JSON.stringify(['proxy_hosts:read']) }).where(eq(schema.customRoles.id, WRITERS));
    expect(await guard(WRITER, 'proxy_hosts:write')).toBe(403);
    await ctx.db.delete(schema.customRoles).where(eq(schema.customRoles.id, READERS));
    // A role that no longer exists is the built-in viewer role: nothing.
    expect((await accessForUser({ id: READER, role: 'viewer', customRoleId: READERS })).permissions.size).toBe(0);
    expect(await guard(READER, 'proxy_hosts:read')).toBe(403);
  });
});
