/**
 * Starting the server never changes a stored username, including ones the
 * login page cannot use (an email with a '+', a mixed-case username) and
 * missing ones. Only an administrator sets a username for those accounts.
 * It only warns about usernames to check: one that reaches another account
 * too, and one that is an email address other than the account's own (such
 * as alice-ingressi@example.com on the account alice+ingressi@example.com).
 *
 * The database is one the server has started on before: the one-time data
 * migrations of src/lib/db/startup.ts have run and recorded it. They run on
 * PostgreSQL here (an in-memory SQLite database skips them); the one that
 * gave accounts without a username their own email address once, on the
 * upgrade to Better Auth, is tested on its own (db-legacy-usernames, and
 * below on PostgreSQL).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';
import { accounts, settings, users } from '../../src/lib/db/schema';
import { CREDENTIAL_ACCOUNT_ISSUER } from '../../src/lib/account-issuer';

let db: TestDb;

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db, {
  purgeDeletedDatabaseContent: () => false,
}));
vi.mock('../../src/lib/config', () => ({ validateProductionConfig: () => {} }));
// The values requests read from memory (src/lib/db/cached-value.ts) are not loaded here.
vi.mock('../../src/lib/startup-caches', () => ({ loadStartupCaches: async () => {} }));
vi.mock('../../src/lib/init-db', () => ({ ensureAdminUser: async () => {} }));
vi.mock('../../src/lib/models/certificates', () => ({ migrateLegacyCertificateStorage: async () => 0 }));
vi.mock('../../src/lib/models/ca-certificates', () => ({ migrateLegacyCaPrivateKeys: async () => 0 }));
vi.mock('../../src/lib/secret-rotation', () => ({
  reencryptStoredSecrets: async () => ({ reencrypted: 0, encryptedPlaintext: 0, failed: 0, clearedOAuthTokens: 0 }),
}));
vi.mock('../../src/lib/caddy', () => ({ applyCaddyConfig: async () => {} }));
vi.mock('../../src/lib/caddy-monitor', () => ({ startCaddyMonitoring: () => {} }));
vi.mock('../../src/lib/clickhouse/client', () => ({ initClickHouse: async () => {}, closeClickHouse: () => {} }));
// Failing parser start-up keeps register() from installing intervals and SIGTERM handlers.
vi.mock('../../src/lib/log-parser', () => ({
  initLogParser: async () => { throw new Error('not in tests'); },
  parseNewLogEntries: async () => {},
  stopLogParser: () => {},
}));
vi.mock('../../src/lib/waf-log-parser', () => ({
  initWafLogParser: async () => { throw new Error('not in tests'); },
  parseNewWafLogEntries: async () => {},
  stopWafLogParser: () => {},
}));
vi.mock('../../src/lib/instance-sync', () => ({
  getInstanceMode: async () => 'standalone',
  getSyncIntervalMs: () => 0,
  runPeriodicInstanceSync: async () => null,
}));

import { register } from '../../src/instrumentation';
import { stopBackgroundJobs } from '../../src/lib/background-jobs';
import { first } from '@/src/lib/db/ops';

const NOW = '2026-02-01T00:00:00.000Z';

async function seedCredentialUser(email: string, username: string | null) {
  const user = (await first(db.insert(users).values({
    email,
    username,
    displayUsername: username,
    name: null,
    passwordHash: 'hash',
    role: 'user',
    provider: 'credentials',
    subject: email,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  }).returning()))!;
  await db.insert(accounts).values({
    userId: user.id,
    issuer: CREDENTIAL_ACCOUNT_ISSUER,
    accountId: String(user.id),
    providerId: 'credential',
    password: 'hash',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return user.id;
}

/** The flags the one-time data migrations leave (src/lib/db/startup.ts): a server started here before. */
async function markStartedBefore() {
  for (const key of ['better_auth_migrated', 'dns_provider_migrated', 'oauth_identity_sync_repaired']) {
    await db.insert(settings).values({ key, value: 'true', updatedAt: NOW });
  }
}

async function usernameColumns() {
  return await db.select({
    email: users.email,
    username: users.username,
    displayUsername: users.displayUsername,
    updatedAt: users.updatedAt,
  }).from(users).orderBy(users.id);
}

describe('instrumentation and sign-in usernames', () => {
  const originalRuntime = process.env.NEXT_RUNTIME;

  beforeEach(async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    // On PostgreSQL the server starts as a replica (src/lib/background-jobs.ts): its id, not one in ./data.
    vi.stubEnv('INGRESSI_NODE_ID', 'instrumentation-test');
    db = createTestDb();
    await markStartedBefore();
  });

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // On PostgreSQL: the replica's leader election connection and heartbeat.
  afterAll(async () => {
    await stopBackgroundJobs();
  });

  it('leaves every stored username as it is on startup', async () => {
    await seedCredentialUser('alice+ingressi@example.com', 'alice+ingressi@example.com');
    await seedCredentialUser('bob@example.com', 'Bob');
    await seedCredentialUser('carol+x@example.com', null);
    await seedCredentialUser('dave@example.com', null);
    await seedCredentialUser('erin@example.com', 'erin');
    const before = await usernameColumns();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await register();

    expect(await usernameColumns()).toEqual(before);
    expect(log.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).not.toMatch(/sign-in username/i);
  });

  it('does not warn about an email-shaped username that is the account\'s own portal name', async () => {
    await seedCredentialUser('admin@example.com@localhost', 'admin@example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await register();

    const warnings = warn.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => /sign-in username/i.test(line));
    expect(warnings).toEqual([]);
  });

  it('warns about usernames to check without changing them', async () => {
    const derived = await seedCredentialUser('alice+ingressi@example.com', 'alice-ingressi@example.com');
    const shared = await seedCredentialUser('anna@example.com', 'bob@example.com');
    await seedCredentialUser('bob@example.com', null);
    const portal = await seedCredentialUser('erin@example.com', 'ops');
    await seedCredentialUser('ops@localhost', 'ops@localhost');
    await seedCredentialUser('carol@example.com', 'carol@example.com');
    await seedCredentialUser('dave@example.com', 'dave');
    await seedCredentialUser('Fay@Example.com', 'fay@example.com');
    const before = await usernameColumns();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await register();

    expect(await usernameColumns()).toEqual(before);
    const warnings = warn.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => /sign-in username/i.test(line));
    expect(warnings).toEqual([
      expect.stringMatching(new RegExp(`^Sign-in username "alice-ingressi@example.com" of user ${derived} is an email address other than the account's own`)),
      expect.stringMatching(new RegExp(`^Sign-in username "bob@example.com" of user ${shared} is also another account's username, email address or forward-auth portal name`)),
      expect.stringMatching(new RegExp(`^Sign-in username "ops" of user ${portal} is also another account's`)),
    ]);
  });

  it.runIf(testDbIsPostgres())('gives accounts without a username their own email address once, on a database the Better Auth data migration never ran on', async () => {
    await db.delete(settings).where(eq(settings.key, 'better_auth_migrated'));
    const usable = await seedCredentialUser('dave@example.com', null);
    const unusable = await seedCredentialUser('carol+x@example.com', null);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await register();

    const after = new Map((await db.select({ id: users.id, username: users.username }).from(users)).map((row) => [row.id, row.username]));
    expect(after.get(usable)).toBe('dave@example.com');
    expect(after.get(unusable)).toBeNull();
    const before = await usernameColumns();
    await register();
    expect(await usernameColumns()).toEqual(before);
  });
});
