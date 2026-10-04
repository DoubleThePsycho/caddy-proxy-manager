/**
 * Change batches: inside runAsChangeBatch the real applyCaddyConfig only
 * records that an apply is needed and the real logAuditEvent records nothing;
 * outside a batch, and in concurrent work, both behave as before.
 */
import { describe, expect, it, vi } from 'vitest';

const insertAuditEvent = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/audit-chain', () => ({ insertAuditEvent }));

import { inChangeBatch, runAsChangeBatch } from '@/src/lib/change-batch';

describe('runAsChangeBatch', () => {
  it('defers the real Caddy apply to the batch', async () => {
    const { applyCaddyConfig } = await vi.importActual<typeof import('@/src/lib/caddy')>('@/src/lib/caddy');
    const { result, applyRequested } = await runAsChangeBatch(async () => {
      await applyCaddyConfig();
      await applyCaddyConfig();
      return 'done';
    });
    expect(result).toBe('done');
    expect(applyRequested).toBe(true);
  });

  it('reports no apply when nothing asked for one', async () => {
    expect(await runAsChangeBatch(async () => 1)).toEqual({ result: 1, applyRequested: false });
  });

  it('records no audit events inside a batch, and does outside', async () => {
    const { logAuditEvent } = await vi.importActual<typeof import('@/src/lib/audit')>('@/src/lib/audit');
    insertAuditEvent.mockClear();
    await runAsChangeBatch(async () => {
      await logAuditEvent({ action: 'create', entityType: 'proxy_host', summary: 'inside' });
    });
    expect(insertAuditEvent).not.toHaveBeenCalled();
    await logAuditEvent({ action: 'create', entityType: 'proxy_host', summary: 'outside' });
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    expect(insertAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ summary: 'outside' }));
  });

  it('is scoped to the async call chain', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const batch = runAsChangeBatch(async () => {
      await gate;
      return inChangeBatch();
    });
    // Work started outside the batch, while the batch is running, is not in it.
    expect(inChangeBatch()).toBe(false);
    const outside = (async () => inChangeBatch())();
    release();
    expect(await outside).toBe(false);
    expect((await batch).result).toBe(true);
  });
});
