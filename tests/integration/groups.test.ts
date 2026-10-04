import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import { forwardAuthAccess, groups, groupMembers, proxyHosts, users } from '@/src/lib/db/schema';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

import { addGroupMember, deleteGroup, getGroup } from '@/src/lib/models/groups';
import { deleteUser } from '@/src/lib/models/user';
import { ApiClientError } from '@/src/lib/api-errors';

beforeEach(async () => {
  db = createTestDb();
  // As in production: SQLite runs with foreign keys off, PostgreSQL has none.
  await disableForeignKeys(db);
});

function nowIso() {
  return new Date().toISOString();
}

async function insertUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const now = nowIso();
  const [user] = await db.insert(users).values({
    email: `user${Math.random().toString(36).slice(2)}@localhost`,
    name: 'Test User',
    role: 'user',
    provider: 'credentials',
    subject: `test-${Date.now()}`,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning();
  return user;
}

async function insertGroup(overrides: Partial<typeof groups.$inferInsert> = {}) {
  const now = nowIso();
  const [group] = await db.insert(groups).values({
    name: `Group ${Date.now()}`,
    description: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning();
  return group;
}

describe('groups integration', () => {
  it('creates a group and stores it', async () => {
    const group = await insertGroup({ name: 'Developers' });
    const row = await db.query.groups.findFirst({ where: (t, { eq }) => eq(t.id, group.id) });
    expect(row).toBeDefined();
    expect(row!.name).toBe('Developers');
  });

  it('enforces unique group names', async () => {
    await insertGroup({ name: 'UniqueGroup' });
    await expect(insertGroup({ name: 'UniqueGroup' })).rejects.toThrow();
  });

  it('adds members to a group', async () => {
    const group = await insertGroup({ name: 'Team' });
    const user = await insertUser();
    const now = nowIso();

    await db.insert(groupMembers).values({
      groupId: group.id,
      userId: user.id,
      createdAt: now,
    });

    const members = await db.query.groupMembers.findMany({
      where: (t, { eq }) => eq(t.groupId, group.id),
    });
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(user.id);
  });

  it('prevents duplicate memberships', async () => {
    const group = await insertGroup();
    const user = await insertUser();
    const now = nowIso();

    await db.insert(groupMembers).values({ groupId: group.id, userId: user.id, createdAt: now });
    await expect(
      db.insert(groupMembers).values({ groupId: group.id, userId: user.id, createdAt: now })
    ).rejects.toThrow();
  });

  it('deleting a group deletes its memberships and forward-auth grants, without foreign keys', async () => {
    const group = await insertGroup({ name: 'Doomed' });
    const kept = await insertGroup({ name: 'Kept' });
    const user = await insertUser();
    const now = nowIso();
    const [host] = await db.insert(proxyHosts).values({
      name: 'Host', domains: '["app.example.com"]', upstreams: '["backend:80"]', createdAt: now, updatedAt: now,
    }).returning();

    await db.insert(groupMembers).values([
      { groupId: group.id, userId: user.id, createdAt: now },
      { groupId: kept.id, userId: user.id, createdAt: now },
    ]);
    await db.insert(forwardAuthAccess).values([
      { proxyHostId: host.id, userId: null, groupId: group.id, createdAt: now },
      { proxyHostId: host.id, userId: null, groupId: kept.id, createdAt: now },
    ]);

    await deleteGroup(group.id, user.id);

    expect(await db.query.groups.findFirst({ where: (t, { eq }) => eq(t.id, group.id) })).toBeUndefined();
    expect(await db.query.groupMembers.findMany({ where: (t, { eq }) => eq(t.groupId, group.id) })).toHaveLength(0);
    expect(await db.query.forwardAuthAccess.findMany({ where: (t, { eq }) => eq(t.groupId, group.id) })).toHaveLength(0);
    // The other group keeps its member and its grant.
    expect(await db.query.groupMembers.findMany({ where: (t, { eq }) => eq(t.groupId, kept.id) })).toHaveLength(1);
    expect(await db.query.forwardAuthAccess.findMany({ where: (t, { eq }) => eq(t.groupId, kept.id) })).toHaveLength(1);
  });

  it('deleting a user deletes their memberships, without foreign keys', async () => {
    const group = await insertGroup();
    const user = await insertUser();
    const other = await insertUser();
    const now = nowIso();

    await db.insert(groupMembers).values([
      { groupId: group.id, userId: user.id, createdAt: now },
      { groupId: group.id, userId: other.id, createdAt: now },
    ]);
    await deleteUser(user.id);

    const members = await db.query.groupMembers.findMany({
      where: (t, { eq }) => eq(t.groupId, group.id),
    });
    expect(members.map((member) => member.userId)).toEqual([other.id]);
  });

  it('refuses a member that does not exist instead of storing the id (404)', async () => {
    const group = await insertGroup();
    const user = await insertUser();
    // The next user would get this id.
    const unknownId = user.id + 1;

    const error = await addGroupMember(group.id, unknownId, user.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).status).toBe(404);
    await expect(addGroupMember(group.id, Number.NaN, user.id)).rejects.toMatchObject({ status: 404 });
    expect(await db.query.groupMembers.findMany({ where: (t, { eq }) => eq(t.groupId, group.id) })).toHaveLength(0);

    await addGroupMember(group.id, user.id, user.id);
    expect((await getGroup(group.id))!.members.map((member) => member.userId)).toEqual([user.id]);
  });

  it('supports multiple groups per user', async () => {
    const group1 = await insertGroup({ name: 'Group A' });
    const group2 = await insertGroup({ name: 'Group B' });
    const user = await insertUser();
    const now = nowIso();

    await db.insert(groupMembers).values([
      { groupId: group1.id, userId: user.id, createdAt: now },
      { groupId: group2.id, userId: user.id, createdAt: now },
    ]);

    const memberships = await db.query.groupMembers.findMany({
      where: (t, { eq }) => eq(t.userId, user.id),
    });
    expect(memberships).toHaveLength(2);
  });
});
