/**
 * assertReplacementApproved (ee/approvals/guard.ts) became asynchronous. It
 * runs inside the transaction that replaces the whole configuration
 * (replaceConfiguration in src/lib/config-replace.ts: configuration import,
 * backup restore, configuration history rollback) and refuses (409) a
 * replacement that would change a host an enabled change approval policy
 * protects, before anything is written.
 *
 * Called without await, its rejection is lost and the protected host is
 * replaced anyway. approvals-paths.test.ts covers import and rollback in both
 * directions; this file pins the guard's own result and replaceConfiguration
 * itself: a protected host is refused and left alone, an unprotected one is
 * replaced, and a disabled policy protects nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertPolicy, proxyHost } from '../helpers/approvals';
import { insertUser } from '../helpers/custom-roles';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { readCurrentConfigContent, type ConfigContent } from '@/src/lib/config-content';
import { replaceConfiguration } from '@/src/lib/config-replace';
import { ApprovalRequiredError, assertReplacementApproved, protectedReplacementChanges } from '@/ee/approvals/guard';
import { first } from '@/src/lib/db/ops';

let prod = 0;
let dev = 0;

beforeEach(async () => {
  ctx.db = createTestDb();
  await insertUser(ctx.db, 1, 'admin');
  prod = await proxyHost(ctx.db, 'App', ['app.example.com'], ['prod']);
  dev = await proxyHost(ctx.db, 'Dev', ['dev.example.com'], ['dev']);
  // Protects every change of hosts tagged "prod".
  await insertPolicy(ctx.db, { name: 'Production' });
});

/** The current configuration with host `id` renamed. */
async function renamed(id: number, name: string): Promise<ConfigContent> {
  const content = await readCurrentConfigContent();
  content.tables.proxyHosts.find((row) => row.id === id)!.name = name;
  return content;
}

async function hostName(id: number): Promise<string | undefined> {
  return (await first(ctx.db.select({ name: schema.proxyHosts.name }).from(schema.proxyHosts).where(eq(schema.proxyHosts.id, id)).limit(1)))?.name;
}

describe('assertReplacementApproved', () => {
  it('resolves for an unprotected change and rejects with 409 for a protected one', async () => {
    const current = await readCurrentConfigContent();
    await expect(assertReplacementApproved(ctx.db, current, await readCurrentConfigContent())).resolves.toBeUndefined();
    await expect(assertReplacementApproved(ctx.db, current, await renamed(dev, 'Dev 2'))).resolves.toBeUndefined();

    const error = await assertReplacementApproved(ctx.db, current, await renamed(prod, 'App 2')).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalRequiredError);
    expect(error).toMatchObject({ status: 409 });

    expect(await protectedReplacementChanges(ctx.db, current, await renamed(dev, 'Dev 2'))).toEqual([]);
    expect(await protectedReplacementChanges(ctx.db, current, await renamed(prod, 'App 2'))).toEqual([
      expect.objectContaining({ targetType: 'proxy_host', id: prod, operations: ['update'] }),
    ]);
  });
});

describe('replaceConfiguration', () => {
  it('refuses a replacement that changes a protected host and writes nothing', async () => {
    const next = await renamed(prod, 'Replaced');
    next.tables.proxyHosts.find((row) => row.id === dev)!.name = 'Dev replaced';
    await expect(replaceConfiguration(next, { mode: 'restore' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/would change hosts protected by the change approval policy "Production"/) });
    expect(await hostName(prod)).toBe('App');
    expect(await hostName(dev)).toBe('Dev');
  });

  // Regression shape: a guard that rejects everything (or an un-awaited one
  // whose rejection surfaces later) breaks the ordinary restore.
  it('replaces a configuration that leaves protected hosts alone', async () => {
    await expect(replaceConfiguration(await renamed(dev, 'Dev replaced'), { mode: 'restore' })).resolves.toEqual({ warning: null });
    expect(await hostName(dev)).toBe('Dev replaced');
    expect(await hostName(prod)).toBe('App');
  });

  it('replaces a protected host once its policy is disabled', async () => {
    await ctx.db.update(schema.approvalPolicies).set({ enabled: false });
    await expect(replaceConfiguration(await renamed(prod, 'Replaced'), { mode: 'restore' })).resolves.toEqual({ warning: null });
    expect(await hostName(prod)).toBe('Replaced');
  });
});
