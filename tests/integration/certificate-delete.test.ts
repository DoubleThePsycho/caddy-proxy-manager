/**
 * Deleting a certificate (src/lib/models/certificates.ts): SQLite does not
 * enforce the schema's ON DELETE SET NULL, so the model detaches the proxy
 * hosts that use the certificate itself, in the same transaction. They fall
 * back to automatic TLS, the change is audited per host and Caddy is applied.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import { certificates, proxyHosts, users } from '../../src/lib/db/schema';
import { first } from '@/src/lib/db/ops';

let db: TestDb;

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));
vi.mock('../../src/lib/caddy', () => ({ applyCaddyConfig: vi.fn() }));
vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
const dns = vi.hoisted(() => ({ settings: null as null | { providers: Record<string, Record<string, string>>; default: string | null } }));
vi.mock('../../src/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/settings')>()),
  getDnsProviderSettings: vi.fn(async () => dns.settings),
}));

const { deleteCertificate } = await import('../../src/lib/models/certificates');
const { applyCaddyConfig } = await import('../../src/lib/caddy');
const { logAuditEvent } = await import('../../src/lib/audit');

const stamp = () => new Date().toISOString();
let adminId: number;

beforeEach(async () => {
  db = createTestDb();
  vi.clearAllMocks();
  dns.settings = null;
  const [admin] = await db.insert(users).values({
    email: 'admin@example.com', name: 'Admin', role: 'admin',
    provider: 'credentials', subject: 'admin@example.com', status: 'active',
    createdAt: stamp(), updatedAt: stamp(),
  }).returning();
  adminId = admin.id;
});

async function addCertificate(name: string): Promise<number> {
  return (await first(db.insert(certificates).values({
    name, type: 'managed', domainNames: '["app.example.com"]', autoRenew: true, createdAt: stamp(), updatedAt: stamp(),
  }).returning()))!.id;
}

async function addHost(name: string, certificateId: number | null, domains = ['app.example.com']): Promise<number> {
  return (await first(db.insert(proxyHosts).values({
    name, domains: JSON.stringify(domains), upstreams: '["app:80"]', certificateId,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }).returning()))!.id;
}

const certificateIdOf = async (hostId: number) =>
  (await first(db.select({ certificateId: proxyHosts.certificateId }).from(proxyHosts).where(eq(proxyHosts.id, hostId)).limit(1)))?.certificateId;

describe('deleteCertificate', () => {
  it('moves the hosts using it to automatic TLS, leaves other hosts alone, audits and applies', async () => {
    const doomed = await addCertificate('Doomed');
    const kept = await addCertificate('Kept');
    const a = await addHost('A', doomed);
    const b = await addHost('B', doomed);
    const other = await addHost('Other', kept);
    const auto = await addHost('Auto', null);

    await deleteCertificate(doomed, adminId);

    expect(await first(db.select().from(certificates).where(eq(certificates.id, doomed)).limit(1))).toBeUndefined();
    expect(await certificateIdOf(a)).toBeNull();
    expect(await certificateIdOf(b)).toBeNull();
    expect(await certificateIdOf(other)).toBe(kept);
    expect(await certificateIdOf(auto)).toBeNull();
    // The detached hosts count as changed.
    const updated = await first(db.select({ updatedAt: proxyHosts.updatedAt }).from(proxyHosts).where(eq(proxyHosts.id, a)).limit(1));
    expect(updated?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');

    const events = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
    expect(events).toContainEqual(expect.objectContaining({
      action: 'delete', entityType: 'certificate', entityId: doomed,
      summary: 'Deleted certificate Doomed; 2 proxy hosts use automatic TLS instead',
      data: { proxyHosts: [{ id: a, name: 'A' }, { id: b, name: 'B' }] },
    }));
    expect(events.filter((event) => event.entityType === 'proxy_host').map((event) => [event.action, event.entityId])).toEqual([
      ['update', a],
      ['update', b],
    ]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });

  it('deletes an unused certificate with a plain audit event', async () => {
    const unused = await addCertificate('Unused');
    const host = await addHost('Auto', null);
    await deleteCertificate(unused, adminId);
    expect(await certificateIdOf(host)).toBeNull();
    const events = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
    expect(events).toEqual([expect.objectContaining({ action: 'delete', entityType: 'certificate', summary: 'Deleted certificate Unused', data: undefined })]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps a certificate a wildcard host needs while no DNS provider could replace it', async () => {
    const wildcard = await addCertificate('Wildcard');
    const host = await addHost('Wild', wildcard, ['*.example.com']);
    await expect(deleteCertificate(wildcard, adminId)).rejects.toThrow(/needs a DNS provider/);
    expect(await first(db.select().from(certificates).where(eq(certificates.id, wildcard)).limit(1))).toBeDefined();
    expect(await certificateIdOf(host)).toBe(wildcard);
    expect(applyCaddyConfig).not.toHaveBeenCalled();

    // With a default DNS provider Caddy obtains the wildcard itself (DNS-01).
    dns.settings = { providers: { cloudflare: { api_token: 'x' } }, default: 'cloudflare' };
    await deleteCertificate(wildcard, adminId);
    expect(await certificateIdOf(host)).toBeNull();
  });

  it('changes nothing for a certificate that does not exist', async () => {
    const kept = await addCertificate('Kept');
    const host = await addHost('A', kept);
    await expect(deleteCertificate(kept + 100, adminId)).rejects.toThrow('Certificate not found');
    expect(await certificateIdOf(host)).toBe(kept);
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });
});
