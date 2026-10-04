/**
 * Sync fingerprints (src/lib/instance-sync-fingerprint.ts) and the status a
 * slave reports on GET /api/instances/sync?status=1: what is hashed, that the
 * fingerprint is keyed with the sync token, and that the master accepts only
 * a well-formed status (older releases count as "absent", not as errors).
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalSyncContent,
  parseReplicaSyncStatus,
  syncContentFingerprint,
  syncLocalDigest,
  syncTokenKeyId,
} from '@/src/lib/instance-sync-fingerprint';

const TOKEN = 'fingerprint-token-0123456789abcdef0123456789';
const OTHER_TOKEN = 'another-fingerprint-token-0123456789abcdef01';

function content(overrides: Record<string, unknown> = {}) {
  return {
    settings: { general: { primaryDomain: 'example.com' }, dns_provider: { providers: { cloudflare: { api_token: 'secret-token' } } } },
    data: {
      proxyHosts: [
        { id: 2, name: 'b', updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' },
        { id: 1, name: 'a', updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z' },
      ],
      certificates: [{ id: 1, privateKeyPem: 'KEY' }],
    },
    ...overrides,
  };
}

const status = {
  version: 1,
  appVersion: '2.1.0',
  fingerprint: 'f'.repeat(64),
  appliedAt: '2026-10-02T10:00:00.000Z',
  localChanges: false,
  overriddenSettings: ['general', 'not-a-setting'],
  lastSync: { at: '2026-10-02T10:00:00.000Z', error: 'raw upstream body <html>' },
  caddy: { ok: true, at: '2026-10-02T10:00:01.000Z', code: null },
};

describe('canonical sync content', () => {
  it('ignores key order, row order and timestamps, and fills missing groups and tables', () => {
    const a = content();
    const b = {
      data: {
        certificates: [{ privateKeyPem: 'KEY', id: 1 }],
        proxyHosts: [
          { name: 'a', id: 1, updatedAt: '2030-01-01T00:00:00.000Z' },
          { name: 'b', id: 2 },
        ],
        l4ProxyHosts: [],
      },
      settings: { dns_provider: { providers: { cloudflare: { api_token: 'secret-token' } } }, general: { primaryDomain: 'example.com' }, waf: null },
    };
    expect(canonicalSyncContent(a)).toBe(canonicalSyncContent(b));
    expect(syncContentFingerprint(a, TOKEN)).toBe(syncContentFingerprint(b, TOKEN));
  });

  it('changes with any synced value, secrets included', () => {
    const base = syncContentFingerprint(content(), TOKEN);
    const changedSecret = content();
    (changedSecret.settings.dns_provider.providers.cloudflare as { api_token: string }).api_token = 'other-token';
    expect(syncContentFingerprint(changedSecret, TOKEN)).not.toBe(base);
    const changedKey = content();
    changedKey.data.certificates[0].privateKeyPem = 'OTHER';
    expect(syncContentFingerprint(changedKey, TOKEN)).not.toBe(base);
  });

  it('is keyed with the sync token, and the local digest and key id use separate keys', () => {
    const fingerprint = syncContentFingerprint(content(), TOKEN);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(syncContentFingerprint(content(), OTHER_TOKEN)).not.toBe(fingerprint);
    expect(syncLocalDigest(content(), TOKEN)).not.toBe(fingerprint);
    expect(syncTokenKeyId(TOKEN)).toMatch(/^[0-9a-f]{16}$/);
    expect(syncTokenKeyId(OTHER_TOKEN)).not.toBe(syncTokenKeyId(TOKEN));
  });
});

describe('parseReplicaSyncStatus', () => {
  it('reads a status, keeping only known settings and fixed sync errors', () => {
    expect(parseReplicaSyncStatus({ syncStatus: status })).toEqual({
      kind: 'ok',
      status: {
        ...status,
        overriddenSettings: ['general'],
        lastSync: { at: status.lastSync.at, error: 'Previous synchronization failed' },
      },
    });
  });

  it('treats a reply without a status as an older release', () => {
    expect(parseReplicaSyncStatus({ version: 1, publicKey: 'x', nonce: 'y' })).toEqual({ kind: 'absent' });
    expect(parseReplicaSyncStatus(null)).toEqual({ kind: 'absent' });
  });

  it.each([
    ['another version', { ...status, version: 2 }],
    ['a malformed fingerprint', { ...status, fingerprint: 'not-hex' }],
    ['a release name with spaces', { ...status, appVersion: 'v 1' }],
    ['a non-boolean localChanges', { ...status, localChanges: 'no' }],
    ['a malformed Caddy status', { ...status, caddy: { ok: 'yes', at: status.appliedAt } }],
    ['an unparsable time', { ...status, appliedAt: 'yesterday' }],
  ])('refuses %s', (_name, value) => {
    expect(parseReplicaSyncStatus({ syncStatus: value })).toEqual({ kind: 'invalid' });
  });
});
