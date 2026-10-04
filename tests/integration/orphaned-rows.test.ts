/**
 * deleteOrphanedRows (src/lib/models/orphaned-rows.ts): the start-up cleanup
 * of rows older releases left behind when they deleted the row they belong
 * to (foreign keys are not enforced: SQLite runs with them off, PostgreSQL
 * has none). It deletes them, chains included, never touches a row whose
 * parent exists, keeps what a proxy host still uses (dropping it would open
 * the host), and is idempotent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import * as schema from '@/src/lib/db/schema';
import * as authoringSchema from '@/src/lib/db/schema.sqlite';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

import { ORPHAN_PARENTS, deleteOrphanedRows } from '@/src/lib/models/orphaned-rows';

const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(async () => {
  db = createTestDb();
  await disableForeignKeys(db);
});

describe('ORPHAN_PARENTS', () => {
  it('lists every table a declared foreign key references, except users, each after the tables whose cascades reach it', () => {
    const referenced = new Set<string>();
    const cascadesFrom = new Map<string, Set<string>>();
    for (const value of Object.values(authoringSchema)) {
      if (!is(value, SQLiteTable)) continue;
      const config = getTableConfig(value);
      for (const foreignKey of config.foreignKeys) {
        const parent = getTableConfig(foreignKey.reference().foreignTable).name;
        referenced.add(parent);
        if (foreignKey.onDelete === 'cascade') {
          const children = cascadesFrom.get(parent) ?? new Set<string>();
          children.add(config.name);
          cascadesFrom.set(parent, children);
        }
      }
    }
    referenced.delete('users');
    const names = ORPHAN_PARENTS.map((parent) => parent.name);
    expect([...names].sort()).toEqual([...referenced].sort());
    // A parent whose cascade deletes rows of another parent comes first.
    for (const [parent, children] of cascadesFrom) {
      for (const child of children) {
        if (names.includes(child as (typeof names)[number]) && names.includes(parent as (typeof names)[number])) {
          expect(names.indexOf(parent as (typeof names)[number])).toBeLessThan(names.indexOf(child as (typeof names)[number]));
        }
      }
    }
  });
});

describe('deleteOrphanedRows', () => {
  async function seed() {
    const timestamp = now();
    const [user] = await db.insert(schema.users).values({
      email: 'user@example.com', role: 'user', status: 'active', createdAt: timestamp, updatedAt: timestamp,
    }).returning();
    const [liveHost, deadHost] = await db.insert(schema.proxyHosts).values([
      { name: 'Live', domains: '["live.example.com"]', upstreams: '["backend:80"]', createdAt: timestamp, updatedAt: timestamp },
      { name: 'Dead', domains: '["dead.example.com"]', upstreams: '["backend:80"]', createdAt: timestamp, updatedAt: timestamp },
    ]).returning();
    const [liveGroup, deadGroup] = await db.insert(schema.groups).values([
      { name: 'Live', createdAt: timestamp, updatedAt: timestamp },
      { name: 'Dead', createdAt: timestamp, updatedAt: timestamp },
    ]).returning();
    const [liveRole, deadRole] = await db.insert(schema.mtlsRoles).values([
      { name: 'live', createdAt: timestamp, updatedAt: timestamp },
      { name: 'dead', createdAt: timestamp, updatedAt: timestamp },
    ]).returning();
    const [liveCa, deadCa] = await db.insert(schema.caCertificates).values([
      { name: 'Live CA', certificatePem: 'PEM', createdAt: timestamp, updatedAt: timestamp },
      { name: 'Dead CA', certificatePem: 'PEM', createdAt: timestamp, updatedAt: timestamp },
    ]).returning();
    const certificate = (caCertificateId: number, commonName: string) => ({
      caCertificateId, commonName, serialNumber: commonName, fingerprintSha256: commonName, certificatePem: 'PEM',
      validFrom: timestamp, validTo: timestamp, createdAt: timestamp, updatedAt: timestamp,
    });
    const [liveCert, deadCaCert] = await db.insert(schema.issuedClientCertificates).values([
      certificate(liveCa.id, 'live'),
      certificate(deadCa.id, 'dead-ca'),
    ]).returning();

    for (const host of [liveHost, deadHost]) {
      const origin = `https://${host.name.toLowerCase()}.example.com`;
      await db.insert(schema.mtlsAccessRules).values({ proxyHostId: host.id, pathPattern: '/admin/*', createdAt: timestamp, updatedAt: timestamp });
      await db.insert(schema.forwardAuthAccess).values({ proxyHostId: host.id, userId: user.id, groupId: null, createdAt: timestamp });
      const [session] = await db.insert(schema.forwardAuthSessions).values({
        userId: user.id, proxyHostId: host.id, audienceOrigin: origin, tokenHash: `token-${host.id}`, expiresAt: later(), createdAt: timestamp,
      }).returning();
      await db.insert(schema.forwardAuthExchanges).values({
        sessionId: session.id, proxyHostId: liveHost.id, audienceOrigin: origin, codeHash: `code-${host.id}`,
        sessionToken: '[pending]', redirectUri: `${origin}/`, expiresAt: later(), used: false, createdAt: timestamp,
      });
      await db.insert(schema.forwardAuthRedirectIntents).values({
        ridHash: `rid-${host.id}`, proxyHostId: host.id, audienceOrigin: origin, redirectUri: `${origin}/`, expiresAt: later(), consumed: false, createdAt: timestamp,
      });
    }
    for (const group of [liveGroup, deadGroup]) {
      await db.insert(schema.groupMembers).values({ groupId: group.id, userId: user.id, createdAt: timestamp });
      await db.insert(schema.forwardAuthAccess).values({ proxyHostId: liveHost.id, userId: null, groupId: group.id, createdAt: timestamp });
    }
    await db.insert(schema.mtlsCertificateRoles).values([
      { issuedClientCertificateId: liveCert.id, mtlsRoleId: liveRole.id, createdAt: timestamp },
      { issuedClientCertificateId: liveCert.id, mtlsRoleId: deadRole.id, createdAt: timestamp },
      { issuedClientCertificateId: deadCaCert.id, mtlsRoleId: liveRole.id, createdAt: timestamp },
    ]);

    // What older releases did: delete the parent rows only.
    await db.delete(schema.proxyHosts).where(eq(schema.proxyHosts.id, deadHost.id));
    await db.delete(schema.groups).where(eq(schema.groups.id, deadGroup.id));
    await db.delete(schema.mtlsRoles).where(eq(schema.mtlsRoles.id, deadRole.id));
    await db.delete(schema.caCertificates).where(eq(schema.caCertificates.id, deadCa.id));
    return { user, liveHost, deadHost, liveGroup, deadGroup, liveRole, deadRole, liveCert, deadCaCert };
  }

  it('deletes the rows of deleted parents, chains included, and nothing else', async () => {
    const seeded = await seed();

    const report = await deleteOrphanedRows(db);
    expect(report.deleted.length).toBeGreaterThan(0);
    expect(report.dangling).toEqual([]);
    expect(report.kept).toEqual([]);

    const hostIds = async (table: typeof schema.mtlsAccessRules | typeof schema.forwardAuthSessions | typeof schema.forwardAuthRedirectIntents) =>
      (await db.select({ id: table.proxyHostId }).from(table)).map((row) => row.id);
    expect(await hostIds(schema.mtlsAccessRules)).toEqual([seeded.liveHost.id]);
    expect(await hostIds(schema.forwardAuthSessions)).toEqual([seeded.liveHost.id]);
    expect(await hostIds(schema.forwardAuthRedirectIntents)).toEqual([seeded.liveHost.id]);
    // The dead host's session went, and with it its exchange code (a chain).
    const exchanges = await db.select().from(schema.forwardAuthExchanges);
    expect(exchanges.map((row) => row.codeHash)).toEqual([`code-${seeded.liveHost.id}`]);

    const grants = await db.select().from(schema.forwardAuthAccess);
    expect(grants.every((row) => row.proxyHostId === seeded.liveHost.id)).toBe(true);
    expect(grants.map((row) => row.groupId).filter((id) => id !== null)).toEqual([seeded.liveGroup.id]);
    expect((await db.select().from(schema.groupMembers)).map((row) => row.groupId)).toEqual([seeded.liveGroup.id]);

    // The dead CA's certificate went, and the assignments of it and of the dead role.
    expect((await db.select().from(schema.issuedClientCertificates)).map((row) => row.id)).toEqual([seeded.liveCert.id]);
    const assignments = await db.select().from(schema.mtlsCertificateRoles);
    expect(assignments.map((row) => [row.issuedClientCertificateId, row.mtlsRoleId])).toEqual([[seeded.liveCert.id, seeded.liveRole.id]]);

    // Idempotent.
    expect(await deleteOrphanedRows(db)).toEqual({ deleted: [], dangling: [], kept: [] });
  });

  it('keeps what a proxy host still uses, and reports it', async () => {
    const timestamp = now();
    const [list, unusedList] = await db.insert(schema.accessLists).values([
      { name: 'Used', createdAt: timestamp, updatedAt: timestamp },
      { name: 'Unused', createdAt: timestamp, updatedAt: timestamp },
    ]).returning();
    for (const accessList of [list, unusedList]) {
      await db.insert(schema.accessListEntries).values({
        accessListId: accessList.id, username: `member-${accessList.id}`, passwordHash: 'hash', createdAt: timestamp, updatedAt: timestamp,
      });
      await db.insert(schema.accessListRules).values({
        accessListId: accessList.id, position: 0, action: 'allow', kind: 'ip', matchValues: '["192.0.2.0/24"]', createdAt: timestamp, updatedAt: timestamp,
      });
    }
    const [certificate] = await db.insert(schema.certificates).values({
      name: 'Gone', type: 'imported', domainNames: '["app.example.com"]', createdAt: timestamp, updatedAt: timestamp,
    }).returning();
    const [host] = await db.insert(schema.proxyHosts).values({
      name: 'Protected', domains: '["app.example.com"]', upstreams: '["backend:80"]', accessListId: list.id, certificateId: certificate.id,
      createdAt: timestamp, updatedAt: timestamp,
    }).returning();
    // The access lists rework's predecessor deleted only the list row.
    await db.delete(schema.accessLists);
    await db.delete(schema.certificates);

    const report = await deleteOrphanedRows(db);

    // The host still applies the deleted list's members and rules: they stay, and so does the host's reference.
    expect((await db.select().from(schema.accessListEntries)).map((row) => row.accessListId)).toEqual([list.id]);
    expect((await db.select().from(schema.accessListRules)).map((row) => row.accessListId)).toEqual([list.id]);
    const [hostRow] = await db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, host.id));
    expect(hostRow).toMatchObject({ accessListId: list.id, certificateId: certificate.id });
    expect(report.dangling).toEqual([
      { reference: 'proxy_hosts.certificateId', rowIds: [host.id], parentIds: [certificate.id] },
      { reference: 'proxy_hosts.accessListId', rowIds: [host.id], parentIds: [list.id] },
    ]);
    expect(report.kept).toEqual([
      { reference: 'access_list_entries.accessListId', parentIds: [list.id] },
      { reference: 'access_list_rules.accessListId', parentIds: [list.id] },
    ]);
    expect(report.deleted).toEqual([
      { reference: 'access_list_entries.accessListId', rows: 1 },
      { reference: 'access_list_rules.accessListId', rows: 1 },
    ]);
  });
});
