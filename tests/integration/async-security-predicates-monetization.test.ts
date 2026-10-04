/**
 * The proxy host side of API monetization (ee/monetization/host-guard.ts):
 * monetization is an authentication mode of its own, so a host change that
 * adds an access list or forward auth to a monetized host is refused
 * (assertProxyHostAuthCompatible, from updateProxyHost), and a deleted host's
 * monetization settings go with it (forgetDeletedProxyHost, from
 * deleteProxyHost). Both read isHostMonetized / getHostRow, which became
 * asynchronous.
 *
 * `if (!isHostMonetized(…)) return;` without await never returns early, so
 * every host would be treated as monetized: adding an access list to any host
 * would be refused. A predicate that never matches would let a monetized host
 * be combined with another authentication mode. Both directions are checked
 * through updateProxyHost; monetization-api.test.ts covers the refusals in
 * more shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertMonetizedHost, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { deleteProxyHost, updateProxyHost } from '../../src/lib/models/proxy-hosts';
import { isHostMonetized } from '../../ee/monetization/host-guard';
import { first } from '@/src/lib/db/ops';

const ADMIN_ID = 1;

let monetized = 0;
let paused = 0;
let plain = 0;
let listId = 0;

async function accessListOf(hostId: number): Promise<number | null | undefined> {
  return (await first(ctx.db.select({ accessListId: schema.proxyHosts.accessListId }).from(schema.proxyHosts)
    .where(eq(schema.proxyHosts.id, hostId)).limit(1)))?.accessListId;
}

async function monetizationRows(): Promise<number[]> {
  return (await ctx.db.select({ proxyHostId: schema.monetizationHosts.proxyHostId }).from(schema.monetizationHosts))
    .map((row) => row.proxyHostId)
    .sort((a, b) => a - b);
}

beforeEach(async () => {
  ctx.db = createTestDb();
  const now = new Date().toISOString();
  listId = (await first(ctx.db.insert(schema.accessLists).values({ name: 'Staff', createdAt: now, updatedAt: now }).returning()))!.id;
  monetized = (await insertProxyHost(ctx.db, { name: 'Paid', domains: JSON.stringify(['paid.example.com']) })).id;
  paused = (await insertProxyHost(ctx.db, { name: 'Paused', domains: JSON.stringify(['paused.example.com']) })).id;
  plain = (await insertProxyHost(ctx.db, { name: 'Plain', domains: JSON.stringify(['plain.example.com']) })).id;
  await insertMonetizedHost(ctx.db, monetized);
  await insertMonetizedHost(ctx.db, paused, { enabled: false });
});

describe('isHostMonetized', () => {
  it('returns a real boolean', async () => {
    expect(await isHostMonetized(monetized)).toBe(true);
    expect(await isHostMonetized(paused)).toBe(false);
    expect(await isHostMonetized(plain)).toBe(false);
    expect(await isHostMonetized(999)).toBe(false);
  });
});

describe('updateProxyHost and a monetized host', () => {
  it('refuses an access list or forward auth on a monetized host and changes nothing', async () => {
    await expect(updateProxyHost(monetized, { accessListId: listId }, ADMIN_ID)).rejects.toThrow(/API monetization is on/);
    await expect(updateProxyHost(monetized, { ingressiForwardAuth: { enabled: true } }, ADMIN_ID)).rejects.toThrow(/API monetization is on/);
    expect(await accessListOf(monetized)).toBeNull();
  });

  it('allows an access list on a host that is not monetized, or whose monetization is off', async () => {
    await expect(updateProxyHost(plain, { accessListId: listId }, ADMIN_ID)).resolves.toMatchObject({ accessListId: listId });
    expect(await accessListOf(plain)).toBe(listId);
    await expect(updateProxyHost(paused, { accessListId: listId }, ADMIN_ID)).resolves.toMatchObject({ accessListId: listId });
    expect(await accessListOf(paused)).toBe(listId);
  });
});

describe('deleteProxyHost and monetization settings', () => {
  it('keeps the settings of other hosts and removes those of the deleted one', async () => {
    await deleteProxyHost(plain, ADMIN_ID);
    expect(await monetizationRows()).toEqual([monetized, paused].sort((a, b) => a - b));
    await deleteProxyHost(monetized, ADMIN_ID);
    expect(await monetizationRows()).toEqual([paused]);
  });
});
