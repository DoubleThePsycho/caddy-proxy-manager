import { describe, expect, it } from 'vitest';
import { encryptSecret } from '@/src/lib/secret';
import { emptyConfigContent, type ConfigContent, type ConfigRow } from '@/src/lib/config-content';
import {
  describeConfigContent, diffConfigContent, summarizeConfigContent, summarizeDiff,
} from '@/ee/config-history/diff';
import { canonicalJson, configFingerprint } from '@/ee/config-history/fingerprint';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';

function host(id: number, overrides: ConfigRow = {}): ConfigRow {
  return {
    id, name: `host-${id}`, domains: '["a.example.com"]', upstreams: '["up:80"]', certificateId: null, accessListId: null,
    ownerUserId: null, sslForced: true, hstsEnabled: true, hstsSubdomains: false, allowWebsocket: true,
    preserveHostHeader: true, meta: null, enabled: true, createdAt: T1, updatedAt: T1, skipHttpsHostnameValidation: false,
    ...overrides,
  };
}

function content(build: (c: ConfigContent) => void): ConfigContent {
  const c = emptyConfigContent();
  build(c);
  return c;
}

describe('diffConfigContent', () => {
  it('reports added, removed and changed items with field-level changes', () => {
    const from = content((c) => {
      c.tables.proxyHosts = [host(1), host(2, { name: 'gone' })];
    });
    const to = content((c) => {
      c.tables.proxyHosts = [host(1, { enabled: false, domains: '["a.example.com","b.example.com"]', updatedAt: T2 }), host(3, { name: 'new' })];
    });
    const diff = diffConfigContent(from, to);
    expect(diff.totals).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diff.entities).toEqual([
      {
        entity: 'proxyHosts',
        label: 'Proxy hosts',
        added: [{ id: 3, label: 'new' }],
        removed: [{ id: 2, label: 'gone' }],
        changed: [{
          id: 1,
          label: 'host-1',
          changes: [
            { path: 'domains', before: ['a.example.com'], after: ['a.example.com', 'b.example.com'] },
            { path: 'enabled', before: true, after: false },
          ],
        }],
      },
    ]);
    expect(summarizeDiff(diff)).toBe('Proxy hosts: added “new”, removed “gone”, changed “host-1”');
  });

  it('ignores timestamp-only changes and reports no differences for equal content', () => {
    const from = content((c) => { c.tables.proxyHosts = [host(1)]; });
    const to = content((c) => { c.tables.proxyHosts = [host(1, { updatedAt: T2, createdAt: T2 })]; });
    expect(diffConfigContent(from, to)).toEqual({ entities: [], totals: { added: 0, removed: 0, changed: 0 } });
    expect(summarizeDiff(diffConfigContent(from, to))).toBe('No changes');
    expect(configFingerprint(from)).toBe(configFingerprint(to));
  });

  it('diffs JSON columns by path and masks secret-looking fields inside them', () => {
    const from = content((c) => {
      c.tables.proxyHosts = [host(1, { meta: JSON.stringify({ waf: { enabled: true }, auth: { client_secret: 'old-secret-value' } }) })];
    });
    const to = content((c) => {
      c.tables.proxyHosts = [host(1, {
        meta: JSON.stringify({ waf: { enabled: false }, auth: { client_secret: 'new-secret-value' }, headers: { apiKey: 'k' } }),
      })];
    });
    const changes = diffConfigContent(from, to).entities[0].changed[0].changes;
    expect(changes).toEqual([
      { path: 'meta.auth.client_secret', secret: true },
      { path: 'meta.headers.apiKey', secret: true },
      { path: 'meta.waf.enabled', before: true, after: false },
    ]);
    expect(JSON.stringify(changes)).not.toContain('secret-value');
  });

  it('lists the fields of a JSON value that appears, still masking secrets', () => {
    const from = content((c) => { c.tables.proxyHosts = [host(1)]; });
    const to = content((c) => { c.tables.proxyHosts = [host(1, { meta: JSON.stringify({ mode: 'x', password: 'p' }) })]; });
    expect(diffConfigContent(from, to).entities[0].changed[0].changes).toEqual([
      { path: 'meta.mode', before: null, after: 'x' },
      { path: 'meta.password', secret: true },
    ]);
  });

  it('compares secret columns by plaintext and never shows them', () => {
    const cert = (id: number, key: string): ConfigRow => ({
      id, name: 'cert', type: 'imported', domainNames: '[]', autoRenew: false, providerOptions: null,
      certificatePem: 'PEM', privateKeyPem: encryptSecret(key), createdBy: null, createdAt: T1, updatedAt: T1,
    });
    const from = content((c) => { c.tables.certificates = [cert(1, 'KEY-A'), cert(2, 'KEY-B')]; });
    // Certificate 1: same key re-encrypted (different ciphertext); certificate 2: another key.
    const to = content((c) => { c.tables.certificates = [cert(1, 'KEY-A'), cert(2, 'KEY-C')]; });
    expect(from.tables.certificates[0].privateKeyPem).not.toBe(to.tables.certificates[0].privateKeyPem);

    const diff = diffConfigContent(from, to);
    expect(diff.entities[0].changed).toEqual([{ id: 2, label: 'cert', changes: [{ path: 'privateKeyPem', secret: true }] }]);
    expect(JSON.stringify(diff)).not.toMatch(/KEY-|enc:v1/);
    expect(configFingerprint(content((c) => { c.tables.certificates = [cert(1, 'KEY-A')]; })))
      .toBe(configFingerprint(content((c) => { c.tables.certificates = [cert(1, 'KEY-A')]; })));
  });

  it('diffs settings groups, masking encrypted values and the legacy Cloudflare group', () => {
    const from = content((c) => {
      c.settings.waf = { enabled: true, mode: 'On' };
      c.settings.dns_provider = { providers: { cloudflare: { api_token: encryptSecret('T1') } }, default: 'cloudflare' };
      c.settings.cloudflare = { apiToken: 'plain', zoneId: 'z1' };
      c.settings.metrics = { enabled: true };
    });
    const to = content((c) => {
      c.settings.waf = { enabled: true, mode: 'DetectionOnly' };
      c.settings.dns_provider = { providers: { cloudflare: { api_token: encryptSecret('T2') } }, default: 'cloudflare' };
      c.settings.cloudflare = { apiToken: 'plain', zoneId: 'z2' };
      c.settings.geoblock = { enabled: true };
    });
    const [settings] = diffConfigContent(from, to).entities;
    expect(settings).toMatchObject({
      entity: 'settings',
      added: [{ id: 'geoblock', label: 'Geoblocking' }],
      removed: [{ id: 'metrics', label: 'Metrics' }],
    });
    expect(Object.fromEntries(settings.changed.map((item) => [item.id, item.changes]))).toEqual({
      cloudflare: [{ path: 'zoneId', secret: true }],
      dns_provider: [{ path: 'providers.cloudflare.api_token', secret: true }],
      waf: [{ path: 'mode', before: 'On', after: 'DetectionOnly' }],
    });
  });
});

describe('summaries', () => {
  it('describes a whole configuration and its items without values', () => {
    const c = content((x) => {
      x.tables.proxyHosts = [host(1), host(2)];
      x.tables.groups = [{ id: 5, name: 'Ops', description: null, createdBy: null, createdAt: T1, updatedAt: T1 }];
      x.settings.general = { primaryDomain: 'example.com' };
    });
    expect(describeConfigContent(c)).toBe('2 proxy hosts, 1 group, 1 settings group');
    expect(describeConfigContent(emptyConfigContent())).toBe('Empty configuration');
    const summary = summarizeConfigContent(c);
    expect(summary.counts).toMatchObject({ proxyHosts: 2, groups: 1, settings: 1, certificates: 0 });
    expect(summary.items).toEqual({
      proxyHosts: [{ id: 1, label: 'host-1' }, { id: 2, label: 'host-2' }],
      groups: [{ id: 5, label: 'Ops' }],
    });
    expect(summary.settings).toEqual(['general']);
  });

  it('serializes canonically regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});
