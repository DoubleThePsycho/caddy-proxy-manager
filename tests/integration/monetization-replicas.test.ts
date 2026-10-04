/**
 * API monetization with several web replicas on one database
 * (ee/monetization/engine.ts, hosts.ts; D9).
 *
 * Two engine states stand for two replicas that keep their own counters
 * (no high availability shared state). Each flush adds what its replica
 * counted to the stored balance, free-request count and ledger, and takes
 * back what the other wrote: nothing is lost or counted twice, whatever the
 * order of the flushes. Turning monetization on is refused while several
 * replicas are live on a PostgreSQL database (cluster_nodes) without shared
 * state, and allowed with it. An administrator's change on one replica reaches the other's
 * index through the invalidation bus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { insertConsumer, insertKey, insertMonetizedHost, insertPlan, insertProxyHost } from '../helpers/monetization';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import {
  decideGate,
  flushUsage,
  MONETIZATION_CHANNEL,
  reloadMonetization,
  resetMonetizationEngineForTests,
  type GateDecision,
} from '../../ee/monetization/engine';
import { assertStandalone } from '../../ee/monetization/hosts';
import { ensureGateSecret } from '../../ee/monetization/settings';
import { setSharedStateForTests } from '../../ee/high-availability/shared-state/connection';
import { EventBus, getEventBus } from '../../src/lib/db/events';
import { first } from '../../src/lib/db/ops';

type EngineGlobal = typeof globalThis & { __ingressiMonetization?: unknown };
const engines = globalThis as EngineGlobal;

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

type World = { token: string; hostId: number; consumerId: number; key: string };

async function seed(plan: { price: number; included: number }, balance: number): Promise<World> {
  const row = await insertPlan(ctx.db, { name: 'Standard', pricePerRequestMicros: plan.price, includedRequestsPerMonth: plan.included });
  const consumer = await insertConsumer(ctx.db, { planId: row.id, balanceMicros: balance });
  const { raw } = await insertKey(ctx.db, consumer.id);
  const host = await insertProxyHost(ctx.db);
  await insertMonetizedHost(ctx.db, host.id);
  const { token } = await ensureGateSecret();
  return { token, hostId: host.id, consumerId: consumer.id, key: raw };
}

/** Two replicas' engine states over the same database. */
async function twoReplicas(): Promise<{ a: unknown; b: unknown }> {
  resetMonetizationEngineForTests();
  await reloadMonetization({ quiet: true });
  const a = engines.__ingressiMonetization;
  engines.__ingressiMonetization = undefined;
  await reloadMonetization({ quiet: true });
  const b = engines.__ingressiMonetization;
  return { a, b };
}

async function on<T>(engine: unknown, fn: () => T | Promise<T>): Promise<T> {
  engines.__ingressiMonetization = engine;
  return await fn();
}

function call(world: World, now = T0): GateDecision {
  return decideGate({
    gateToken: world.token,
    hostId: String(world.hostId),
    header: (name) => (name === 'authorization' ? `Bearer ${world.key}` : null),
    now,
  });
}

function calls(world: World, count: number): GateDecision[] {
  return Array.from({ length: count }, (_, i) => call(world, T0 + i));
}

async function consumerRow(id: number) {
  return (await first(ctx.db.select().from(schema.monetizationConsumers).where(eq(schema.monetizationConsumers.id, id)).limit(1)))!;
}

async function ledger(consumerId: number) {
  return await ctx.db.select().from(schema.monetizationLedger).where(eq(schema.monetizationLedger.consumerId, consumerId));
}

beforeEach(() => {
  ctx.db = createTestDb();
  vi.spyOn(Date, 'now').mockReturnValue(T0);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSharedStateForTests(undefined);
  resetMonetizationEngineForTests();
});

