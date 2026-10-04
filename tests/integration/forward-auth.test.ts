import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import {
  forwardAuthSessions,
  forwardAuthExchanges,
  forwardAuthAccess,
  forwardAuthRedirectIntents,
  groups,
  mtlsAccessRules,
  users,
  proxyHosts
} from '@/src/lib/db/schema';

let db: TestDb;

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));

import { deleteForwardAuthSession, getForwardAuthAccessForHost, setForwardAuthAccess } from '@/src/lib/models/forward-auth';
import { ApiValidationError } from '@/src/lib/api-errors';
import { deleteGroup } from '@/src/lib/models/groups';
import { deleteProxyHost } from '@/src/lib/models/proxy-hosts';
import { deleteUser } from '@/src/lib/models/user';

beforeEach(async () => {
  db = createTestDb();
  // As in production: SQLite runs with foreign keys off, PostgreSQL has none.
  await disableForeignKeys(db);
});

function nowIso() {
  return new Date().toISOString();
}

function futureIso(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function insertUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const now = nowIso();
  const [user] = await db.insert(users).values({
    email: `user${Math.random().toString(36).slice(2)}@localhost`,
    name: 'Test User',
    role: 'user',
    provider: 'credentials',
    subject: `test-${Date.now()}-${Math.random()}`,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning();
  return user;
}

async function insertProxyHost(overrides: Partial<typeof proxyHosts.$inferInsert> = {}) {
  const now = nowIso();
  const [host] = await db.insert(proxyHosts).values({
    name: 'Test Host',
    domains: JSON.stringify(['app.example.com']),
    upstreams: JSON.stringify(['backend:8080']),
    sslForced: true,
    hstsEnabled: true,
    hstsSubdomains: false,
    allowWebsocket: true,
    preserveHostHeader: true,
    skipHttpsHostnameValidation: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).returning();
  return host;
}

describe('forward auth sessions', () => {
  it('creates a session with hashed token', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const now = nowIso();

    const [session] = await db.insert(forwardAuthSessions).values({
      userId: user.id,
      proxyHostId: host.id,
      audienceOrigin: 'https://app.example.com',
      tokenHash,
      expiresAt: futureIso(3600),
      createdAt: now,
    }).returning();

    expect(session.tokenHash).toBe(tokenHash);
    expect(session.userId).toBe(user.id);
  });

  it('enforces unique token hashes', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const tokenHash = hashToken('same-token');
    const now = nowIso();

    await db.insert(forwardAuthSessions).values({
      userId: user.id, proxyHostId: host.id, audienceOrigin: 'https://app.example.com', tokenHash, expiresAt: futureIso(3600), createdAt: now,
    });

    await expect(
      db.insert(forwardAuthSessions).values({
        userId: user.id, proxyHostId: host.id, audienceOrigin: 'https://app.example.com', tokenHash, expiresAt: futureIso(3600), createdAt: now,
      })
    ).rejects.toThrow();
  });

  it('deleting a user deletes their sessions, without foreign keys', async () => {
    const user = await insertUser();
    const other = await insertUser();
    const host = await insertProxyHost();
    const now = nowIso();

    await db.insert(forwardAuthSessions).values([
      {
        userId: user.id,
        proxyHostId: host.id,
        audienceOrigin: 'https://app.example.com',
        tokenHash: hashToken('token1'),
        expiresAt: futureIso(3600),
        createdAt: now,
      },
      {
        userId: other.id,
        proxyHostId: host.id,
        audienceOrigin: 'https://app.example.com',
        tokenHash: hashToken('token2'),
        expiresAt: futureIso(3600),
        createdAt: now,
      },
    ]);

    await deleteUser(user.id);

    const sessions = await db.query.forwardAuthSessions.findMany();
    expect(sessions.map((session) => session.userId)).toEqual([other.id]);
  });
});

describe('forward auth exchanges', () => {
  it('creates an exchange code linked to a session', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const now = nowIso();

    const [session] = await db.insert(forwardAuthSessions).values({
      userId: user.id,
      proxyHostId: host.id,
      audienceOrigin: 'https://app.example.com',
      tokenHash: hashToken('session-token'),
      expiresAt: futureIso(3600),
      createdAt: now,
    }).returning();

    const rawCode = randomBytes(32).toString('hex');
    const [exchange] = await db.insert(forwardAuthExchanges).values({
      sessionId: session.id,
      proxyHostId: host.id,
      audienceOrigin: 'https://app.example.com',
      codeHash: hashToken(rawCode),
      sessionToken: 'raw-session-token',
      redirectUri: 'https://app.example.com/path',
      expiresAt: futureIso(60),
      used: false,
      createdAt: now,
    }).returning();

    expect(exchange.sessionId).toBe(session.id);
    expect(exchange.sessionToken).toBe('raw-session-token');
    expect(exchange.used).toBe(false);
  });

  it('deleting a session deletes its exchange codes, without foreign keys', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const now = nowIso();

    const [session] = await db.insert(forwardAuthSessions).values({
      userId: user.id,
      proxyHostId: host.id,
      audienceOrigin: 'https://app.example.com',
      tokenHash: hashToken('session2'),
      expiresAt: futureIso(3600),
      createdAt: now,
    }).returning();

    await db.insert(forwardAuthExchanges).values({
      sessionId: session.id,
      proxyHostId: host.id,
      audienceOrigin: 'https://app.example.com',
      codeHash: hashToken('code1'),
      sessionToken: 'raw-token',
      redirectUri: 'https://app.example.com/',
      expiresAt: futureIso(60),
      used: false,
      createdAt: now,
    });

    await deleteForwardAuthSession(session.id);

    expect(await db.query.forwardAuthSessions.findMany()).toHaveLength(0);
    const exchanges = await db.query.forwardAuthExchanges.findMany();
    expect(exchanges).toHaveLength(0);
  });
});

