/**
 * The top-level `storage` block of the generated Caddy configuration
 * (ee/high-availability/caddy-storage.ts in buildCaddyDocument): absent for
 * local storage, the caddy.storage.redis module for every Redis mode, secrets
 * escaped or read from CADDY_STORAGE_* variables, the master's setting on a
 * slave, and a failed build instead of a silent fallback to local storage. Also the Caddy rejections the storage module can cause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';
import { encryptUnderOtherSecret } from '../helpers/encrypt-under-other-secret';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

// Keep the real buildCaddyDocument; stub only the network apply.
vi.mock('../../src/lib/caddy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/caddy')>();
  return { ...actual, applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }) };
});
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

// Settings before caddy (see the note on caddy unit tests).
import { setSetting } from '../../src/lib/settings';
import { encryptSecret } from '../../src/lib/secret';
import * as schema from '../../src/lib/db/schema';
import { buildCaddyDocument } from '../../src/lib/caddy';
import { describeCaddyRejection } from '../../src/lib/caddy-apply-error';
import { buildMigrationConfig, buildRedisStorageModule, escapeCaddyPlaceholders } from '@/ee/high-availability/caddy-storage';
import type { StoredRedisStorage } from '@/ee/high-availability/types';

const PASSWORD = 'p{a}ss\\{word}';

function redis(overrides: Partial<StoredRedisStorage> = {}): StoredRedisStorage {
  return {
    mode: 'standalone',
    addresses: ['valkey.example.com:6379'],
    db: 2,
    keyPrefix: 'caddy/eu',
    tls: { enabled: false, insecureSkipVerify: false },
    ...overrides,
  };
}

beforeEach(async () => {
  await ctx.db.delete(schema.settings);
  delete process.env.INSTANCE_MODE;
});

afterEach(() => {
  delete process.env.INSTANCE_MODE;
});

describe('buildCaddyDocument storage', () => {
  it('has no storage block for local storage', async () => {
    expect(await buildCaddyDocument()).not.toHaveProperty('storage');
    await setSetting('certificate_storage', { backend: 'local', redis: redis({ password: encryptSecret(PASSWORD) }) });
    expect(await buildCaddyDocument()).not.toHaveProperty('storage');
  });

  it('adds the redis module next to admin, logging and apps, with the password escaped for Caddy', async () => {
    await setSetting('certificate_storage', {
      backend: 'redis',
      redis: redis({ password: encryptSecret(PASSWORD), username: 'caddy', encryptionKeyEnv: 'CADDY_STORAGE_ENCRYPTION_KEY' }),
    });
    const document = await buildCaddyDocument();
    expect(Object.keys(document).slice(0, 3)).toEqual(['admin', 'storage', 'logging']);
    expect(document).toHaveProperty('apps');
    expect((document as { storage?: unknown }).storage).toEqual({
      module: 'redis',
      client_type: 'simple',
      address: ['valkey.example.com:6379'],
      db: 2,
      key_prefix: 'caddy/eu',
      timeout: '5',
      username: 'caddy',
      password: 'p\\{a\\}ss\\\\{word\\}',
      encryption_key: '{env.CADDY_STORAGE_ENCRYPTION_KEY}',
    });
  });

  it('uses the master\'s setting on a slave', async () => {
    process.env.INSTANCE_MODE = 'slave';
    await setSetting('synced:certificate_storage', { backend: 'redis', redis: redis({ passwordEnv: 'CADDY_STORAGE_PASSWORD' }) });
    const document = (await buildCaddyDocument()) as { storage?: Record<string, unknown> };
    expect(document.storage).toMatchObject({ module: 'redis', password: '{env.CADDY_STORAGE_PASSWORD}' });
  });

  it('fails the build rather than falling back to local storage', async () => {
    await setSetting('certificate_storage', { backend: 'redis', redis: redis({ password: encryptUnderOtherSecret(PASSWORD) }) });
    await expect(buildCaddyDocument()).rejects.toThrow(/cannot be decrypted/);
    await setSetting('certificate_storage', { backend: 'redis', redis: { ...redis(), addresses: ['not an address'] } });
    await expect(buildCaddyDocument()).rejects.toThrow(/Certificate storage: addresses\[0\]/);
  });
});

describe('buildRedisStorageModule', () => {
  it.each<[StoredRedisStorage, Record<string, unknown>]>([
    [
      redis({ mode: 'cluster', db: 0, addresses: ['a.example.com:6379', 'b.example.com:6379'] }),
      { client_type: 'cluster', address: ['a.example.com:6379', 'b.example.com:6379'], db: 0 },
    ],
    [
      redis({ mode: 'sentinel', addresses: ['s.example.com:26379'], masterName: 'certs', sentinelPassword: 'stored' }),
      { client_type: 'failover', master_name: 'certs', sentinel_password: 'secret:sentinelPassword' },
    ],
    [
      redis({ tls: { enabled: true, insecureSkipVerify: false, caPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n' } }),
      { tls_enabled: true, tls_insecure: false, tls_server_certs_pem: expect.stringContaining('BEGIN CERTIFICATE') },
    ],
  ])('renders %#', (stored, expected) => {
    const storage = buildRedisStorageModule(stored, (field) => `secret:${field}`);
    expect(storage).toMatchObject({ module: 'redis', timeout: '5', ...expected });
    if (!stored.tls.enabled) expect(storage).not.toHaveProperty('tls_enabled');
    if (stored.mode !== 'sentinel') expect(storage).not.toHaveProperty('master_name');
  });

  it('escapes braces the way Caddy\'s replacer reads them back', () => {
    expect(escapeCaddyPlaceholders('plain')).toBe('plain');
    expect(escapeCaddyPlaceholders('{env.X}')).toBe('\\{env.X\\}');
  });
});

describe('the migration config', () => {
  it('names variables for every secret and holds none', () => {
    const migration = buildMigrationConfig(
      redis({ password: encryptSecret(PASSWORD), encryptionKey: encryptSecret('k'.repeat(32)), sentinelPasswordEnv: undefined })
    );
    expect(migration.environment).toEqual(['CADDY_STORAGE_PASSWORD', 'CADDY_STORAGE_ENCRYPTION_KEY']);
    expect(migration.config.storage).toMatchObject({
      password: '{env.CADDY_STORAGE_PASSWORD}',
      encryption_key: '{env.CADDY_STORAGE_ENCRYPTION_KEY}',
    });
    expect(JSON.stringify(migration)).not.toMatch(/enc:v1:|kkkk|p\{a\}/);
    const fromEnv = buildMigrationConfig(redis({ passwordEnv: 'CADDY_STORAGE_VALKEY_PASSWORD' }));
    expect(fromEnv.environment).toEqual(['CADDY_STORAGE_VALKEY_PASSWORD']);
  });
});

describe('Caddy rejections caused by the storage module', () => {
  it.each([
    ['loading storage module: module not registered: caddy.storage.redis', /no Redis storage module/],
    ["loading storage module: loading module 'redis': provision caddy.storage.redis: WRONGPASS invalid username-password pair", /did not accept the user name or password/],
    ["loading storage module: loading module 'redis': provision caddy.storage.redis: invalid length for 'encryption_key', must contain at least 32 bytes", /encryption key is missing/],
    ["loading storage module: loading module 'redis': provision caddy.storage.redis: tls: failed to verify certificate: x509: certificate signed by unknown authority", /TLS connection/],
    ["loading storage module: loading module 'redis': provision caddy.storage.redis: dial tcp: lookup valkey on 127.0.0.11:53: no such host", /could not reach/],
    ["loading storage module: loading module 'redis': provision caddy.storage.redis: something else", /could not set up the certificate storage/],
  ])('explains %s', (body, reason) => {
    expect(describeCaddyRejection(JSON.stringify({ error: `loading config: ${body}` }))).toMatch(reason);
  });
});
