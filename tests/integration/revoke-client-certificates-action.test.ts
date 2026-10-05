/**
 * Integration tests for revokeIssuedClientCertificatesAction in
 * app/(dashboard)/certificates/ca-actions.ts: the bulk revoke of the client
 * certificate list. One change batch (Caddy applied once at the end), one
 * audit event per revoked certificate, and a message saying what happened.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { caCertificates, issuedClientCertificates, users } from '../../src/lib/db/schema';
import { eq } from 'drizzle-orm';

let db: TestDb;

const { applied, audited } = vi.hoisted(() => ({ applied: vi.fn(), audited: vi.fn() }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => db));
// Both honour change batches as the real ones do: inside a batch nothing is applied or recorded.
vi.mock('../../src/lib/caddy', async () => {
  const { deferCaddyApplyToBatch } = await import('../../src/lib/change-batch');
  return {
    applyCaddyConfig: vi.fn(async () => {
      if (!deferCaddyApplyToBatch()) applied();
    }),
  };
});
vi.mock('../../src/lib/audit', async () => {
  const { inChangeBatch } = await import('../../src/lib/change-batch');
  return {
    logAuditEvent: vi.fn(async (event: unknown) => {
      if (!inChangeBatch()) audited(event);
    }),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { requireAdminMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(async () => ({ user: { id: '1' } })),
}));
vi.mock('@/src/lib/auth', () => ({ requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())), requireAdmin: requireAdminMock }));

const { revokeIssuedClientCertificatesAction } = await import('../../app/(dashboard)/certificates/ca-actions');

let userId: number;
let caId: number;

async function issue(commonName: string, revokedAt: string | null = null): Promise<number> {
  const now = new Date().toISOString();
  const [row] = await db.insert(issuedClientCertificates).values({
    caCertificateId: caId,
    commonName,
    serialNumber: `SERIAL-${commonName}`,
    fingerprintSha256: 'AA:BB',
    certificatePem: 'CERT',
    validFrom: now,
    validTo: new Date(Date.now() + 86_400_000 * 365).toISOString(),
    revokedAt,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return row.id;
}

beforeEach(async () => {
  db = createTestDb();
  vi.clearAllMocks();
  const now = new Date().toISOString();
  const [user] = await db.insert(users).values({
    email: 'admin@test', name: 'Admin', role: 'admin',
    provider: 'credentials', subject: 'admin@test', status: 'active',
    createdAt: now, updatedAt: now,
  }).returning();
  userId = user.id;
  requireAdminMock.mockResolvedValue({ user: { id: String(user.id) } });
  const [ca] = await db.insert(caCertificates).values({ name: 'Staff CA', certificatePem: 'CERT', createdAt: now, updatedAt: now }).returning();
  caId = ca.id;
});

describe('revokeIssuedClientCertificatesAction', () => {
  it('revokes the certificates in one change and audits each one', async () => {
    const alice = await issue('alice');
    const bob = await issue('bob');
    const carol = await issue('carol');

    const result = await revokeIssuedClientCertificatesAction([alice, bob, alice]);

    expect(result).toEqual({ ok: true, revoked: 2, message: 'Revoked 2 certificates.' });
    const rows = await db.select().from(issuedClientCertificates);
    expect(rows.filter((row) => row.revokedAt !== null).map((row) => row.commonName).sort()).toEqual(['alice', 'bob']);
    expect(rows.find((row) => row.id === carol)?.revokedAt).toBeNull();
    expect(applied).toHaveBeenCalledTimes(1);
    expect(audited).toHaveBeenCalledTimes(2);
    expect(audited).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      action: 'revoke',
      entityType: 'issued_client_certificate',
      entityId: alice,
      summary: 'Revoked client certificate alice',
    }));
  });

  it('says which were already revoked or missing', async () => {
    const alice = await issue('alice');
    const dave = await issue('dave', new Date().toISOString());

    const result = await revokeIssuedClientCertificatesAction([alice, dave, 999]);

    expect(result.ok).toBe(false);
    expect(result.revoked).toBe(1);
    expect(result.message).toBe('Revoked 1 certificate. 1 certificate already was revoked. 1 certificate could not be revoked: #999 (not found).');
    expect((await db.select().from(issuedClientCertificates).where(eq(issuedClientCertificates.id, alice)))[0].revokedAt).not.toBeNull();
  });

  it('applies nothing when nothing changed', async () => {
    const dave = await issue('dave', new Date().toISOString());
    expect(await revokeIssuedClientCertificatesAction([dave])).toEqual({
      ok: true,
      revoked: 0,
      message: '1 certificate already was revoked.',
    });
    expect(applied).not.toHaveBeenCalled();
    expect(audited).not.toHaveBeenCalled();
  });

  it('rejects an empty, malformed or too long list', async () => {
    await expect(revokeIssuedClientCertificatesAction([])).rejects.toThrow('Choose the certificates first.');
    await expect(revokeIssuedClientCertificatesAction('1')).rejects.toThrow('Choose the certificates first.');
    await expect(revokeIssuedClientCertificatesAction([1, 'x'])).rejects.toThrow('Unknown client certificate.');
    await expect(revokeIssuedClientCertificatesAction(Array.from({ length: 501 }, (_, i) => i + 1))).rejects.toThrow(
      'Choose at most 500 certificates at a time.'
    );
  });
});