describe('forward auth access', () => {
  it('creates user-level access for a proxy host', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const now = nowIso();

    const [access] = await db.insert(forwardAuthAccess).values({
      proxyHostId: host.id,
      userId: user.id,
      groupId: null,
      createdAt: now,
    }).returning();

    expect(access.proxyHostId).toBe(host.id);
    expect(access.userId).toBe(user.id);
    expect(access.groupId).toBeNull();
  });

  it('creates group-level access for a proxy host', async () => {
    const host = await insertProxyHost();
    const now = nowIso();

    const [group] = await db.insert(groups).values({
      name: 'Devs',
      createdAt: now,
      updatedAt: now,
    }).returning();

    const [access] = await db.insert(forwardAuthAccess).values({
      proxyHostId: host.id,
      userId: null,
      groupId: group.id,
      createdAt: now,
    }).returning();

    expect(access.groupId).toBe(group.id);
    expect(access.userId).toBeNull();
  });

  it('prevents duplicate user access per host', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const now = nowIso();

    await db.insert(forwardAuthAccess).values({
      proxyHostId: host.id, userId: user.id, groupId: null, createdAt: now,
    });

    await expect(
      db.insert(forwardAuthAccess).values({
        proxyHostId: host.id, userId: user.id, groupId: null, createdAt: now,
      })
    ).rejects.toThrow();
  });

  it('deleting a proxy host deletes its grants, sign-in state and mTLS path rules, without foreign keys', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const kept = await insertProxyHost({ name: 'Kept', domains: JSON.stringify(['kept.example.com']) });
    const now = nowIso();

    for (const proxyHost of [host, kept]) {
      const origin = `https://${JSON.parse(proxyHost.domains)[0]}`;
      await db.insert(forwardAuthAccess).values({
        proxyHostId: proxyHost.id, userId: user.id, groupId: null, createdAt: now,
      });
      const [session] = await db.insert(forwardAuthSessions).values({
        userId: user.id, proxyHostId: proxyHost.id, audienceOrigin: origin,
        tokenHash: hashToken(`session-${proxyHost.id}`), expiresAt: futureIso(3600), createdAt: now,
      }).returning();
      await db.insert(forwardAuthExchanges).values({
        sessionId: session.id, proxyHostId: proxyHost.id, audienceOrigin: origin,
        codeHash: hashToken(`code-${proxyHost.id}`), sessionToken: '[pending]', redirectUri: `${origin}/`,
        expiresAt: futureIso(60), used: false, createdAt: now,
      });
      await db.insert(forwardAuthRedirectIntents).values({
        ridHash: hashToken(`rid-${proxyHost.id}`), proxyHostId: proxyHost.id, audienceOrigin: origin,
        redirectUri: `${origin}/`, expiresAt: futureIso(600), consumed: false, createdAt: now,
      });
      await db.insert(mtlsAccessRules).values({
        proxyHostId: proxyHost.id, pathPattern: '/admin/*', createdAt: now, updatedAt: now,
      });
    }

    await deleteProxyHost(host.id, user.id);

    for (const table of [forwardAuthAccess, forwardAuthSessions, forwardAuthExchanges, forwardAuthRedirectIntents, mtlsAccessRules]) {
      const rows = await db.select({ proxyHostId: table.proxyHostId }).from(table);
      expect(rows.map((row) => row.proxyHostId)).toEqual([kept.id]);
    }
  });

  it('deleting a group deletes its grants, without foreign keys', async () => {
    const host = await insertProxyHost();
    const user = await insertUser();
    const now = nowIso();

    const [group] = await db.insert(groups).values({
      name: 'Team', createdAt: now, updatedAt: now,
    }).returning();

    await db.insert(forwardAuthAccess).values([
      { proxyHostId: host.id, userId: null, groupId: group.id, createdAt: now },
      { proxyHostId: host.id, userId: user.id, groupId: null, createdAt: now },
    ]);

    await deleteGroup(group.id, user.id);

    const access = await db.query.forwardAuthAccess.findMany();
    expect(access.map((entry) => entry.userId)).toEqual([user.id]);
  });

  it('allows both user and group access on same host', async () => {
    const user = await insertUser();
    const host = await insertProxyHost();
    const now = nowIso();

    const [group] = await db.insert(groups).values({
      name: 'Group', createdAt: now, updatedAt: now,
    }).returning();

    await db.insert(forwardAuthAccess).values([
      { proxyHostId: host.id, userId: user.id, groupId: null, createdAt: now },
      { proxyHostId: host.id, userId: null, groupId: group.id, createdAt: now },
    ]);

    const access = await db.query.forwardAuthAccess.findMany({
      where: (t, { eq }) => eq(t.proxyHostId, host.id),
    });
    expect(access).toHaveLength(2);
  });
});

