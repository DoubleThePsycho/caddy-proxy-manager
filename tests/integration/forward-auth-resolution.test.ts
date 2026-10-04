/**
 * The forward-auth hot path (src/lib/models/forward-auth.ts):
 *
 * - Resolving a host name to its proxy host reads only the hosts whose
 *   domains can match it (a LIKE prefilter) instead of every enabled host.
 *   It must pick exactly the host the old full scan picked, whatever the
 *   stored domains look like (case, spaces, trailing dots, wildcards, exact
 *   hosts with and without forward auth, disabled hosts, bad JSON).
 * - The verify endpoint's decision (authorizeForwardAuthRequest) reads the
 *   user once and keeps the old answers: 401 for a missing or inactive user,
 *   403 without access (other organisation, disabled organisation, no
 *   grant), and the groups of the user's own organisation in membership
 *   order for the header.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc as drizzleAsc, eq } from 'drizzle-orm';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import * as schema from '@/src/lib/db/schema';
import { hostMatchesPattern } from '@/src/lib/host-pattern-priority';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

import {
  authorizeForwardAuthRequest,
  checkHostAccess,
  isForwardAuthDomain,
  resolveForwardAuthAudience,
} from '@/src/lib/models/forward-auth';

const now = () => new Date().toISOString();

beforeEach(async () => {
  db = createTestDb();
  await disableForeignKeys(db);
});

async function insertHost(domains: unknown, options: { forwardAuth?: boolean; enabled?: boolean; meta?: string | null; organizationId?: number | null } = {}) {
  const timestamp = now();
  const [host] = await db.insert(schema.proxyHosts).values({
    name: `Host ${JSON.stringify(domains)}`,
    domains: typeof domains === 'string' ? domains : JSON.stringify(domains),
    upstreams: JSON.stringify(['backend:8080']),
    enabled: options.enabled ?? true,
    meta: options.meta !== undefined ? options.meta : JSON.stringify({ cpm_forward_auth: { enabled: options.forwardAuth ?? true } }),
    organizationId: options.organizationId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }).returning();
  return host;
}

/** The resolution as it was: every enabled host, all columns, in id order. */
async function referenceResolve(host: string): Promise<number | null> {
  const hasForwardAuth = (meta: string | null) => {
    try {
      const parsed = meta ? JSON.parse(meta) : {};
      return !!(parsed && typeof parsed === 'object' && parsed.cpm_forward_auth?.enabled);
    } catch {
      return false;
    }
  };
  const all = await db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.enabled, true)).orderBy(drizzleAsc(schema.proxyHosts.id));
  let exact = false;
  let wildcard: (typeof all)[number] | null = null;
  for (const row of all) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.domains);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const domains = parsed.filter((d): d is string => typeof d === 'string');
    if (domains.some((d) => d.toLowerCase() === host.toLowerCase())) {
      exact = true;
      if (hasForwardAuth(row.meta)) return row.id;
      continue;
    }
    if (!wildcard && domains.some((d) => hostMatchesPattern(host, d))) wildcard = row;
  }
  if (!exact && wildcard) return hasForwardAuth(wildcard.meta) ? wildcard.id : null;
  return null;
}

