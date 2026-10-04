/**
 * Fixtures for the multi-tenancy tests (ee/multi-tenancy): two organisations
 * (ALPHA and BRAVO) and the provider level, each with proxy hosts,
 * certificates, access lists, groups, users, forward-auth grants and sessions,
 * API tokens and audit events, stored directly. Every row of BRAVO carries the
 * word BRAVO and every provider-level row PROVIDER, so a leak shows up in any
 * response body.
 */
import { eq, isNull, or } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { TestDb } from './db';
import * as schema from '../../src/lib/db/schema';
import { insertRole, insertToken, nowIso } from './custom-roles';
import { PERMISSIONS } from '../../src/lib/permissions';
import { first, resyncIdentity } from '@/src/lib/db/ops';

export const ORG_A = 1;
export const ORG_B = 2;

export const PROVIDER_ADMIN = 1;
export const A_ADMIN = 2;
export const B_ADMIN = 3;
export const A_USER = 4;
export const B_USER = 5;
/** A user of ALPHA with a custom role holding every permission of the catalogue. */
export const A_EVERYTHING = 6;
export const PROVIDER_USER = 7;

export const ROLE_EVERYTHING = 1;

export type TenantTokens = Record<'provider' | 'aAdmin' | 'bAdmin' | 'aUser' | 'aEverything', string>;

export type TenantRows = {
  hosts: { a: number; b: number; p: number };
  certs: { a: number; b: number; p: number };
  lists: { a: number; b: number; p: number };
  entries: { a: number; b: number };
  groups: { a: number; b: number; p: number };
  sessions: { a: number; b: number };
  tokenIds: { aAdmin: number; bAdmin: number };
};

export async function insertOrganization(
  db: TestDb,
  id: number,
  name: string,
  values: Partial<typeof schema.organizations.$inferInsert> = {}
): Promise<number> {
  const now = nowIso();
  await db.insert(schema.organizations).values({
    id, name, slug: name.toLowerCase(), allowedUpstreams: '[]', createdAt: now, updatedAt: now, ...values,
  });
  // Explicit ids: the next generated one follows them (PostgreSQL).
  await resyncIdentity(schema.organizations, db);
  return id;
}

export async function insertTenantUser(
  db: TestDb,
  id: number,
  role: string,
  organizationId: number | null,
  customRoleId: number | null = null,
  label = `user${id}`
): Promise<number> {
  const now = nowIso();
  await db.insert(schema.users).values({
    id, email: `${label}@example.com`, name: label, role, customRoleId, organizationId, provider: 'credentials',
    subject: `${label}@example.com`, status: 'active', createdAt: now, updatedAt: now,
  });
  await resyncIdentity(schema.users, db);
  return id;
}

async function host(db: TestDb, name: string, domains: string[], organizationId: number | null, extra: Partial<typeof schema.proxyHosts.$inferInsert> = {}): Promise<number> {
  const now = nowIso();
  return (await first(db.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify(domains), upstreams: '["10.1.0.5:8080"]', organizationId,
    createdAt: now, updatedAt: now, ...extra,
  }).returning()))!.id;
}

async function certificate(db: TestDb, name: string, domains: string[], organizationId: number | null): Promise<number> {
  const now = nowIso();
  return (await first(db.insert(schema.certificates).values({
    name, type: 'managed', domainNames: JSON.stringify(domains), organizationId, createdAt: now, updatedAt: now,
  }).returning()))!.id;
}

async function accessList(db: TestDb, name: string, organizationId: number | null): Promise<{ list: number; entry: number }> {
  const now = nowIso();
  const list = (await first(db.insert(schema.accessLists).values({ name, organizationId, createdAt: now, updatedAt: now }).returning()))!.id;
  const entry = (await first(db.insert(schema.accessListEntries).values({
    accessListId: list, username: `${name.toLowerCase()}-member`, passwordHash: '$2b$10$abcdefghijklmnopqrstuuvwxyz0123456789ABCDEFGHIJKLMNOPQ', createdAt: now, updatedAt: now,
  }).returning()))!.id;
  return { list, entry };
}

async function group(db: TestDb, name: string, organizationId: number | null, members: number[]): Promise<number> {
  const now = nowIso();
  const id = (await first(db.insert(schema.groups).values({ name, organizationId, createdAt: now, updatedAt: now }).returning()))!.id;
  for (const userId of members) await db.insert(schema.groupMembers).values({ groupId: id, userId, createdAt: now });
  return id;
}

async function forwardAuthSession(db: TestDb, userId: number, proxyHostId: number, origin: string): Promise<number> {
  return (await first(db.insert(schema.forwardAuthSessions).values({
    userId, proxyHostId, audienceOrigin: origin, tokenHash: `hash-${userId}-${proxyHostId}`,
    expiresAt: '2099-01-01T00:00:00.000Z', createdAt: nowIso(),
  }).returning()))!.id;
}