describe('setForwardAuthAccess', () => {
  it('stores each existing user and group once and leaves out ids nobody has', async () => {
    const host = await insertProxyHost();
    const user = await insertUser();
    const now = nowIso();
    const [group] = await db.insert(groups).values({ name: 'Team', createdAt: now, updatedAt: now }).returning();
    // The ids the next user and group would get.
    const futureUser = user.id + 1;
    const futureGroup = group.id + 1;

    const entries = await setForwardAuthAccess(
      host.id,
      { userIds: [user.id, user.id, futureUser], groupIds: [group.id, futureGroup, group.id] },
      user.id
    );

    expect(entries.map((entry) => [entry.userId, entry.groupId])).toEqual([[user.id, null], [null, group.id]]);
  });

  it('refuses ids that are not whole numbers, leaving the grants as they were', async () => {
    const host = await insertProxyHost();
    const user = await insertUser();
    await setForwardAuthAccess(host.id, { userIds: [user.id] }, user.id);

    for (const userIds of [[1.5], [-1], ['abc'], 'nope', [null]]) {
      await expect(setForwardAuthAccess(host.id, { userIds: userIds as never }, user.id)).rejects.toBeInstanceOf(ApiValidationError);
    }
    expect((await getForwardAuthAccessForHost(host.id)).map((entry) => entry.userId)).toEqual([user.id]);

    // Digits as text name the same user, as SQLite used to read them.
    await setForwardAuthAccess(host.id, { userIds: [String(user.id)] as never }, user.id);
    expect((await getForwardAuthAccessForHost(host.id)).map((entry) => entry.userId)).toEqual([user.id]);
  });
});
