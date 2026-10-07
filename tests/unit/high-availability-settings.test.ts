/**
 * Certificate storage settings (ee/high-availability/settings.ts): input
 * validation, the secret rules (stored encrypted, kept, removed, read from a
 * CADDY_STORAGE_* variable, re-entered when the destination changes), parsing
 * of stored values and comparing two settings.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createSelfSignedServerCertificate } from '../helpers/certs';
import { encryptUnderOtherSecret } from '../helpers/encrypt-under-other-secret';
import { ApiValidationError } from '@/src/lib/api-errors';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '@/src/lib/secret';
import {
  CertificateStorageSettingError,
  encryptCertificateStorageSecrets,
  parseCertificateStorageInput,
  parseRedisStorageInput,
  parseStorageAddress,
  parseStoredCertificateStorage,
  sameCertificateStorage,
  storageSecretChanged,
  toRedisStorageView,
} from '@/ee/high-availability/settings';
import type { StoredCertificateStorage, StoredRedisStorage } from '@/ee/high-availability/types';

const PASSWORD = 'redis-password-sentinel-value';
const KEY = 'an-encryption-key-of-at-least-32-bytes!';

let caPem: string;
beforeAll(() => {
  caPem = createSelfSignedServerCertificate('valkey.example.com', ['valkey.example.com']).certificatePem;
});

function stored(overrides: Partial<StoredRedisStorage> = {}): StoredRedisStorage {
  return {
    mode: 'standalone',
    addresses: ['valkey.example.com:6379'],
    db: 0,
    keyPrefix: 'caddy',
    tls: { enabled: false, insecureSkipVerify: false },
    ...overrides,
  };
}

const local: StoredCertificateStorage = { backend: 'local', redis: null };

describe('parseStorageAddress', () => {
  it.each([
    ['valkey.example.com:6379', 'valkey.example.com:6379'],
    ['  Valkey.Example.COM:6380 ', 'valkey.example.com:6380'],
    ['10.0.0.5:6379', '10.0.0.5:6379'],
    ['[2001:DB8::10]:6379', '[2001:db8::10]:6379'],
    ['redis_primary:6379', 'redis_primary:6379'],
  ])('accepts %s', (input, expected) => {
    expect(parseStorageAddress(input)).toBe(expected);
  });

  it.each([
    'valkey.example.com',
    'valkey.example.com:0',
    'valkey.example.com:65536',
    '2001:db8::10:6379',
    '{env.HOST}:6379',
    'valkey example.com:6379',
    ':6379',
    '[not-ipv6]:6379',
    'redis://valkey.example.com:6379',
  ])('refuses %s', (input) => {
    expect(() => parseStorageAddress(input)).toThrow(ApiValidationError);
  });
});

describe('parseRedisStorageInput', () => {
  it('fills defaults and encrypts the secrets it stores', () => {
    const redis = parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], password: PASSWORD, encryptionKey: KEY }, null);
    expect(redis).toMatchObject({ mode: 'standalone', db: 0, keyPrefix: 'caddy', tls: { enabled: false, insecureSkipVerify: false } });
    expect(isEncryptedSecret(redis.password!)).toBe(true);
    expect(decryptSecret(redis.password!)).toBe(PASSWORD);
    expect(decryptSecret(redis.encryptionKey!)).toBe(KEY);
    expect(JSON.stringify(redis)).not.toContain(PASSWORD);
  });

  it('keeps a password exactly as typed, spaces and braces included', () => {
    const redis = parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], password: ' p{a}ss\\{word} ' }, null);
    expect(decryptSecret(redis.password!)).toBe(' p{a}ss\\{word} ');
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['several servers in standalone mode', { addresses: ['a.example.com:6379', 'b.example.com:6379'] }, /exactly one address/],
    ['no address', { addresses: [] }, /at least one/],
    ['a sentinel without master name', { mode: 'sentinel', addresses: ['s.example.com:26379'] }, /masterName is required/],
    ['a master name outside sentinel mode', { addresses: ['a.example.com:6379'], masterName: 'certs' }, /only used in Sentinel/],
    ['another database in cluster mode', { mode: 'cluster', addresses: ['a.example.com:6379'], db: 1 }, /only has database 0/],
    ['a database out of range', { addresses: ['a.example.com:6379'], db: 300 }, /db must be/],
    ['a key prefix with a dot segment', { addresses: ['a.example.com:6379'], keyPrefix: 'caddy/../x' }, /keyPrefix/],
    ['a key prefix with braces', { addresses: ['a.example.com:6379'], keyPrefix: '{env.X}' }, /keyPrefix/],
    ['a short encryption key', { addresses: ['a.example.com:6379'], encryptionKey: 'short' }, /at least 32 bytes/],
    ['a variable without the prefix', { addresses: ['a.example.com:6379'], passwordEnv: 'SESSION_SECRET' }, /CADDY_STORAGE_/],
    ['a value and a variable', { addresses: ['a.example.com:6379'], password: 'x', passwordEnv: 'CADDY_STORAGE_PASSWORD' }, /either password or passwordEnv/],
    ['a Sentinel password outside sentinel mode', { addresses: ['a.example.com:6379'], sentinelPassword: 'x' }, /only used in Sentinel/],
    ['an unknown field', { addresses: ['a.example.com:6379'], host: 'x' }, /Unknown field "host"/],
    ['a user name with braces', { addresses: ['a.example.com:6379'], username: '{env.USER}' }, /username/],
    ['TLS options without TLS', { addresses: ['a.example.com:6379'], tls: { insecureSkipVerify: true } }, /need tls.enabled/],
    ['a CA certificate and no verification', { addresses: ['a.example.com:6379'], tls: { enabled: true, insecureSkipVerify: true, caPem: 'x' } }, /tls.caPem/],
    ['a private key as CA', { addresses: ['a.example.com:6379'], tls: { enabled: true, caPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' } }, /only PEM certificates/],
  ])('refuses %s', (_name, input, message) => {
    expect(() => parseRedisStorageInput(input, null)).toThrow(message);
  });

  it('accepts real CA certificates and TLS settings', () => {
    const redis = parseRedisStorageInput({ addresses: ['a.example.com:6380'], tls: { enabled: true, caPem } }, null);
    expect(redis.tls).toEqual({ enabled: true, insecureSkipVerify: false, caPem: expect.stringContaining('BEGIN CERTIFICATE') });
    expect(() => parseRedisStorageInput({ addresses: ['a.example.com:6380'], tls: { enabled: true, caPem: caPem.replace(/[A-Za-z]{20}/, 'x') } }, null)).toThrow();
  });

  it('keeps, removes and replaces secrets', () => {
    const previous = parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], password: PASSWORD, encryptionKey: KEY }, null);
    const kept = parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], password: '', keyPrefix: 'other' }, previous);
    expect(kept.password).toBe(previous.password);
    expect(kept.encryptionKey).toBe(previous.encryptionKey);
    expect(kept.keyPrefix).toBe('other');

    const removed = parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], password: null, encryptionKey: null }, previous);
    expect(removed.password).toBeUndefined();
    expect(removed.encryptionKey).toBeUndefined();

    const fromEnv = parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], passwordEnv: 'CADDY_STORAGE_PASSWORD' }, previous);
    expect(fromEnv.password).toBeUndefined();
    expect(fromEnv.passwordEnv).toBe('CADDY_STORAGE_PASSWORD');
    // The variable stays until it is replaced or cleared.
    expect(parseRedisStorageInput({ addresses: ['valkey.example.com:6379'] }, fromEnv).passwordEnv).toBe('CADDY_STORAGE_PASSWORD');
    expect(parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], passwordEnv: null }, fromEnv).passwordEnv).toBeUndefined();
  });

  it('asks for the password again when it would go to another server, but keeps the encryption key', () => {
    const previous = parseRedisStorageInput({ addresses: ['valkey.example.com:6379'], password: PASSWORD, encryptionKey: KEY }, null);
    for (const change of [
      { addresses: ['attacker.example.org:6379'] },
      { addresses: ['valkey.example.com:6379'], tls: { enabled: true } },
      { mode: 'cluster', addresses: ['valkey.example.com:6379'] },
    ]) {
      expect(() => parseRedisStorageInput(change, previous)).toThrow(/Enter the password again/);
    }
    const moved = parseRedisStorageInput({ addresses: ['valkey-2.example.com:6379'], password: null }, previous);
    expect(moved.encryptionKey).toBe(previous.encryptionKey);
    const reentered = parseRedisStorageInput({ addresses: ['valkey-2.example.com:6379'], password: 'new-password' }, previous);
    expect(decryptSecret(reentered.password!)).toBe('new-password');
    // The order of the addresses is not a different destination.
    const cluster = parseRedisStorageInput({ mode: 'cluster', addresses: ['a.example.com:6379', 'b.example.com:6379'], password: PASSWORD }, null);
    expect(parseRedisStorageInput({ mode: 'cluster', addresses: ['b.example.com:6379', 'a.example.com:6379'] }, cluster).password).toBe(cluster.password);
  });

  it('drops a kept Sentinel password when leaving sentinel mode', () => {
    const sentinel = parseRedisStorageInput(
      { mode: 'sentinel', addresses: ['s.example.com:26379'], masterName: 'certs', sentinelPassword: 'sentinel-secret' },
      null
    );
    expect(decryptSecret(sentinel.sentinelPassword!)).toBe('sentinel-secret');
    expect(parseRedisStorageInput({ addresses: ['m.example.com:6379'] }, sentinel).sentinelPassword).toBeUndefined();
  });
});

describe('parseCertificateStorageInput', () => {
  const redis = { addresses: ['valkey.example.com:6379'], password: PASSWORD };

  it('switches backends and keeps or removes the Redis settings', () => {
    const enabled = parseCertificateStorageInput({ backend: 'redis', redis }, null);
    expect(enabled.backend).toBe('redis');
    const local = parseCertificateStorageInput({ backend: 'local' }, enabled);
    expect(local).toEqual({ backend: 'local', redis: enabled.redis });
    expect(parseCertificateStorageInput({ backend: 'local', redis: null }, enabled)).toEqual({ backend: 'local', redis: null });
    expect(parseCertificateStorageInput({ redis }, null).backend).toBe('redis');
    expect(parseCertificateStorageInput({}, null)).toEqual({ backend: 'local', redis: null });
  });

  it('refuses the redis backend without Redis settings and unknown fields', () => {
    expect(() => parseCertificateStorageInput({ backend: 'redis' }, null)).toThrow(/Configure redis/);
    expect(() => parseCertificateStorageInput({ backend: 's3' }, null)).toThrow(/backend must be one of/);
    expect(() => parseCertificateStorageInput({ backend: 'local', extra: 1 }, null)).toThrow(/Unknown field/);
    expect(() => parseCertificateStorageInput([], null)).toThrow(/JSON object/);
  });
});

describe('parseStoredCertificateStorage', () => {
  it('reads stored, synced and imported values', () => {
    expect(parseStoredCertificateStorage(null)).toBeNull();
    const value = { backend: 'redis', redis: stored({ password: encryptSecret(PASSWORD), encryptionKeyEnv: 'CADDY_STORAGE_KEY' }) };
    expect(parseStoredCertificateStorage(value)).toEqual(value);
    // Plaintext from an older master's payload or a hand-made import is accepted (and encrypted on write).
    expect(parseStoredCertificateStorage({ backend: 'redis', redis: stored({ password: PASSWORD }) })?.redis?.password).toBe(PASSWORD);
  });

  it.each<[string, unknown]>([
    ['not an object', 'redis'],
    ['an unknown backend', { backend: 's3', redis: null }],
    ['redis without settings', { backend: 'redis', redis: null }],
    ['an invalid address', { backend: 'redis', redis: stored({ addresses: ['nope'] }) }],
    ['a secret and its variable', { backend: 'redis', redis: stored({ password: 'x', passwordEnv: 'CADDY_STORAGE_PASSWORD' }) }],
    ['a variable without the prefix', { backend: 'redis', redis: stored({ passwordEnv: 'HOME' }) }],
    ['a missing key prefix', { backend: 'redis', redis: { ...stored(), keyPrefix: '' } }],
    ['a short plaintext encryption key', { backend: 'local', redis: stored({ encryptionKey: 'short' }) }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseStoredCertificateStorage(value)).toThrow(CertificateStorageSettingError);
  });
});

describe('comparing two settings', () => {
  const redis = stored({ password: encryptSecret(PASSWORD) });
  const enabled: StoredCertificateStorage = { backend: 'redis', redis };

  it('tells a change from the same setting', () => {
    expect(sameCertificateStorage(enabled, enabled)).toBe(true);
    // The same secret encrypted again is the same secret.
    expect(sameCertificateStorage(enabled, { backend: 'redis', redis: { ...redis, password: encryptSecret(PASSWORD) } })).toBe(true);
    // Never set and local without Redis settings are the same.
    expect(sameCertificateStorage(null, local)).toBe(true);
    expect(sameCertificateStorage(null, enabled)).toBe(false);
    expect(sameCertificateStorage(enabled, { backend: 'local', redis })).toBe(false);
    expect(sameCertificateStorage(enabled, { backend: 'redis', redis: { ...redis, keyPrefix: 'other' } })).toBe(false);
    expect(sameCertificateStorage({ backend: 'local', redis }, { backend: 'local', redis: { ...redis, db: 1 } })).toBe(false);
  });

  it('tells secrets apart without showing them', () => {
    expect(sameCertificateStorage(enabled, { backend: 'redis', redis: { ...redis, password: encryptSecret('other') } })).toBe(false);
    expect(storageSecretChanged(redis, { ...redis, password: encryptSecret(PASSWORD) }, 'password')).toBe(false);
    expect(storageSecretChanged(redis, { ...redis, password: undefined, passwordEnv: 'CADDY_STORAGE_PASSWORD' }, 'password')).toBe(true);
    // A value no key decrypts compares as stored.
    const foreign = encryptUnderOtherSecret(PASSWORD);
    expect(sameCertificateStorage({ backend: 'redis', redis: { ...redis, password: foreign } }, { backend: 'redis', redis: { ...redis, password: foreign } })).toBe(true);
  });
});

describe('secrets at rest and in views', () => {
  it('encrypts plaintext secrets and leaves everything else alone', () => {
    const value = { backend: 'redis', redis: stored({ password: PASSWORD, sentinelPassword: undefined, encryptionKey: encryptSecret(KEY) }) };
    const encrypted = encryptCertificateStorageSecrets(value) as { redis: StoredRedisStorage };
    expect(decryptSecret(encrypted.redis.password!)).toBe(PASSWORD);
    expect(encrypted.redis.encryptionKey).toBe(value.redis.encryptionKey);
    expect(encryptCertificateStorageSecrets(null)).toBeNull();
    expect(encryptCertificateStorageSecrets({ backend: 'local', redis: null })).toEqual({ backend: 'local', redis: null });
  });

  it('views say whether a secret is set, never what it is', () => {
    const view = toRedisStorageView(stored({ password: encryptSecret(PASSWORD), encryptionKeyEnv: 'CADDY_STORAGE_ENCRYPTION_KEY' }));
    expect(view).toMatchObject({ hasPassword: true, passwordEnv: null, hasEncryptionKey: false, encryptionKeyEnv: 'CADDY_STORAGE_ENCRYPTION_KEY' });
    expect(JSON.stringify(view)).not.toMatch(/enc:v1:|redis-password/);
  });
});
