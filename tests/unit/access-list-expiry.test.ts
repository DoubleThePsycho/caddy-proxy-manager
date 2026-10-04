/**
 * The access list expiry job (src/lib/access-list-expiry.ts): a master or
 * standalone instance deletes expired rules; a sync slave deletes nothing
 * and applies Caddy once per newly expired rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ mode: 'standalone', expired: [] as Array<{ id: number }> }));

vi.mock('@/src/lib/instance-sync', () => ({ getInstanceMode: vi.fn(async () => ctx.mode) }));
vi.mock('@/src/lib/models/access-lists', () => ({
  deleteExpiredAccessListRules: vi.fn(async () => 2),
  listExpiredAccessListRules: vi.fn(async () => ctx.expired),
}));

import { runAccessListExpiry } from '@/src/lib/access-list-expiry';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { deleteExpiredAccessListRules } from '@/src/lib/models/access-lists';

beforeEach(() => {
  vi.mocked(applyCaddyConfig).mockClear();
  vi.mocked(deleteExpiredAccessListRules).mockClear();
});

describe('runAccessListExpiry', () => {
  it('deletes expired rules on a master or standalone instance', async () => {
    ctx.mode = 'master';
    expect(await runAccessListExpiry()).toEqual({ deleted: 2, reapplied: false });
    expect(deleteExpiredAccessListRules).toHaveBeenCalledTimes(1);
  });

  it('on a slave, applies Caddy once for each rule that newly expired and deletes nothing', async () => {
    ctx.mode = 'slave';
    ctx.expired = [{ id: 1 }];
    expect(await runAccessListExpiry()).toEqual({ deleted: 0, reapplied: true });
    expect(await runAccessListExpiry()).toEqual({ deleted: 0, reapplied: false });
    ctx.expired = [{ id: 1 }, { id: 2 }];
    expect(await runAccessListExpiry()).toEqual({ deleted: 0, reapplied: true });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(2);
    expect(deleteExpiredAccessListRules).not.toHaveBeenCalled();
  });
});
