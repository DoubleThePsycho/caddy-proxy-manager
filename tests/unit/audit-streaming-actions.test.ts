/**
 * Dashboard server actions of audit streaming: each write path works and
 * reports validation errors as messages.
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
import {
  createAuditSinkAction,
  deleteAuditSinkAction,
  saveAuditRetentionAction,
  testAuditSinkAction,
  updateAuditSinkAction,
} from '@/ee/audit/ui/streaming-actions';
import { verifyAuditLogAction } from '@/ee/audit/ui/actions';
import { getAuditRetention } from '@/ee/audit/retention';

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
});

beforeEach(async () => {
  await ctx.db.delete(schema.auditSinks);
  await ctx.db.delete(schema.auditEvents);
  await ctx.db.delete(schema.settings);
});

const sinkInput = { name: 'SIEM', type: 'webhook', config: { url: 'https://siem.example.com/hook' }, secret: 'whsec-action-0123456789' };

async function sinkIds() {
  return (await ctx.db.select().from(schema.auditSinks)).map((row) => row.id);
}

describe('audit streaming server actions', () => {
  it('create: creates a sink', async () => {
    expect(await createAuditSinkAction(sinkInput)).toEqual({ ok: true });
    expect(await sinkIds()).toHaveLength(1);
  });

  it('create: returns validation errors as messages', async () => {
    expect(await createAuditSinkAction({ ...sinkInput, config: { url: 'file:///etc/passwd' } })).toEqual({
      error: 'URL must use http or https',
    });
  });

  it('update: applies the change', async () => {
    await createAuditSinkAction(sinkInput);
    const [id] = await sinkIds();
    expect(await updateAuditSinkAction(id, { name: 'Other' })).toEqual({ ok: true });
  });

  it('disable, enable and delete', async () => {
    await createAuditSinkAction(sinkInput);
    const [id] = await sinkIds();
    expect(await updateAuditSinkAction(id, { enabled: false })).toEqual({ ok: true });
    expect(await updateAuditSinkAction(id, { enabled: true })).toEqual({ ok: true });
    expect(await deleteAuditSinkAction(id)).toEqual({ ok: true });
    expect(await sinkIds()).toEqual([]);
  });

  it('test: delivers a test event', async () => {
    await createAuditSinkAction({ ...sinkInput, config: { url } });
    const [id] = await sinkIds();
    expect(await testAuditSinkAction(id)).toMatchObject({ result: { ok: true, error: null } });
  });

  it('retention: saved, and turned off with 0', async () => {
    expect(await saveAuditRetentionAction(30)).toEqual({ ok: true });
    expect((await getAuditRetention()).days).toBe(30);
    expect(await saveAuditRetentionAction(0)).toEqual({ ok: true });
    expect((await getAuditRetention()).days).toBe(0);
  });

  it('verify: verifies the chain', async () => {
    await insertAuditEvent({ action: 'a', entityType: 'b' });
    expect(await verifyAuditLogAction()).toMatchObject({ result: { ok: true, checked: 1 } });
  });

  it('requires an administrator before anything else', async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('Administrator privileges required'));
    await expect(createAuditSinkAction(sinkInput)).rejects.toThrow('Administrator privileges required');
    expect(await sinkIds()).toEqual([]);
  });
});
