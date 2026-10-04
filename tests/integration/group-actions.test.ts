/**
 * The Groups tab's server actions answer with what went wrong (a missing or
 * taken name, a member already in the group, a group that is gone) instead
 * of throwing, so the dashboard can show it; the REST API refuses the same
 * input with 400 or 409 instead of a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import { groups, users } from '@/src/lib/db/schema';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

const caller = vi.hoisted(() => ({ userId: 1, role: 'admin' }));

vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: String(caller.userId), role: caller.role } })),
  checkSameOrigin: vi.fn(() => null),
  requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())),
  requireAdmin: vi.fn(async () => ({ user: { id: String(caller.userId), role: caller.role } })),
}));
vi.mock('@/src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/api-auth')>();
  const result = () => ({ userId: caller.userId, role: caller.role, authMethod: 'bearer' as const });
  return {
    ...actual,
    requireApiUser: vi.fn(async () => result()),
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn(async () => result()),
  };
});
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  addGroupMemberAction,
  createGroupAction,
  deleteGroupAction,
  removeGroupMemberAction,
  updateGroupAction,
} from '@/app/(dashboard)/groups/actions';
import { POST as createGroupRoute } from '@/app/api/v1/groups/route';
import { first } from '@/src/lib/db/ops';

const NOW = '2026-02-01T00:00:00.000Z';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function groupNamed(name: string) {
  return await first(db.select().from(groups).where(eq(groups.name, name)).limit(1));
}

let memberId: number;

beforeEach(async () => {
  db = createTestDb();
  caller.userId = (await first(db.insert(users).values({
    email: 'admin@example.com', name: 'Admin', role: 'admin', provider: 'credentials', subject: 'admin', status: 'active', createdAt: NOW, updatedAt: NOW,
  }).returning()))!.id;
  memberId = (await first(db.insert(users).values({
    email: 'member@example.com', name: 'Member', role: 'user', provider: 'credentials', subject: 'member', status: 'active', createdAt: NOW, updatedAt: NOW,
  }).returning()))!.id;
});

describe('group actions', () => {
  it('create and update trim the name and store a blank description as none', async () => {
    expect(await createGroupAction(form({ name: '  Developers ', description: '  ' }))).toEqual({ ok: true });
    const group = (await groupNamed('Developers'))!;
    expect(group.description).toBeNull();

    expect(await updateGroupAction(group.id, form({ name: 'Platform', description: ' On call ' }))).toEqual({ ok: true });
    expect(await first(db.select().from(groups).where(eq(groups.id, group.id)).limit(1))).toMatchObject({ name: 'Platform', description: 'On call' });
  });

  it('says why a name is refused', async () => {
    expect(await createGroupAction(form({ name: '   ' }))).toEqual({ ok: false, error: 'A group needs a name' });
    expect(await createGroupAction(form({ name: 'x'.repeat(101) }))).toEqual({ ok: false, error: 'A group name is at most 100 characters' });

    expect(await createGroupAction(form({ name: 'Ops' }))).toEqual({ ok: true });
    expect(await createGroupAction(form({ name: 'Ops' }))).toEqual({ ok: false, error: 'A group with this name already exists' });

    expect(await createGroupAction(form({ name: 'Sales' }))).toEqual({ ok: true });
    expect(await updateGroupAction((await groupNamed('Sales'))!.id, form({ name: 'Ops' }))).toEqual({ ok: false, error: 'A group with this name already exists' });
    expect(await groupNamed('Sales')).toBeDefined();
  });

  it('says when a member is already in the group or was never in it', async () => {
    await createGroupAction(form({ name: 'Team' }));
    const group = (await groupNamed('Team'))!;

    expect(await addGroupMemberAction(group.id, memberId)).toEqual({ ok: true });
    expect(await addGroupMemberAction(group.id, memberId)).toEqual({ ok: false, error: 'This user is already a member of the group' });
    expect(await removeGroupMemberAction(group.id, memberId)).toEqual({ ok: true });
    expect(await removeGroupMemberAction(group.id, memberId)).toEqual({ ok: false, error: 'Member not found in group' });
  });

  it('says when the group is gone', async () => {
    await createGroupAction(form({ name: 'Short-lived' }));
    const group = (await groupNamed('Short-lived'))!;
    expect(await deleteGroupAction(group.id)).toEqual({ ok: true });

    const gone = { ok: false, error: expect.stringMatching(/not found$/) };
    expect(await deleteGroupAction(group.id)).toMatchObject(gone);
    expect(await updateGroupAction(group.id, form({ name: 'Back' }))).toMatchObject(gone);
    expect(await addGroupMemberAction(group.id, memberId)).toMatchObject(gone);
  });
});

describe('POST /api/v1/groups', () => {
  function post(body: unknown) {
    return createGroupRoute({ headers: { get: () => null }, json: async () => body } as never);
  }

  it('refuses a missing or non-text name with 400 and a taken one with 409', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ name: 42 })).status).toBe(400);
    expect((await post({ name: 'API group', description: 7 })).status).toBe(400);
    expect((await post({ name: 'API group' })).status).toBe(201);
    expect((await post({ name: ' API group ' })).status).toBe(409);
  });
});
