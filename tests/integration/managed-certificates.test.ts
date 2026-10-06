/**
 * Certificates Caddy manages (src/lib/managed-certificates.ts): which names
 * are checked, how a handshake result is classified, caching, the TLS probe
 * against a real local TLS server, and filtering to a reader's scope.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { createSelfSignedServerCertificate } from '../helpers/certs';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import {
  caddyTlsAddress,
  classifyProbe,
  filterManagedCertificatesForAccess,
  getManagedCertificates,
  listManagedDomains,
  probeName,
  setManagedCertificateProbeForTests,
  tlsProbe,
  type ProbeResult,
} from '../../src/lib/managed-certificates';
import { builtInAccess, type Access } from '../../src/lib/permissions';
import { first as dbFirst } from '@/src/lib/db/ops';

const DAY = 86_400_000;
const stamp = () => new Date().toISOString();
const valid = createSelfSignedServerCertificate('app.example.com', ['app.example.com', '*.wild.example.com'], 90);

beforeEach(() => {
  ctx.db = createTestDb();
  setManagedCertificateProbeForTests(null);
});

afterAll(() => setManagedCertificateProbeForTests(null));

async function addHost(name: string, domains: string[], values: Partial<typeof schema.proxyHosts.$inferInsert> = {}): Promise<number> {
  return (await dbFirst(ctx.db.insert(schema.proxyHosts).values({ name, domains: JSON.stringify(domains), upstreams: '[]', createdAt: stamp(), updatedAt: stamp(), ...values }).returning()))!.id;
}

describe('names', () => {
  it('probes wildcards through a fixed label and skips IP addresses and invalid names', () => {
    expect(probeName('App.Example.com.')).toBe('app.example.com');
    expect(probeName('*.wild.example.com')).toBe('tls-check.wild.example.com');
    expect(probeName('10.0.0.1')).toBeNull();
    expect(probeName('::1')).toBeNull();
    expect(probeName('bad name.example.com')).toBeNull();
    expect(probeName('')).toBeNull();
  });

  it('lists the domains of enabled hosts whose certificate Caddy manages', async () => {
    const imported = (await dbFirst(ctx.db.insert(schema.certificates).values({ name: 'Imported', type: 'imported', domainNames: '[]', createdAt: stamp(), updatedAt: stamp() }).returning()))!;
    const dns = (await dbFirst(ctx.db.insert(schema.certificates).values({ name: 'DNS-01', type: 'managed', domainNames: '[]', createdAt: stamp(), updatedAt: stamp() }).returning()))!;
    const a = await addHost('A', ['a.example.com', '*.wild.example.com', '192.0.2.1']);
    const b = await addHost('B', ['a.example.com', 'b.example.com'], { certificateId: dns.id });
    await addHost('Imported', ['imported.example.com'], { certificateId: imported.id });
    await addHost('Off', ['off.example.com'], { enabled: false });
    const domains = await listManagedDomains();
    expect(domains.map((domain) => [domain.servername, domain.proxyHosts.map((host) => host.id)])).toEqual([
      ['a.example.com', [a, b]],
      ['b.example.com', [b]],
      ['tls-check.wild.example.com', [a]],
    ]);
  });

  it('reads the address from CADDY_TLS_ADDRESS, and "off" turns the checks off', () => {
    const previous = process.env.CADDY_TLS_ADDRESS;
    try {
      process.env.CADDY_TLS_ADDRESS = '10.1.2.3:8443';
      expect(caddyTlsAddress()).toEqual({ host: '10.1.2.3', port: 8443 });
      process.env.CADDY_TLS_ADDRESS = '[::1]:443';
      expect(caddyTlsAddress()).toEqual({ host: '::1', port: 443 });
      process.env.CADDY_TLS_ADDRESS = 'off';
      expect(caddyTlsAddress()).toBeNull();
      delete process.env.CADDY_TLS_ADDRESS;
      expect(caddyTlsAddress()).toEqual({ host: 'caddy', port: 443 });
    } finally {
      process.env.CADDY_TLS_ADDRESS = previous;
    }
  });
});

describe('classification', () => {
  const domain = { domain: 'app.example.com', servername: 'app.example.com', proxyHosts: [{ id: 1, name: 'App' }], changedAt: null };
  const certificate: ProbeResult = { kind: 'certificate', pem: valid.certificatePem };

  it('reads validity, the renewal point and the issuer', () => {
    const now = new Date();
    const status = classifyProbe(domain, certificate, now);
    expect(status).toMatchObject({ state: 'valid', daysLeft: expect.any(Number), issuer: 'Ingressi E2E', error: null });
    expect(status.daysLeft).toBeGreaterThanOrEqual(88);
    // A 90-day certificate is renewed a third of its lifetime, 30 days, before it expires (the helper's dates follow local time).
    const lifetime = Date.parse(status.validTo!) - Date.parse(status.validFrom!);
    expect(Date.parse(status.validTo!) - Date.parse(status.renewsAt!)).toBe(lifetime / 3);
    expect(Math.abs(lifetime / 3 - 30 * DAY)).toBeLessThanOrEqual(3_600_000);
  });

  it('tells renewal due, overdue and expired apart', () => {
    const renewsAt = (status: ReturnType<typeof classifyProbe>) => Date.parse(status.renewsAt!);
    const base = classifyProbe(domain, certificate, new Date());
    expect(classifyProbe(domain, certificate, new Date(renewsAt(base) + 1000)).state).toBe('renewal_due');
    expect(classifyProbe(domain, certificate, new Date(renewsAt(base) + DAY + 1000)).state).toBe('renewal_overdue');
    expect(classifyProbe(domain, certificate, new Date(Date.parse(base.validTo!) + 1000)).state).toBe('expired');
  });

  it('reports a certificate that does not cover the name, and matches wildcards', () => {
    const other = { ...domain, domain: 'other.example.com', servername: 'other.example.com' };
    expect(classifyProbe(other, certificate, new Date())).toMatchObject({ state: 'mismatch', error: expect.stringMatching(/does not cover/) });
    const wild = { ...domain, domain: '*.wild.example.com', servername: 'tls-check.wild.example.com' };
    expect(classifyProbe(wild, certificate, new Date()).state).toBe('valid');
  });

  it('never treats a handshake error as a missing certificate', () => {
    expect(classifyProbe(domain, { kind: 'missing' }, new Date())).toMatchObject({ state: 'missing' });
    expect(classifyProbe(domain, { kind: 'tls_error', code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' }, new Date())).toMatchObject({ state: 'error' });
    expect(classifyProbe(domain, { kind: 'unreachable', code: 'ECONNREFUSED' }, new Date())).toMatchObject({ state: 'error', error: expect.stringContaining('ECONNREFUSED') });
    expect(classifyProbe(domain, { kind: 'certificate', pem: 'not a certificate' }, new Date())).toMatchObject({ state: 'error' });
  });
});

describe('checking and caching', () => {
  it('probes stale names, caches results and reports Caddy unreachable', async () => {
    await addHost('App', ['app.example.com']);
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ kind: 'certificate', pem: valid.certificatePem }));
    setManagedCertificateProbeForTests(probe);
    const now = new Date();
    const first = await getManagedCertificates({ now });
    expect(first).toMatchObject({ available: true, reason: null, unchecked: 0, certificates: [{ servername: 'app.example.com', state: 'valid' }] });
    await getManagedCertificates({ now: new Date(now.getTime() + 60_000) });
    expect(probe).toHaveBeenCalledTimes(1);
    await getManagedCertificates({ now: new Date(now.getTime() + 31 * 60_000) });
    expect(probe).toHaveBeenCalledTimes(2);

    setManagedCertificateProbeForTests(async () => ({ kind: 'unreachable', code: 'ECONNREFUSED' }));
    expect(await getManagedCertificates({ now })).toMatchObject({ available: false, certificates: [], reason: expect.stringMatching(/could not be reached/) });
  });

  it('answers from the cache at once with cachedOnly and checks in the background', async () => {
    await addHost('App', ['app.example.com']);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setManagedCertificateProbeForTests(async () => {
      await gate;
      return { kind: 'certificate', pem: valid.certificatePem };
    });
    const first = await getManagedCertificates({ cachedOnly: true });
    expect(first).toMatchObject({ available: false, unchecked: 1, certificates: [], reason: "Caddy's certificates have not been checked yet" });
    release();
    await vi.waitFor(async () => {
      expect((await getManagedCertificates({ cachedOnly: true })).certificates).toHaveLength(1);
    });
  });

  it('has nothing to check without hosts', async () => {
    expect(await getManagedCertificates()).toEqual({ available: true, reason: null, certificates: [], unchecked: 0 });
  });

  it('shows a reader only the hosts within their tag scope', async () => {
    const prod = await addHost('Prod', ['prod.example.com'], { tags: '["prod"]' });
    await addHost('Dev', ['dev.example.com'], { tags: '["dev"]' });
    setManagedCertificateProbeForTests(async () => ({ kind: 'certificate', pem: valid.certificatePem }));
    const { certificates } = await getManagedCertificates();
    expect(await filterManagedCertificatesForAccess(certificates, builtInAccess(1, 'admin'))).toHaveLength(2);
    const scoped: Access = { ...builtInAccess(2, 'viewer'), customRole: { id: 1, name: 'Prod' }, scopeTags: ['prod'], permissions: new Set(['certificates:read']) };
    expect((await filterManagedCertificatesForAccess(certificates, scoped)).map((status) => status.proxyHosts[0].id)).toEqual([prod]);
  });
});

describe('the TLS probe', () => {
  let server: tls.Server;
  const previous = process.env.CADDY_TLS_ADDRESS;

  beforeEach(async () => {
    const context = tls.createSecureContext({ cert: valid.certificatePem, key: valid.privateKeyPem });
    server = tls.createServer({
      SNICallback: (name, callback) => (name === 'app.example.com' ? callback(null, context) : callback(new Error('no certificate available'))),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.CADDY_TLS_ADDRESS = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    process.env.CADDY_TLS_ADDRESS = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reads the certificate Caddy presents for a name, without verifying the chain', async () => {
    const result = await tlsProbe('app.example.com');
    expect(result.kind).toBe('certificate');
    const status = classifyProbe({ domain: 'app.example.com', servername: 'app.example.com', proxyHosts: [], changedAt: null }, result, new Date());
    expect(status.state).toBe('valid');
  });

  it('reports a refused handshake without a certificate', async () => {
    const result = await tlsProbe('unknown.example.com');
    expect(result.kind).not.toBe('certificate');
  });

  it('reports a closed port as unreachable', async () => {
    process.env.CADDY_TLS_ADDRESS = '127.0.0.1:1';
    expect(await tlsProbe('app.example.com')).toEqual({ kind: 'unreachable', code: 'ECONNREFUSED' });
    process.env.CADDY_TLS_ADDRESS = 'off';
    expect(await tlsProbe('app.example.com')).toEqual({ kind: 'unreachable', code: 'DISABLED' });
  });
});
