/**
 * isProtectedUser (ee/scim/store.ts) became asynchronous. The primary admin
 * and every break-glass account of enforced SSO can never be changed through
 * SCIM, whatever an identity provider sends; the Groups endpoints
 * (ee/scim/groups.ts) check it when a member is added, when one is removed
 * and when a group with members is deleted.
 *
 * `if (isProtectedUser(…))` without await is always true, so every membership
 * change would be refused; a check that never matches would let an identity
 * provider move a break-glass account in and out of forward-auth groups.
 * scim-protocol.test.ts covers the Users endpoints (PATCH, PUT, DELETE of a
 * break-glass account) and the ordinary membership changes; this file adds
 * the protected account on the Groups endpoints, next to an ordinary SCIM
 * user that the same calls change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import {
  body,
  entraUser,
  GROUP_SCHEMA,
  idParams,
  insertLocalUser,
  insertScimToken,
  PATCH_SCHEMA,
  scimRequest,
  setScimSettings,
} from '../helpers/scim';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import * as usersRoute from '../../app/scim/v2/Users/route';
import * as groupsRoute from '../../app/scim/v2/Groups/route';
import * as groupRoute from '../../app/scim/v2/Groups/[id]/route';
import { isProtectedUser } from '../../ee/scim/store';
import { writeSsoEnforcement } from '../../ee/sso/enforcement-store';
import { first } from '@/src/lib/db/ops';

const ADMIN_ID = 1;
let token: { id: number; raw: string };
let ordinary = 0;
let glass = 0;

async function scimUser(userName: string): Promise<number> {
  const response = await usersRoute.POST(scimRequest('POST', '/scim/v2/Users', token.raw, entraUser(userName)));
  expect(response.status).toBe(201);
  return Number((await body(response)).id);
}

/** Makes `glass` a break-glass account; enforcement itself can stay off. */
async function protectGlass() {
  await writeSsoEnforcement(ctx.db, { enabled: false, breakGlassUserIds: [glass] });
}

async function createGroup(displayName: string, members: number[] = []): Promise<number> {
  const response = await groupsRoute.POST(scimRequest('POST', '/scim/v2/Groups', token.raw, {
    schemas: [GROUP_SCHEMA], displayName, members: members.map((id) => ({ value: String(id) })),
  }));
  expect(response.status).toBe(201);
  return Number((await body(response)).id);
}

function patchMembers(groupId: number, op: 'add' | 'remove', userId: number) {
  return groupRoute.PATCH(
    scimRequest('PATCH', `/scim/v2/Groups/${groupId}`, token.raw, {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op, path: 'members', value: [{ value: String(userId) }] }],
    }),
    idParams(groupId)
  );
}

async function members(groupId: number): Promise<number[]> {
  return (await ctx.db.select({ userId: schema.groupMembers.userId }).from(schema.groupMembers)
    .where(eq(schema.groupMembers.groupId, groupId))).map((row) => row.userId).sort((a, b) => a - b);
}

beforeEach(async () => {
  ctx.db = createTestDb();
  await insertLocalUser(ctx.db, { id: ADMIN_ID, email: 'admin@localhost', role: 'admin' });
  token = await insertScimToken(ctx.db);
  await setScimSettings(ctx.db, {});
  ordinary = await scimUser('ordinary@example.com');
  glass = await scimUser('glass@example.com');
});

describe('isProtectedUser', () => {
  it('returns a real boolean', async () => {
    expect(await isProtectedUser(ctx.db, ADMIN_ID)).toBe(true);
    expect(await isProtectedUser(ctx.db, glass)).toBe(false);
    expect(await isProtectedUser(ctx.db, ordinary)).toBe(false);
    await protectGlass();
    expect(await isProtectedUser(ctx.db, glass)).toBe(true);
    expect(await isProtectedUser(ctx.db, ordinary)).toBe(false);
  });
});

describe('SCIM Groups and a break-glass account', () => {
  it('refuses adding it to a group, and adds an ordinary SCIM user', async () => {
    const group = await createGroup('Operators');
    await protectGlass();
    const refused = await patchMembers(group, 'add', glass);
    expect(refused.status).toBe(403);
    expect(await members(group)).toEqual([]);

    expect((await patchMembers(group, 'add', ordinary)).status).toBe(200);
    expect(await members(group)).toEqual([ordinary]);
  });

  it('refuses creating a group with it as a member', async () => {
    await protectGlass();
    const refused = await groupsRoute.POST(scimRequest('POST', '/scim/v2/Groups', token.raw, {
      schemas: [GROUP_SCHEMA], displayName: 'Escalation', members: [{ value: String(glass) }],
    }));
    expect(refused.status).toBe(403);
    expect(await first(ctx.db.select().from(schema.groups).where(eq(schema.groups.name, 'Escalation')).limit(1))).toBeUndefined();
  });

  it('refuses removing it from a group, and removes an ordinary SCIM user', async () => {
    const group = await createGroup('Support', [ordinary, glass]);
    await protectGlass();
    const refused = await patchMembers(group, 'remove', glass);
    expect(refused.status).toBe(403);
    expect(await members(group)).toEqual([ordinary, glass].sort((a, b) => a - b));

    expect((await patchMembers(group, 'remove', ordinary)).status).toBe(200);
    expect(await members(group)).toEqual([glass]);
  });

  it('refuses deleting a group it is a member of, and deletes one without it', async () => {
    const withGlass = await createGroup('Night shift', [ordinary, glass]);
    const without = await createGroup('Day shift', [ordinary]);
    await protectGlass();
    const refused = await groupRoute.DELETE(scimRequest('DELETE', `/scim/v2/Groups/${withGlass}`, token.raw), idParams(withGlass));
    expect(refused.status).toBe(403);
    expect(await first(ctx.db.select().from(schema.groups).where(eq(schema.groups.id, withGlass)).limit(1))).toBeDefined();
    expect(await members(withGlass)).toEqual([ordinary, glass].sort((a, b) => a - b));

    expect((await groupRoute.DELETE(scimRequest('DELETE', `/scim/v2/Groups/${without}`, token.raw), idParams(without))).status).toBe(204);
    expect(await first(ctx.db.select().from(schema.groups).where(eq(schema.groups.id, without)).limit(1))).toBeUndefined();
  });
});