describe('forward-auth host resolution', () => {
  it('picks the same host as a scan of every enabled host', async () => {
    await insertHost(['unrelated.example.org', 'other.example.org']);
    await insertHost(['*.example.com']);
    await insertHost(['App.Example.com']);
    await insertHost(['app.example.com'], { forwardAuth: false });
    await insertHost(['nofa.example.com'], { forwardAuth: false });
    await insertHost(['*.EXAMPLE.net.']);
    await insertHost(['  spaced.example.net  ']);
    await insertHost(['trailing.example.net.']);
    await insertHost(['*.deep.example.com'], { forwardAuth: false });
    await insertHost(['*.deep.example.com']);
    await insertHost(['disabled.example.com'], { enabled: false });
    await insertHost('not json');
    await insertHost('{"domains": "not an array"}');
    await insertHost([42, 'mixed.example.com']);
    await insertHost(['badmeta.example.com'], { meta: 'null' });
    await insertHost(['nometa.example.com'], { meta: null });
    await insertHost(['under_score%.example.com']);
    await insertHost(['localhost']);
    await insertHost(['192.0.2.10']);
    await insertHost(['*.example.org'], { forwardAuth: false });

    const names = [
      'app.example.com',
      'APP.example.com',
      'nofa.example.com',
      'x.example.com',
      'a.b.example.com',
      'x.deep.example.com',
      'deep.example.com',
      'foo.example.net',
      'spaced.example.net',
      'trailing.example.net',
      'trailing.example.net.',
      'app.example.com.',
      'disabled.example.com',
      'mixed.example.com',
      'badmeta.example.com',
      'nometa.example.com',
      'under_score%.example.com',
      'underxscore%.example.com',
      'localhost',
      '192.0.2.10',
      'unrelated.example.org',
      'other.example.org',
      'missing.example.test',
      'example.com',
      '*.example.com',
    ];
    for (const name of names) {
      const expected = await referenceResolve(name);
      expect({ name, forwardAuth: await isForwardAuthDomain(name) }).toEqual({ name, forwardAuth: expected !== null });
      // Through a URL, as the portal and the verify endpoint resolve (some names are not valid URL hosts).
      let parsedName: string;
      try {
        parsedName = new URL(`https://${name}/`).hostname;
      } catch {
        continue;
      }
      const audience = await resolveForwardAuthAudience(`https://${name}/`);
      expect({ name, id: audience?.proxyHostId ?? null }).toEqual({ name, id: await referenceResolve(parsedName) });
    }
  });

  it('prefers the lowest id among exact hosts with forward auth, and an exact host over a wildcard', async () => {
    const wildcard = await insertHost(['*.example.com']);
    const first = await insertHost(['shared.example.com']);
    await insertHost(['shared.example.com']);
    expect((await resolveForwardAuthAudience('https://shared.example.com/'))?.proxyHostId).toBe(first.id);
    expect((await resolveForwardAuthAudience('https://other.example.com/'))?.proxyHostId).toBe(wildcard.id);

    // An exact host without forward auth hides the wildcard host.
    await insertHost(['plain.example.com'], { forwardAuth: false });
    await expect(resolveForwardAuthAudience('https://plain.example.com/')).resolves.toBeNull();
  });

  it('never resolves a disabled host', async () => {
    const host = await insertHost(['app.example.com']);
    expect((await resolveForwardAuthAudience('https://app.example.com/'))?.proxyHostId).toBe(host.id);
    await db.update(schema.proxyHosts).set({ enabled: false }).where(eq(schema.proxyHosts.id, host.id));
    await expect(resolveForwardAuthAudience('https://app.example.com/')).resolves.toBeNull();
  });
});

