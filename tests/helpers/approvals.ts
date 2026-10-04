/**
 * Fixtures for the change approval tests (ee/approvals): users with custom
 * roles and API tokens, protected and unprotected hosts, and policies stored
 * directly (the REST endpoints have their own tests).
 */
import { eq } from 'drizzle-orm';
import type { TestDb } from './db';
import * as schema from '../../src/lib/db/schema';
import { insertRole, insertToken, insertUser, nowIso } from './custom-roles';
import { accessForUser } from '../../ee/custom-roles/access';
import type { Access } from '../../src/lib/permissions';
import { first } from '@/src/lib/db/ops';

export const ADMIN = 1;
/** Changes hosts and approves other people's changes. */
export const ALICE = 2;
/** Approver. */
export const BOB = 3;
/** Second approver. */
export const CAROL = 4;
/** Reads requests, cannot approve. */
export const DAVE = 5;
/** Approver limited to hosts tagged team-b. */
export const ERIN = 6;

export const ROLE_OPERATORS = 1;
export const ROLE_APPROVERS = 2;
export const ROLE_READERS = 3;
export const ROLE_TEAM_B = 4;

export const OPERATOR_PERMISSIONS = [
  'proxy_hosts:read', 'proxy_hosts:write', 'l4_proxy_hosts:read', 'l4_proxy_hosts:write',
  'users:read', 'groups:read', 'certificates:read', 'approvals:read', 'approvals:approve',
];
export const APPROVER_PERMISSIONS = ['proxy_hosts:read', 'l4_proxy_hosts:read', 'approvals:read', 'approvals:approve'];

export type Tokens = Record<'admin' | 'alice' | 'bob' | 'carol' | 'dave' | 'erin', string>;
export type Hosts = { prod: number; dev: number; teamB: number; l4prod: number; l4dev: number };

export async function proxyHost(db: TestDb, name: string, domains: string[], tags: string[]): Promise<number> {
  const now = nowIso();
  return (await first(db.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify(domains), upstreams: '["backend:8080"]', tags: JSON.stringify(tags), createdAt: now, updatedAt: now,
  }).returning()))!.id;
}

export async function l4Host(db: TestDb, name: string, listenAddress: string, tags: string[]): Promise<number> {
  const now = nowIso();
  return (await first(db.insert(schema.l4ProxyHosts).values({
    name, protocol: 'tcp', listenAddress, upstreams: '["db:5432"]', tags: JSON.stringify(tags), createdAt: now, updatedAt: now,
  }).returning()))!.id;
}

/** Users, roles and tokens, and a few hosts. */
export async function seedApprovals(db: TestDb): Promise<{ tokens: Tokens; hosts: Hosts }> {
  await insertRole(db, ROLE_OPERATORS, OPERATOR_PERMISSIONS, [], 'Operators');
  await insertRole(db, ROLE_APPROVERS, APPROVER_PERMISSIONS, [], 'Approvers');
  await insertRole(db, ROLE_READERS, ['proxy_hosts:read', 'approvals:read'], [], 'Readers');
  await insertRole(db, ROLE_TEAM_B, APPROVER_PERMISSIONS, ['team-b'], 'Team B approvers');
  await insertUser(db, ADMIN, 'admin');
  await insertUser(db, ALICE, 'viewer', ROLE_OPERATORS);
  await insertUser(db, BOB, 'viewer', ROLE_APPROVERS);
  await insertUser(db, CAROL, 'viewer', ROLE_APPROVERS);
  await insertUser(db, DAVE, 'viewer', ROLE_READERS);
  await insertUser(db, ERIN, 'viewer', ROLE_TEAM_B);
  const tokens: Tokens = {
    admin: await insertToken(db, ADMIN),
    alice: await insertToken(db, ALICE),
    bob: await insertToken(db, BOB),
    carol: await insertToken(db, CAROL),
    dave: await insertToken(db, DAVE),
    erin: await insertToken(db, ERIN),
  };
  const hosts: Hosts = {
    prod: await proxyHost(db, 'App', ['app.example.com'], ['prod']),
    dev: await proxyHost(db, 'Dev', ['dev.example.com'], ['dev']),
    teamB: await proxyHost(db, 'Team B', ['b.example.com'], ['prod', 'team-b']),
    l4prod: await l4Host(db, 'Database', ':5432', ['prod']),
    l4dev: await l4Host(db, 'Dev database', ':6432', ['dev']),
  };
  return { tokens, hosts };
}

/** Stores a policy directly; the defaults protect every change of hosts tagged prod with one approval. */
export async function insertPolicy(db: TestDb, overrides: Partial<typeof schema.approvalPolicies.$inferInsert> = {}): Promise<number> {
  const now = nowIso();
  return (await first(db.insert(schema.approvalPolicies).values({
    name: `Policy ${Math.random().toString(36).slice(2, 8)}`,
    hostTags: '["prod"]',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning()))!.id;
}

export async function accessOf(db: TestDb, userId: number): Promise<Access> {
  const user = (await first(db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)))!;
  return await accessForUser({ id: user.id, role: user.role, customRoleId: user.customRoleId }, db);
}

export async function hostRow(db: TestDb, id: number) {
  return await first(db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, id)).limit(1));
}

export async function l4Row(db: TestDb, id: number) {
  return await first(db.select().from(schema.l4ProxyHosts).where(eq(schema.l4ProxyHosts.id, id)).limit(1));
}

export async function requestRow(db: TestDb, id: number) {
  return await first(db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, id)).limit(1));
}