/** Two organisations and the provider level, with a bit of everything in each. */
export async function seedTenants(db: TestDb): Promise<{ tokens: TenantTokens; rows: TenantRows }> {
  await insertOrganization(db, ORG_A, 'Alpha', { allowedUpstreams: JSON.stringify(['*.alpha.example.com', '10.1.0.0/16']) });
  await insertOrganization(db, ORG_B, 'BRAVO', { allowedUpstreams: JSON.stringify(['*']) });
  await insertRole(db, ROLE_EVERYTHING, [...PERMISSIONS], [], 'Everything');

  await insertTenantUser(db, PROVIDER_ADMIN, 'admin', null, null, 'provider-admin');
  await insertTenantUser(db, A_ADMIN, 'org_admin', ORG_A, null, 'alpha-admin');
  await insertTenantUser(db, B_ADMIN, 'org_admin', ORG_B, null, 'bravo-admin');
  await insertTenantUser(db, A_USER, 'user', ORG_A, null, 'alpha-user');
  await insertTenantUser(db, B_USER, 'user', ORG_B, null, 'bravo-user');
  await insertTenantUser(db, A_EVERYTHING, 'viewer', ORG_A, ROLE_EVERYTHING, 'alpha-everything');
  await insertTenantUser(db, PROVIDER_USER, 'user', null, null, 'provider-user');

  const tokens: TenantTokens = {
    provider: await insertToken(db, PROVIDER_ADMIN),
    aAdmin: await insertToken(db, A_ADMIN),
    bAdmin: await insertToken(db, B_ADMIN),
    aUser: await insertToken(db, A_USER),
    aEverything: await insertToken(db, A_EVERYTHING),
  };
  const tokenRows = await db.select().from(schema.apiTokens);

  const certs = {
    a: await certificate(db, 'Alpha cert', ['app.alpha.example.com'], ORG_A),
    b: await certificate(db, 'BRAVO cert', ['app.bravo.example.com'], ORG_B),
    p: await certificate(db, 'PROVIDER cert', ['app.provider.example.com'], null),
  };
  const lists = { a: await accessList(db, 'Alpha list', ORG_A), b: await accessList(db, 'BRAVO list', ORG_B), p: await accessList(db, 'PROVIDER list', null) };
  const hosts = {
    a: await host(db, 'Alpha app', ['app.alpha.example.com'], ORG_A, { certificateId: certs.a, accessListId: lists.a.list }),
    b: await host(db, 'BRAVO app', ['app.bravo.example.com'], ORG_B, { certificateId: certs.b, accessListId: lists.b.list }),
    p: await host(db, 'PROVIDER app', ['app.provider.example.com'], null, { certificateId: certs.p }),
  };
  const groups = {
    a: await group(db, 'Alpha staff', ORG_A, [A_USER]),
    b: await group(db, 'BRAVO staff', ORG_B, [B_USER]),
    p: await group(db, 'PROVIDER staff', null, [PROVIDER_USER]),
  };
  const now = nowIso();
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: hosts.a, groupId: groups.a, createdAt: now });
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: hosts.b, groupId: groups.b, createdAt: now });
  await db.insert(schema.forwardAuthAccess).values({ proxyHostId: hosts.p, groupId: groups.p, createdAt: now });
  const sessions = {
    a: await forwardAuthSession(db, A_USER, hosts.a, 'https://app.alpha.example.com'),
    b: await forwardAuthSession(db, B_USER, hosts.b, 'https://app.bravo.example.com'),
  };
  for (const [organizationId, summary] of [[ORG_A, 'Alpha event'], [ORG_B, 'BRAVO event'], [null, 'PROVIDER event']] as const) {
    await db.insert(schema.auditEvents).values({ action: 'note', entityType: 'test', summary, organizationId, createdAt: now });
  }

  return {
    tokens,
    rows: {
      hosts,
      certs,
      lists: { a: lists.a.list, b: lists.b.list, p: lists.p.list },
      entries: { a: lists.a.entry, b: lists.b.entry },
      groups,
      sessions,
      tokenIds: {
        aAdmin: tokenRows.find((row) => row.createdBy === A_ADMIN)!.id,
        bAdmin: tokenRows.find((row) => row.createdBy === B_ADMIN)!.id,
      },
    },
  };
}

/** Everything BRAVO owns (and the provider level), as stored: compared before and after an attack. */
export async function snapshotOutsideAlpha(db: TestDb): Promise<unknown> {
  const outside = (column: AnySQLiteColumn) => or(eq(column, ORG_B), isNull(column));
  return {
    hosts: await db.select().from(schema.proxyHosts).where(outside(schema.proxyHosts.organizationId)),
    certs: await db.select().from(schema.certificates).where(outside(schema.certificates.organizationId)),
    lists: await db.select().from(schema.accessLists).where(outside(schema.accessLists.organizationId)),
    entries: (await db.select().from(schema.accessListEntries)).filter((row) => row.accessListId !== 1),
    rules: (await db.select().from(schema.accessListRules)).filter((row) => row.accessListId !== 1),
    groups: await db.select().from(schema.groups).where(outside(schema.groups.organizationId)),
    members: await db.select().from(schema.groupMembers),
    users: await db.select().from(schema.users).where(outside(schema.users.organizationId)),
    grants: await db.select().from(schema.forwardAuthAccess),
    sessions: await db.select().from(schema.forwardAuthSessions),
    tokens: (await db.select().from(schema.apiTokens)).filter((row) => row.createdBy === B_ADMIN || row.createdBy === PROVIDER_ADMIN),
    organizations: await db.select().from(schema.organizations),
  };
}

/**
 * True when a response body mentions BRAVO's or the provider's rows (their
 * names, e-mail addresses and audit events). A domain the caller sent and the
 * answer repeats is not a leak, so domains are not matched.
 */
export function leaks(body: unknown): boolean {
  const text = JSON.stringify(body ?? null);
  return /BRAVO|bravo-admin|bravo-user|PROVIDER|provider-admin|provider-user/.test(text);
}
