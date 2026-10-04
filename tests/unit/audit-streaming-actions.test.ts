/**
 * Dashboard server actions of audit streaming: each write path refuses
 * without a license and works with one.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('@/src/lib/auth', () => ({
  requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())),
  requireAdmin: vi.fn(async () => ({ user: { id: '7', role: 'admin' } })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import * as schema from '@/src/lib/db/schema';
import { requireAdmin } from '@/src/lib/auth';
import { insertAuditEvent } from '@/src/lib/audit-chain';
import { setSetting } from '@/src/lib/settings';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { LICENSE_SETTING_KEY } from '@/ee/licensing/store';
import {
  createAuditSinkAction,
  deleteAuditSinkAction,
  saveAuditRetentionAction,
  testAuditSinkAction,
  updateAuditSinkAction,
} from '@/ee/audit/ui/streaming-actions';
import { verifyAuditLogAction } from '@/ee/audit/ui/actions';
import { getAuditRetention } from '@/ee/audit/retention';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';

const signer = createTestSigner();
const LICENSE_ERROR = 'Audit streaming and export needs an active Ingressi Business license or higher';

let receiver: Server;
let url: string;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end());
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  setTrustedLicenseKeysForTests(null);
});

beforeEach(async () => {
  setTrustedLicenseKeysForTests(signer.keys);
  await ctx.db.delete(schema.auditSinks);
  await ctx.db.delete(schema.auditEvents);
  await ctx.db.delete(schema.settings);
});

async function license(on: boolean) {
  if (!on) {
    await ctx.db.delete(schema.settings);
    return;
  }
  await setSetting(LICENSE_SETTING_KEY, signLicense(signer, licensePayload(signer, {
    iat: '2026-01-01T00:00:00.000Z', exp: '2099-01-01T00:00:00.000Z',
  })));
}

const sinkInput = { name: 'SIEM', type: 'webhook', config: { url: 'https://siem.example.com/hook' }, secret: 'whsec-action-0123456789' };

async function sinkIds() {
  return (await ctx.db.select().from(schema.auditSinks)).map((row) => row.id);
}

describe('audit streaming server actions', () => {
  it('create: refused without a license, created with one', async () => {
    expect(await createAuditSinkAction(sinkInput)).toEqual({ error: LICENSE_ERROR });
    expect(await sinkIds()).toEqual([]);
    await license(true);
    expect(await createAuditSinkAction(sinkInput)).toEqual({ ok: true });
    expect(await sinkIds()).toHaveLength(1);
  });

  it('create: returns validation errors as messages', async () => {
    await license(true);
    expect(await createAuditSinkAction({ ...sinkInput, config: { url: 'file:///etc/passwd' } })).toEqual({
      error: 'URL must use http or https',
    });
  });

  it('update: refused without a license, applied with one', async () => {
    await license(true);
    await createAuditSinkAction(sinkInput);
    const [id] = await sinkIds();
    await license(false);
    expect(await updateAuditSinkAction(id, { name: 'Other' })).toEqual({ error: LICENSE_ERROR });

    await license(true);
    expect(await updateAuditSinkAction(id, { name: 'Other' })).toEqual({ ok: true });
  });

  it('disable and delete: work without a license; re-enabling does not', async () => {
    await license(true);
    await createAuditSinkAction(sinkInput);
    const [id] = await sinkIds();
    await license(false);
    expect(await updateAuditSinkAction(id, { enabled: false })).toEqual({ ok: true });
    expect(await updateAuditSinkAction(id, { enabled: true })).toEqual({ error: LICENSE_ERROR });
    expect(await deleteAuditSinkAction(id)).toEqual({ ok: true });
    expect(await sinkIds()).toEqual([]);
  });

  it('test: refused without a license, delivered with one', async () => {
    await license(true);
    await createAuditSinkAction({ ...sinkInput, config: { url } });
    const [id] = await sinkIds();
    await license(false);
    expect(await testAuditSinkAction(id)).toEqual({ error: LICENSE_ERROR });
    await license(true);
    expect(await testAuditSinkAction(id)).toMatchObject({ result: { ok: true, error: null } });
  });

  it('retention: refused without a license, saved with one; turning it off needs none', async () => {
    expect(await saveAuditRetentionAction(30)).toEqual({ error: LICENSE_ERROR });
    expect((await getAuditRetention()).days).toBe(0);
    await license(true);
    expect(await saveAuditRetentionAction(30)).toEqual({ ok: true });
    expect((await getAuditRetention()).days).toBe(30);
    await license(false);
    expect(await saveAuditRetentionAction(0)).toEqual({ ok: true });
    expect((await getAuditRetention()).days).toBe(0);
  });

  it('verify: refused without a license, verified with one', async () => {
    await insertAuditEvent({ action: 'a', entityType: 'b' });
    expect(await verifyAuditLogAction()).toEqual({ error: LICENSE_ERROR });
    await license(true);
    expect(await verifyAuditLogAction()).toMatchObject({ result: { ok: true, checked: 1 } });
  });

  it('requires an administrator before anything else', async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('Administrator privileges required'));
    await license(true);
    await expect(createAuditSinkAction(sinkInput)).rejects.toThrow('Administrator privileges required');
    expect(await sinkIds()).toEqual([]);
  });
});