describe('usage counted on two replicas', () => {
  it('is written once: balances, ledger and free requests add up whichever replica flushes first', async () => {
    const world = await seed({ price: 1_000, included: 0 }, 10_000);
    const { a, b } = await twoReplicas();
    const onA = await on(a, () => calls(world, 3));
    const onB = await on(b, () => calls(world, 4));
    expect([...onA, ...onB].every((decision) => decision.allow)).toBe(true);

    await on(b, () => flushUsage(T0));
    await on(a, () => flushUsage(T0));
    // A second flush has nothing left to write.
    expect(await on(a, () => flushUsage(T0))).toEqual({ consumers: 0, requests: 0, chargedMicros: 0 });
    expect(await on(b, () => flushUsage(T0))).toEqual({ consumers: 0, requests: 0, chargedMicros: 0 });

    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(10_000 - 7_000);
    const rows = await ledger(world.consumerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'usage', amountMicros: -7_000, requests: 7, freeRequests: 0, balanceAfterMicros: 3_000 });

    // Each flush takes back the stored balance, the other replica's charges included.
    expect((await on(a, () => calls(world, 2))).every((decision) => decision.allow)).toBe(true);
    await on(a, () => flushUsage(T0));
    expect((await on(b, () => calls(world, 1))).every((decision) => decision.allow)).toBe(true);
    await on(b, () => flushUsage(T0));
    expect((await consumerRow(world.consumerId)).balanceMicros).toBe(0);
    expect(await on(b, () => call(world))).toMatchObject({ allow: false, status: 402, error: 'payment_required' });
  });

  it('adds the free requests of the month instead of overwriting them', async () => {
    const world = await seed({ price: 1_000, included: 100 }, 0);
    const { a, b } = await twoReplicas();
    await on(a, () => calls(world, 2));
    await on(b, () => calls(world, 3));
    await on(a, () => flushUsage(T0));
    await on(b, () => flushUsage(T0));
    expect(await consumerRow(world.consumerId)).toMatchObject({ freeUsageMonth: '2026-10', freeUsageCount: 5, balanceMicros: 0 });

    // A replica that flushes later still adds to what the other wrote.
    await on(a, () => calls(world, 4));
    await on(a, () => flushUsage(T0));
    expect((await consumerRow(world.consumerId)).freeUsageCount).toBe(9);
    const rows = await ledger(world.consumerId);
    expect(rows[0]).toMatchObject({ requests: 9, freeRequests: 9 });
    expect(rows[0].amountMicros + 0).toBe(0);
  });

  it('keeps one replica exactly as before', async () => {
    const world = await seed({ price: 1_000, included: 2 }, 5_000);
    resetMonetizationEngineForTests();
    await reloadMonetization({ quiet: true });
    calls(world, 3);
    await flushUsage(T0);
    calls(world, 2);
    await flushUsage(T0);
    expect(await consumerRow(world.consumerId)).toMatchObject({ freeUsageCount: 2, balanceMicros: 2_000 });
    expect((await ledger(world.consumerId))[0]).toMatchObject({ requests: 5, freeRequests: 2, amountMicros: -3_000 });
  });
});

describe('turning monetization on', () => {
  it('is allowed for one replica', async () => {
    await expect(assertStandalone()).resolves.toBeUndefined();
  });

  it.runIf(testDbIsPostgres())('is refused while other replicas use the database without shared state, and allowed with it', async () => {
    // Two other replicas with a recent heartbeat (src/lib/cluster-nodes.ts).
    const now = new Date().toISOString();
    for (const nodeId of ['web-2', 'web-3']) {
      await ctx.db.insert(schema.clusterNodes).values({
        nodeId,
        hostname: `${nodeId}.example.com`,
        version: '1.2.3',
        schemaVersion: '0055_cluster_node_instance',
        firstSeenAt: now,
        startedAt: now,
        lastHeartbeatAt: now,
      });
    }
    await expect(assertStandalone()).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('web replicas use this database'),
    });
    setSharedStateForTests({ redis: {} as never, namespace: 'test:replicas:' });
    await expect(assertStandalone()).resolves.toBeUndefined();
  });
});

describe.runIf(testDbIsPostgres())('an administrator\'s change on another replica (PostgreSQL)', () => {
  it('reaches this replica\'s index through the bus', async () => {
    vi.restoreAllMocks();
    const world = await seed({ price: 1_000, included: 0 }, 10_000);
    resetMonetizationEngineForTests();
    await reloadMonetization({ quiet: true });
    await getEventBus().start();
    const other = new EventBus({ mode: 'postgres' });
    try {
      await other.start();
      expect(call(world).allow).toBe(true);

      // The other replica disables the consumer and announces it.
      await ctx.db.update(schema.monetizationConsumers).set({ status: 'disabled' }).where(eq(schema.monetizationConsumers.id, world.consumerId));
      await other.publish(MONETIZATION_CHANNEL, `consumer:${world.consumerId}`);
      const deadline = Date.now() + 10_000;
      while (call(world).allow && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(call(world)).toMatchObject({ allow: false, status: 403, error: 'consumer_disabled' });
    } finally {
      await other.stop();
      await getEventBus().stop();
    }
  });
});