describe('forward-auth verify decision', () => {
  async function insertOrganization(name: string, enabled = true) {
    const timestamp = now();
    const [organization] = await db.insert(schema.organizations).values({
      name, slug: name.toLowerCase(), enabled, createdAt: timestamp, updatedAt: timestamp,
    }).returning();
    return organization;
  }

  async function insertUser(email: string, options: { status?: string; organizationId?: number | null; username?: string | null } = {}) {
    const timestamp = now();
    const [user] = await db.insert(schema.users).values({
      email, name: email, role: 'user', provider: 'credentials', subject: email,
      status: options.status ?? 'active', organizationId: options.organizationId ?? null,
      username: options.username ?? null, createdAt: timestamp, updatedAt: timestamp,
    }).returning();
    return user;
  }

  async function insertGroup(name: string, organizationId: number | null = null) {
    const timestamp = now();
    const [group] = await db.insert(schema.groups).values({ name, organizationId, createdAt: timestamp, updatedAt: timestamp }).returning();
    return group;
  }

  async function addMember(groupId: number, userId: number) {
    await db.insert(schema.groupMembers).values({ groupId, userId, createdAt: now() });
  }

  async function grant(proxyHostId: number, grantee: { userId?: number; groupId?: number }) {
    await db.insert(schema.forwardAuthAccess).values({
      proxyHostId, userId: grantee.userId ?? null, groupId: grantee.groupId ?? null, createdAt: now(),
    });
  }

  it('answers 401 for a missing or inactive user, before looking at grants', async () => {
    const host = await insertHost(['app.example.com']);
    const disabled = await insertUser('disabled@example.com', { status: 'disabled' });
    await grant(host.id, { userId: disabled.id });

    await expect(authorizeForwardAuthRequest(disabled.id, host.id)).resolves.toEqual({ status: 401 });
    await expect(authorizeForwardAuthRequest(disabled.id + 100, host.id)).resolves.toEqual({ status: 401 });
    await expect(authorizeForwardAuthRequest(Number.NaN, host.id)).resolves.toEqual({ status: 401 });
  });

  it('answers 403 without a grant, and 200 with a direct or group grant', async () => {
    const host = await insertHost(['app.example.com']);
    const user = await insertUser('alice@example.com', { username: 'alice' });
    await expect(authorizeForwardAuthRequest(user.id, host.id)).resolves.toEqual({ status: 403 });
    expect(await checkHostAccess(user.id, host.id)).toBe(false);

    const later = await insertGroup('Later');
    const earlier = await insertGroup('Earlier');
    // Membership order, not the group's id or name, orders the header.
    await addMember(later.id, user.id);
    await addMember(earlier.id, user.id);
    await grant(host.id, { groupId: earlier.id });

    const verdict = await authorizeForwardAuthRequest(user.id, host.id);
    expect(verdict).toMatchObject({ status: 200, user: { id: user.id, email: 'alice@example.com', username: 'alice' } });
    expect(verdict.status === 200 && verdict.groups.map((group) => group.name)).toEqual(['Later', 'Earlier']);
    expect(await checkHostAccess(user.id, host.id)).toBe(true);

    await db.delete(schema.forwardAuthAccess);
    await grant(host.id, { userId: user.id });
    await expect(authorizeForwardAuthRequest(user.id, host.id)).resolves.toMatchObject({ status: 200 });
    // A grant on another host does not count.
    const other = await insertHost(['other.example.com']);
    await expect(authorizeForwardAuthRequest(user.id, other.id)).resolves.toEqual({ status: 403 });
    // Nor does a grant on a host that no longer exists.
    await db.delete(schema.proxyHosts).where(eq(schema.proxyHosts.id, host.id));
    await expect(authorizeForwardAuthRequest(user.id, host.id)).resolves.toEqual({ status: 403 });
  });

  it('keeps users to their own organisation, its groups and its enabled state', async () => {
    const alpha = await insertOrganization('Alpha');
    const beta = await insertOrganization('Beta');
    const alphaHost = await insertHost(['alpha.example.com'], { organizationId: alpha.id });
    const providerHost = await insertHost(['provider.example.com']);
    const alphaUser = await insertUser('a@example.com', { organizationId: alpha.id });
    const providerUser = await insertUser('p@example.com');

    // Groups of another organisation neither grant nor appear in the header.
    const betaGroup = await insertGroup('Beta staff', beta.id);
    const alphaGroup = await insertGroup('Alpha staff', alpha.id);
    await addMember(betaGroup.id, alphaUser.id);
    await addMember(alphaGroup.id, alphaUser.id);
    await grant(alphaHost.id, { groupId: betaGroup.id });
    await expect(authorizeForwardAuthRequest(alphaUser.id, alphaHost.id)).resolves.toEqual({ status: 403 });

    await grant(alphaHost.id, { groupId: alphaGroup.id });
    const verdict = await authorizeForwardAuthRequest(alphaUser.id, alphaHost.id);
    expect(verdict.status === 200 && verdict.groups.map((group) => group.name)).toEqual(['Alpha staff']);

    // A grant across organisations never lets anyone through.
    await grant(providerHost.id, { userId: alphaUser.id });
    await grant(alphaHost.id, { userId: providerUser.id });
    await expect(authorizeForwardAuthRequest(alphaUser.id, providerHost.id)).resolves.toEqual({ status: 403 });
    await expect(authorizeForwardAuthRequest(providerUser.id, alphaHost.id)).resolves.toEqual({ status: 403 });
    expect(await checkHostAccess(providerUser.id, alphaHost.id)).toBe(false);

    // A disabled (or deleted) organisation lets nobody through.
    await db.update(schema.organizations).set({ enabled: false }).where(eq(schema.organizations.id, alpha.id));
    await expect(authorizeForwardAuthRequest(alphaUser.id, alphaHost.id)).resolves.toEqual({ status: 403 });
    expect(await checkHostAccess(alphaUser.id, alphaHost.id)).toBe(false);
    await db.delete(schema.organizations).where(eq(schema.organizations.id, alpha.id));
    await expect(authorizeForwardAuthRequest(alphaUser.id, alphaHost.id)).resolves.toEqual({ status: 403 });
  });
});
