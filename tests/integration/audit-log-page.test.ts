/**
 * What the audit log page reads besides the events: the lag of a streaming
 * sink, the hash chain's state from the last recorded verification, and one
 * event's detail through the dashboard action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';
import type { Access } from '@/src/lib/permissions';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, access: null as unknown as Access }));

vi.mock('@/src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('@/src/lib/auth', () => ({
  requirePermission: vi.fn(async () => ({ user: { id: String(ctx.access.userId) }, access: ctx.access })),
}));

import * as schema from '@/src/lib/db/schema';
import { builtInAccess } from '@/src/lib/permissions';
import { insertAuditEvent } from '@/src/lib/audit-chain';
import { listAuditSinks } from '@/ee/audit/sinks';
import { getAuditChainStatus, previousChainedEventId } from '@/ee/audit/chain-status';
import { getAuditEventDetailAction } from '@/app/(dashboard)/audit-log/actions';

const stamp = '2026-10-03T09:00:00.000Z';

beforeEach(async () => {
  await ctx.db.delete(schema.auditSinks);
  await ctx.db.delete(schema.auditEvents);
  ctx.access = builtInAccess(1, 'admin');
});

async function event(summary: string, extra: { action?: string; data?: string } = {}): Promise<number> {
  return await insertAuditEvent({ action: extra.action ?? 'update', entityType: 'proxy_host', entityId: 3, summary, data: extra.data });
}

describe('sink lag', () => {
  it('reports when the oldest waiting event was recorded, and nothing once it is delivered', async () => {
    const first = await event('first');
    await event('second');
    await ctx.db.insert(schema.auditSinks).values({
      name: 'SIEM',
      type: 'webhook',
      enabled: true,
      config: JSON.stringify({ url: 'https://siem.example.com/ingest' }),
      lastDeliveredId: first - 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const [waiting] = await listAuditSinks();
    const [oldest] = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, first));
    expect(waiting.pendingEvents).toBe(2);
    expect(waiting.oldestPendingAt).toBe(oldest.createdAt);

    const newest = await event('third');
    await ctx.db.update(schema.auditSinks).set({ lastDeliveredId: newest });
    const [caughtUp] = await listAuditSinks();
    expect(caughtUp.pendingEvents).toBe(0);
    expect(caughtUp.oldestPendingAt).toBeNull();
  });
});

describe('hash chain status', () => {
  it('is empty before anything is recorded', async () => {
    expect(await getAuditChainStatus()).toEqual({ lastCheck: null, eventsSinceCheck: 0, anchor: null, head: null });
  });

  it('reads the last verification and counts what was recorded since', async () => {
    const anchor = await event('first');
    const checked = await event('second');
    const [head] = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, checked));
    const verification = await event('Verified the audit log hash chain: 2 events intact', {
      action: 'audit_log_verified',
      data: JSON.stringify({ ok: true, checked: 2, firstMismatchId: null, headId: checked, headHash: head.hash }),
    });
    await event('third');
    const newest = await event('fourth');

    const status = await getAuditChainStatus();
    expect(status.lastCheck).toMatchObject({ eventId: verification, ok: true, checked: 2, headId: checked, headHash: head.hash });
    expect(status.eventsSinceCheck).toBe(2);
    expect(status.anchor?.id).toBe(anchor);
    expect(status.head?.id).toBe(newest);
    expect(status.head?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a mismatch found by the last check, and ignores data it cannot read', async () => {
    await event('first', { action: 'audit_log_verified', data: JSON.stringify({ ok: false, checked: 5, firstMismatchId: 4, headHash: 'not a hash' }) });
    expect((await getAuditChainStatus()).lastCheck).toMatchObject({ ok: false, firstMismatchId: 4, headHash: null });
    await event('second', { action: 'audit_log_verified', data: '{broken' });
    expect((await getAuditChainStatus()).lastCheck).toMatchObject({ ok: false, checked: null });
  });

  it('names the previous event only while the link holds', async () => {
    const first = await event('first');
    const second = await event('second');
    const [row] = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, second));
    expect(await previousChainedEventId(second, row.prevHash)).toBe(first);
    expect(await previousChainedEventId(second, 'f'.repeat(64))).toBeNull();
    expect(await previousChainedEventId(first, null)).toBeNull();
  });
});

describe('event detail action', () => {
  it('returns the data and the previous event', async () => {
    const first = await event('first');
    const second = await event('second', { data: JSON.stringify({ upstreams: ['app:8080'] }) });
    const outcome = await getAuditEventDetailAction(second);
    expect(outcome).toEqual({ detail: { id: second, data: { upstreams: ['app:8080'] }, configDiff: null, previousEventId: first } });
  });

  it('refuses ids that are not event ids', async () => {
    expect(await getAuditEventDetailAction(0)).toEqual({ error: 'Audit event not found' });
    expect(await getAuditEventDetailAction(1.5)).toEqual({ error: 'Audit event not found' });
    expect(await getAuditEventDetailAction(Number.MAX_SAFE_INTEGER + 2)).toEqual({ error: 'Audit event not found' });
    expect(await getAuditEventDetailAction(424242)).toEqual({ error: 'Audit event not found' });
  });
});
