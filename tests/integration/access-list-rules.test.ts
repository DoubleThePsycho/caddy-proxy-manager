/**
 * The access list model with rules (src/lib/models/access-lists.ts), on a
 * real in-memory database: creating and updating lists with rules and
 * settings, rule CRUD and reordering (positions stay 0..n-1, ids kept on a
 * full replace), the editor's save with member changes, deletion (rules,
 * members and host references go with the list), the global Blocked sources
 * list, expiry, and the audit events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '@/src/lib/db/schema';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

import {
  addAccessListRule,
  addBlockedSource,
  createAccessList,
  deleteAccessList,
  deleteExpiredAccessListRules,
  ensureBlockedSourcesList,
  getAccessList,
  getBlockedSourcesList,
  listAccessLists,
  removeAccessListRule,
  removeBlockedSource,
  reorderAccessListRules,
  replaceAccessListRules,
  saveAccessList,
  updateAccessList,
  updateAccessListRule,
  countAccessLists,
} from '@/src/lib/models/access-lists';
import { createProxyHost, updateProxyHost } from '@/src/lib/models/proxy-hosts';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { logAuditEvent } from '@/src/lib/audit';

const ADMIN = 1;

beforeEach(async () => {
  db = createTestDb();
  const now = new Date().toISOString();
  await db.insert(schema.users).values({ id: ADMIN, email: 'admin@example.com', role: 'admin', status: 'active', createdAt: now, updatedAt: now });
  vi.mocked(applyCaddyConfig).mockClear();
  vi.mocked(logAuditEvent).mockClear();
});

const allow = (...values: string[]) => ({ action: 'allow', kind: 'ip', values });
const deny = (...values: string[]) => ({ action: 'deny', kind: 'ip', values });

function positions(rows: Array<{ position: number }>) {
  return rows.map((row) => row.position);
}

describe('lists with rules', () => {
  it('creates a list with ordered rules and settings and applies Caddy once', async () => {
    const list = await createAccessList(
      {
        name: '  EU only  ',
        defaultAction: 'deny',
        denyStatus: 451,
        denyBody: 'Not available here',
        failClosed: true,
        rules: [
          { action: 'allow', kind: 'continent', values: ['eu'] },
          { action: 'allow', kind: 'ip', values: 'private_ranges', note: 'LAN' },
        ],
      },
      ADMIN
    );
    expect(list).toMatchObject({
      name: 'EU only',
      defaultAction: 'deny',
      denyStatus: 451,
      denyBody: 'Not available here',
      denyRedirectUrl: null,
      failClosed: true,
      system: null,
    });
    expect(list.rules.map(({ position, action, kind, values, note }) => ({ position, action, kind, values, note }))).toEqual([
      { position: 0, action: 'allow', kind: 'continent', values: ['EU'], note: null },
      { position: 1, action: 'allow', kind: 'ip', values: ['private_ranges'], note: 'LAN' },
    ]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'access_list', entityId: list.id }));
  });

  it('refuses invalid input before writing anything', async () => {
    await expect(createAccessList({ name: 'Bad', rules: [deny('10.0.0.256')] }, ADMIN)).rejects.toThrow(/not an IP address/);
    await expect(createAccessList({ name: 'Bad', denyStatus: 200 }, ADMIN)).rejects.toThrow(/400 to 599/);
    await expect(createAccessList({ name: '' }, ADMIN)).rejects.toThrow(/name is required/);
    await expect(createAccessList({ name: 'Dupes', users: [{ username: 'a', password: 'x' }, { username: 'a', password: 'y' }] }, ADMIN))
      .rejects.toThrow(/repeat a username/);
    expect(await db.select().from(schema.accessLists)).toEqual([]);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('keeps basic-auth-only lists as they were: allow by default, no rules', async () => {
    const list = await createAccessList({ name: 'Staff', users: [{ username: 'bob', password: 'Bob-Passw0rd!' }] }, ADMIN);
    expect(list).toMatchObject({ defaultAction: 'allow', denyStatus: 403, failClosed: false, rules: [] });
    expect(list.entries.map((entry) => entry.username)).toEqual(['bob']);
  });

  it('replaces rules in order on update, keeping the ids of rules sent back', async () => {
    const list = await createAccessList({ name: 'Office', rules: [allow('203.0.113.0/26'), deny('0.0.0.0/0')] }, ADMIN);
    const [first, second] = list.rules;
    const updated = await updateAccessList(
      list.id,
      { rules: [{ ...second }, deny('198.51.100.7'), { ...first, note: 'Office, Bologna' }], defaultAction: 'deny' },
      ADMIN
    );
    expect(updated.defaultAction).toBe('deny');
    expect(updated.rules.map((rule) => [rule.id === second.id, rule.id === first.id, rule.values[0], rule.note])).toEqual([
      [true, false, '0.0.0.0/0', null],
      [false, false, '198.51.100.7', null],
      [false, true, '203.0.113.0/26', 'Office, Bologna'],
    ]);
    expect(positions(updated.rules)).toEqual([0, 1, 2]);
    expect(logAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'update', entityType: 'access_list', summary: expect.stringMatching(/1 added, 1 changed/) })
    );

    // A rule id of another list is not taken over: it becomes a new rule.
    const other = await createAccessList({ name: 'Other', rules: [deny('192.0.2.1')] }, ADMIN);
    const replaced = await replaceAccessListRules(list.id, [{ ...other.rules[0] }], ADMIN);
    expect(replaced[0].id).not.toBe(other.rules[0].id);
    expect((await getAccessList(other.id))!.rules).toHaveLength(1);
  });

  it('adds, changes, moves and removes single rules with contiguous positions', async () => {
    const list = await createAccessList({ name: 'Rules', rules: [deny('192.0.2.1'), deny('192.0.2.2')] }, ADMIN);
    const added = await addAccessListRule(list.id, { action: 'allow', kind: 'country', values: ['it'] }, ADMIN, { position: 0 });
    expect(added).toMatchObject({ position: 0, values: ['IT'] });
    let rules = (await getAccessList(list.id))!.rules;
    expect(rules.map((rule) => rule.values[0])).toEqual(['IT', '192.0.2.1', '192.0.2.2']);
    expect(positions(rules)).toEqual([0, 1, 2]);

    const changed = await updateAccessListRule(list.id, rules[2].id, { action: 'deny', kind: 'asn', values: ['AS64500'] }, ADMIN);
    expect(changed).toMatchObject({ position: 2, kind: 'asn', values: ['64500'] });

    const reordered = await reorderAccessListRules(list.id, [rules[2].id, rules[0].id, rules[1].id], ADMIN);
    expect(reordered.map((rule) => rule.values[0])).toEqual(['64500', 'IT', '192.0.2.1']);

    await removeAccessListRule(list.id, rules[0].id, ADMIN);
    rules = (await getAccessList(list.id))!.rules;
    expect(rules.map((rule) => rule.values[0])).toEqual(['64500', '192.0.2.1']);
    expect(positions(rules)).toEqual([0, 1]);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'access_list_rule', action: 'delete' }));
  });

  it('refuses a reorder that does not name every rule once, and rules of another list', async () => {
    const list = await createAccessList({ name: 'Rules', rules: [deny('192.0.2.1'), deny('192.0.2.2')] }, ADMIN);
    const other = await createAccessList({ name: 'Other', rules: [deny('192.0.2.3')] }, ADMIN);
    const [a, b] = list.rules;
    await expect(reorderAccessListRules(list.id, [a.id], ADMIN)).rejects.toThrow(/exactly once/);
    await expect(reorderAccessListRules(list.id, [a.id, a.id], ADMIN)).rejects.toThrow(/exactly once/);
    await expect(reorderAccessListRules(list.id, [a.id, other.rules[0].id], ADMIN)).rejects.toThrow(/exactly once/);
    await expect(reorderAccessListRules(list.id, 'nope', ADMIN)).rejects.toThrow(/array of rule ids/);
    await expect(updateAccessListRule(list.id, other.rules[0].id, deny('192.0.2.9'), ADMIN)).rejects.toThrow(/not found/);
    await expect(removeAccessListRule(other.id, b.id, ADMIN)).rejects.toThrow(/not found/);
    await expect(addAccessListRule(list.id, deny('192.0.2.9'), ADMIN, { position: -1 })).rejects.toThrow(/position/);
  });

  it('deletes a list with its rules and members and detaches it from hosts', async () => {
    const list = await createAccessList(
      { name: 'Doomed', rules: [deny('192.0.2.1')], users: [{ username: 'carol', password: 'Carol-Passw0rd!' }] },
      ADMIN
    );
    const host = await createProxyHost({ name: 'app', domains: ['app.example.com'], upstreams: ['10.0.0.5:8080'], accessListId: list.id }, ADMIN);
    await deleteAccessList(list.id, ADMIN);
    expect(await db.select().from(schema.accessListRules)).toEqual([]);
    expect(await db.select().from(schema.accessListEntries)).toEqual([]);
    const row = await db.query.proxyHosts.findFirst({ where: (table, { eq: equals }) => equals(table.id, host.id) });
    expect(row!.accessListId).toBeNull();
  });
});

describe('the editor save', () => {
  it('saves settings, rules and member changes together', async () => {
    const list = await createAccessList(
      { name: 'Staff', users: [{ username: 'alice', password: 'Alice-Passw0rd!' }, { username: 'bob', password: 'Bob-Passw0rd!' }] },
      ADMIN
    );
    const [alice, bob] = list.entries;
    const saved = await saveAccessList(
      list.id,
      {
        expectedUpdatedAt: list.updatedAt,
        description: 'Before the metrics store',
        rules: [allow('203.0.113.0/26')],
        defaultAction: 'deny',
        members: {
          add: [{ username: 'dave', password: 'Dave-Passw0rd!' }],
          remove: [bob.id],
          passwords: [{ id: alice.id, password: 'Alice-New-Passw0rd!' }],
        },
      },
      ADMIN
    );
    expect(saved.description).toBe('Before the metrics store');
    expect(saved.entries.map((entry) => entry.username)).toEqual(['alice', 'dave']);
    expect(saved.rules).toHaveLength(1);
    const aliceRow = await db.query.accessListEntries.findFirst({ where: (table, { eq: equals }) => equals(table.id, alice.id) });
    expect(await bcrypt.compare('Alice-New-Passw0rd!', aliceRow!.passwordHash)).toBe(true);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(2);
  });

  it('answers 409 when the list changed since the editor opened it', async () => {
    const list = await createAccessList({ name: 'Raced' }, ADMIN);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await updateAccessList(list.id, { description: 'Changed elsewhere' }, ADMIN);
    await expect(saveAccessList(list.id, { expectedUpdatedAt: list.updatedAt, description: 'Mine' }, ADMIN)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a member name twice and a new password for a member of another list', async () => {
    const list = await createAccessList({ name: 'Staff', users: [{ username: 'alice', password: 'Alice-Passw0rd!' }] }, ADMIN);
    const other = await createAccessList({ name: 'Other', users: [{ username: 'eve', password: 'Eve-Passw0rd!' }] }, ADMIN);
    await expect(saveAccessList(list.id, { members: { add: [{ username: 'alice', password: 'x' }] } }, ADMIN)).rejects.toMatchObject({ status: 409 });
    await expect(saveAccessList(list.id, { members: { passwords: [{ id: other.entries[0].id, password: 'x' }] } }, ADMIN))
      .rejects.toThrow(/does not have/);
    // Removing a member and adding it again in one save is fine.
    const saved = await saveAccessList(list.id, { members: { remove: [list.entries[0].id], add: [{ username: 'alice', password: 'Again-1!' }] } }, ADMIN);
    expect(saved.entries.map((entry) => entry.username)).toEqual(['alice']);
    // A removal of another list's member changes nothing there.
    await saveAccessList(list.id, { members: { remove: [other.entries[0].id] } }, ADMIN);
    expect((await getAccessList(other.id))!.entries).toHaveLength(1);
  });
});

describe('the Blocked sources list', () => {
  it('is created on first use, once, and is never one of the lists users manage', async () => {
    expect(await getBlockedSourcesList()).toBeNull();
    const first = await ensureBlockedSourcesList();
    const second = await ensureBlockedSourcesList();
    expect(second.id).toBe(first.id);
    expect(await listAccessLists()).toEqual([]);
    expect(await countAccessLists()).toBe(0);
    expect((await getBlockedSourcesList())!.system).toBe('blocked_sources');
  });

  it('blocks an address with a reason and an expiry, and answers an existing entry for the same address', async () => {
    const { entry, created } = await addBlockedSource({ address: '198.51.100.19', reason: 'Scanner hitting every host', expiresInSeconds: 86_400 }, ADMIN);
    expect(created).toBe(true);
    expect(entry).toMatchObject({ action: 'deny', kind: 'ip', values: ['198.51.100.19'], note: 'Scanner hitting every host' });
    expect(Date.parse(entry.expiresAt!)).toBeGreaterThan(Date.now() + 86_000_000);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'blocked_source', action: 'create' }));

    const again = await addBlockedSource({ address: '198.51.100.19/32', reason: 'Still scanning' }, ADMIN);
    expect(again).toMatchObject({ created: false, entry: { id: entry.id, note: 'Still scanning', expiresAt: entry.expiresAt } });
    const asn = await addBlockedSource({ kind: 'asn', value: 'AS64500' }, ADMIN);
    expect(asn.entry.values).toEqual(['64500']);
    expect((await getBlockedSourcesList())!.rules.map((rule) => rule.position)).toEqual([0, 1]);
  });

  it('refuses what would block everyone, allow rules, members, renaming, a deny default and deletion', async () => {
    await expect(addBlockedSource({ address: '0.0.0.0/0' }, ADMIN)).rejects.toThrow(/every address/);
    await expect(addBlockedSource({ address: '::/0' }, ADMIN)).rejects.toThrow(/every address/);
    await expect(addBlockedSource({ address: 'nope' }, ADMIN)).rejects.toThrow(/not an IP address/);
    await expect(addBlockedSource({ address: '192.0.2.1', kind: 'ip' }, ADMIN)).rejects.toThrow(/address, or kind/);
    await expect(addBlockedSource({ address: '192.0.2.1', expiresAt: '2030-01-01T00:00:00Z', expiresInSeconds: 60 }, ADMIN)).rejects.toThrow(/not both/);
    await expect(addBlockedSource({ address: '192.0.2.1', expiresInSeconds: 5 }, ADMIN)).rejects.toThrow(/at least 60/);
    await expect(addBlockedSource({ address: '192.0.2.1', extra: true } as never, ADMIN)).rejects.toThrow(/unknown field/);
    const list = await ensureBlockedSourcesList();
    await expect(updateAccessList(list.id, { rules: [allow('192.0.2.1')] }, ADMIN)).rejects.toThrow(/only holds deny rules/);
    await expect(addAccessListRule(list.id, allow('192.0.2.1'), ADMIN)).rejects.toThrow(/only holds deny rules/);
    await expect(updateAccessList(list.id, { name: 'Mine' }, ADMIN)).rejects.toThrow(/cannot be renamed/);
    await expect(updateAccessList(list.id, { defaultAction: 'deny' }, ADMIN)).rejects.toThrow(/lets through/);
    await expect(saveAccessList(list.id, { members: { add: [{ username: 'x', password: 'y' }] } }, ADMIN)).rejects.toThrow(/no members/);
    await expect(deleteAccessList(list.id, ADMIN)).rejects.toThrow(/cannot be deleted/);
  });

  it('cannot be attached to a host', async () => {
    const list = await ensureBlockedSourcesList();
    await expect(createProxyHost({ name: 'app', domains: ['app.example.com'], upstreams: ['10.0.0.5:8080'], accessListId: list.id }, ADMIN))
      .rejects.toThrow(/every host/);
    const host = await createProxyHost({ name: 'app', domains: ['app.example.com'], upstreams: ['10.0.0.5:8080'] }, ADMIN);
    await expect(updateProxyHost(host.id, { accessListId: list.id }, ADMIN)).rejects.toThrow(/every host/);
  });

  it('unblocks an entry, only of its own', async () => {
    const { entry } = await addBlockedSource({ address: '198.51.100.19' }, ADMIN);
    const other = await createAccessList({ name: 'Other', rules: [deny('192.0.2.1')] }, ADMIN);
    await expect(removeBlockedSource(other.rules[0].id, ADMIN)).rejects.toThrow(/not found/);
    await removeBlockedSource(entry.id, ADMIN);
    expect((await getBlockedSourcesList())!.rules).toEqual([]);
  });
});

describe('expiry', () => {
  it('deletes expired rules, renumbers the rest, audits and applies once', async () => {
    const list = await createAccessList({ name: 'Temp', rules: [deny('192.0.2.1'), deny('192.0.2.2'), deny('192.0.2.3')] }, ADMIN);
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.update(schema.accessListRules).set({ expiresAt: past }).where(eq(schema.accessListRules.id, list.rules[0].id));
    await db.update(schema.accessListRules).set({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      .where(eq(schema.accessListRules.id, list.rules[2].id));
    vi.mocked(applyCaddyConfig).mockClear();

    expect((await getAccessList(list.id))!.rules[0].expired).toBe(true);
    expect(await deleteExpiredAccessListRules()).toBe(1);
    const rules = (await getAccessList(list.id))!.rules;
    expect(rules.map((rule) => [rule.values[0], rule.position])).toEqual([['192.0.2.2', 0], ['192.0.2.3', 1]]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'expire', entityType: 'access_list_rule', userId: null }));

    vi.mocked(applyCaddyConfig).mockClear();
    expect(await deleteExpiredAccessListRules()).toBe(0);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });
});
