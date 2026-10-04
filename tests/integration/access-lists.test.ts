import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import { accessLists, accessListEntries, accessListRules, proxyHosts } from '@/src/lib/db/schema';
import { eq } from 'drizzle-orm';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

import { deleteAccessList } from '@/src/lib/models/access-lists';

beforeEach(async () => {
  db = createTestDb();
  // As in production: SQLite runs with foreign keys off, PostgreSQL has none.
  await disableForeignKeys(db);
});

function nowIso() {
  return new Date().toISOString();
}

async function insertAccessList(overrides: Partial<typeof accessLists.$inferInsert> = {}) {
  const now = nowIso();
  const [list] = await db.insert(accessLists).values({
    name: 'Test List',
    description: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning();
  return list;
}

async function insertEntry(accessListId: number, overrides: Partial<typeof accessListEntries.$inferInsert> = {}) {
  const now = nowIso();
  const [entry] = await db.insert(accessListEntries).values({
    accessListId,
    username: 'testuser',
    passwordHash: '$2b$10$hashedpassword',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning();
  return entry;
}

describe('access-lists integration', () => {
  it('creates an access list and stores it', async () => {
    const list = await insertAccessList({ name: 'Private Area' });
    const row = await db.query.accessLists.findFirst({ where: (t, { eq }) => eq(t.id, list.id) });
    expect(row).toBeDefined();
    expect(row!.name).toBe('Private Area');
  });

  it('creates access list entry with username and hash', async () => {
    const list = await insertAccessList();
    const entry = await insertEntry(list.id, { username: 'alice', passwordHash: '$2b$10$abc' });
    const row = await db.query.accessListEntries.findFirst({ where: (t, { eq }) => eq(t.id, entry.id) });
    expect(row!.username).toBe('alice');
    expect(row!.passwordHash).toBe('$2b$10$abc');
  });

  it('queries entries for a list and returns correct count', async () => {
    const list = await insertAccessList();
    await insertEntry(list.id, { username: 'user1' });
    await insertEntry(list.id, { username: 'user2' });
    await insertEntry(list.id, { username: 'user3' });

    const entries = await db.select().from(accessListEntries).where(eq(accessListEntries.accessListId, list.id));
    expect(entries.length).toBe(3);
  });

  it('deletes an entry and it is removed', async () => {
    const list = await insertAccessList();
    const entry = await insertEntry(list.id);
    await db.delete(accessListEntries).where(eq(accessListEntries.id, entry.id));
    const row = await db.query.accessListEntries.findFirst({ where: (t, { eq }) => eq(t.id, entry.id) });
    expect(row).toBeUndefined();
  });

  it('deleting a list deletes its entries and rules and detaches its hosts, without foreign keys', async () => {
    const list = await insertAccessList();
    const other = await insertAccessList({ name: 'Other' });
    await insertEntry(list.id, { username: 'user1' });
    await insertEntry(list.id, { username: 'user2' });
    await insertEntry(other.id, { username: 'kept' });
    const now = nowIso();
    await db.insert(accessListRules).values({
      accessListId: list.id, position: 0, action: 'allow', kind: 'ip', matchValues: '["192.0.2.0/24"]', createdAt: now, updatedAt: now,
    });
    const [host] = await db.insert(proxyHosts).values({
      name: 'Host', domains: '["app.example.com"]', upstreams: '["backend:80"]', accessListId: list.id, createdAt: now, updatedAt: now,
    }).returning();

    await deleteAccessList(list.id, 1);

    const listRow = await db.query.accessLists.findFirst({ where: (t, { eq }) => eq(t.id, list.id) });
    expect(listRow).toBeUndefined();
    expect(await db.select().from(accessListEntries).where(eq(accessListEntries.accessListId, list.id))).toHaveLength(0);
    expect(await db.select().from(accessListRules).where(eq(accessListRules.accessListId, list.id))).toHaveLength(0);
    const [hostRow] = await db.select({ accessListId: proxyHosts.accessListId }).from(proxyHosts).where(eq(proxyHosts.id, host.id));
    expect(hostRow.accessListId).toBeNull();
    // Another list keeps its members.
    expect(await db.select().from(accessListEntries).where(eq(accessListEntries.accessListId, other.id))).toHaveLength(1);
  });

  it('entries for different lists do not mix', async () => {
    const list1 = await insertAccessList({ name: 'List 1' });
    const list2 = await insertAccessList({ name: 'List 2' });
    await insertEntry(list1.id, { username: 'user-in-list1' });
    await insertEntry(list2.id, { username: 'user-in-list2' });

    const list1Entries = await db.select().from(accessListEntries).where(eq(accessListEntries.accessListId, list1.id));
    expect(list1Entries.length).toBe(1);
    expect(list1Entries[0].username).toBe('user-in-list1');
  });
});
