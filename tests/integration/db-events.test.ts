/**
 * The invalidation bus (src/lib/db/events.ts) and what rides on it.
 *
 * On both dialects: the in-process bus SQLite uses (one process) delivers to
 * this process's handlers, after a transaction it was used in.
 *
 * On PostgreSQL, two buses on the test database stand for two replicas,
 * each with its own LISTEN connection: a message from one reaches the
 * other (and itself, marked as its own); one sent inside a transaction
 * arrives when it commits and never when it (or its savepoint) rolls back; a
 * listening connection the server ends is opened again and every handler is
 * asked to read again (resync). countReplicas counts one process on
 * SQLite and the live replicas of cluster_nodes on PostgreSQL. A cached value (src/lib/db/cached-value.ts) reads itself again when another
 * replica announces a change, and after a resync.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';
import { createPgReplica } from '../helpers/pg-test-db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import {
  countReplicas,
  EventBus,
  getEventBus,
  startEventBus,
  stopEventBus,
  type BusEvent,
} from '../../src/lib/db/events';
import { CACHED_VALUE_CHANNEL, defineCachedValue } from '../../src/lib/db/cached-value';
import { execRaw, first } from '../../src/lib/db/ops';

const CHANNEL = 'test-events';

/** Waits until `check` holds (the bus delivers asynchronously). */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the bus');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function recorder() {
  const events: BusEvent[] = [];
  const messages = () => events.flatMap((event) => (event.kind === 'message' ? [event] : []));
  const resyncs = () => events.filter((event) => event.kind === 'resync').length;
  return { events, messages, resyncs, handler: (event: BusEvent) => void events.push(event) };
}

beforeEach(() => {
  ctx.db = createTestDb();
});

describe('the in-process bus (one process: SQLite)', () => {
  it('delivers a message to every handler of its channel, as this process\'s own', async () => {
    const bus = new EventBus({ mode: 'local' });
    const a = recorder();
    const b = recorder();
    const other = recorder();
    bus.subscribe(CHANNEL, a.handler);
    bus.subscribe(CHANNEL, b.handler);
    bus.subscribe('test-other', other.handler);
    expect(await bus.publish(CHANNEL, 'one')).toBe(true);
    expect(a.messages()).toEqual([{ kind: 'message', channel: CHANNEL, payload: 'one', self: true }]);
    expect(b.messages()).toHaveLength(1);
    expect(other.events).toEqual([]);
  });

  it('stops calling a handler once unsubscribed, and a failing handler stops no other', async () => {
    const bus = new EventBus({ mode: 'local' });
    const kept = recorder();
    const dropped = recorder();
    bus.subscribe(CHANNEL, () => {
      throw new Error('handler failure');
    });
    bus.subscribe(CHANNEL, kept.handler);
    const unsubscribe = bus.subscribe(CHANNEL, dropped.handler);
    unsubscribe();
    expect(await bus.publish(CHANNEL)).toBe(true);
    expect(kept.messages()).toEqual([{ kind: 'message', channel: CHANNEL, payload: null, self: true }]);
    expect(dropped.events).toEqual([]);
  });

  it('refuses channel names and payloads it cannot carry', async () => {
    const bus = new EventBus({ mode: 'local' });
    expect(() => bus.subscribe('Not A Channel', () => {})).toThrow(/Invalid event channel/);
    await expect(bus.publish('a'.repeat(65))).rejects.toThrow(/Invalid event channel/);
    await expect(bus.publish(CHANNEL, 'x'.repeat(1001))).rejects.toThrow(/at most 1000/);
    await expect(bus.publish(CHANNEL, 'nul\u0000')).rejects.toThrow(/at most 1000/);
  });

  it.skipIf(testDbIsPostgres())('delivers a message published inside a transaction after it, when the change is committed', async () => {
    const bus = new EventBus({ mode: 'local' });
    const seen: Array<string | null> = [];
    bus.subscribe(CHANNEL, async () => {
      const row = await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'events_test')).limit(1));
      seen.push(row?.value ?? null);
    });
    await ctx.db.transaction(async (tx) => {
      await tx.insert(schema.settings).values({ key: 'events_test', value: '"written"', updatedAt: new Date().toISOString() });
      await bus.publish(CHANNEL, 'changed');
      // Not delivered inside the transaction.
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await until(() => seen.length === 1);
    expect(seen).toEqual(['"written"']);
  });

  it('counts one replica', async () => {
    expect(await countReplicas(new EventBus({ mode: 'local' }))).toBe(1);
  });
});

describe.runIf(testDbIsPostgres())('LISTEN/NOTIFY between replicas (PostgreSQL)', () => {
  const buses: EventBus[] = [];

  function replicaBus(): EventBus {
    const bus = new EventBus({ mode: 'postgres', reconnectMinMs: 50, reconnectMaxMs: 200, heartbeatMs: 250, heartbeatTimeoutMs: 1_000 });
    buses.push(bus);
    return bus;
  }

  afterEach(async () => {
    for (const bus of buses.splice(0)) await bus.stop();
  });

  it('delivers a message to the other replica and back to the publisher as its own', async () => {
    const a = replicaBus();
    const b = replicaBus();
    const seenByA = recorder();
    const seenByB = recorder();
    a.subscribe(CHANNEL, seenByA.handler);
    b.subscribe(CHANNEL, seenByB.handler);
    await a.start();
    await b.start();
    expect(a.status()).toMatchObject({ mode: 'postgres', started: true, listening: true });

    expect(await a.publish(CHANNEL, 'proxy-host:7')).toBe(true);
    await until(() => seenByB.messages().length === 1 && seenByA.messages().length === 1);
    expect(seenByB.messages()).toEqual([{ kind: 'message', channel: CHANNEL, payload: 'proxy-host:7', self: false }]);
    expect(seenByA.messages()).toEqual([{ kind: 'message', channel: CHANNEL, payload: 'proxy-host:7', self: true }]);
  });

  it('delivers a message sent inside a transaction when it commits, never after a rollback', async () => {
    const a = replicaBus();
    const b = replicaBus();
    const seenByB = recorder();
    b.subscribe(CHANNEL, seenByB.handler);
    await a.start();
    await b.start();

    await ctx.db.transaction(async () => {
      await a.publish(CHANNEL, 'committed');
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Not before the commit.
      expect(seenByB.messages()).toEqual([]);
    });
    await until(() => seenByB.messages().length === 1);

    await expect(ctx.db.transaction(async () => {
      await a.publish(CHANNEL, 'rolled-back');
      throw new Error('roll back');
    })).rejects.toThrow('roll back');

    await ctx.db.transaction(async (tx) => {
      // A savepoint that rolls back takes its message with it.
      await tx.transaction(async () => {
        await a.publish(CHANNEL, 'savepoint');
        throw new Error('savepoint');
      }).catch(() => undefined);
      await a.publish(CHANNEL, 'outer');
    });
    await until(() => seenByB.messages().length === 2);
    // Anything else would have arrived by now: the notifications are queued in order.
    await a.publish(CHANNEL, 'marker');
    await until(() => seenByB.messages().some((event) => event.payload === 'marker'));
    expect(seenByB.messages().map((event) => event.payload)).toEqual(['committed', 'outer', 'marker']);
  });

  it('sends a message from a read-only transaction on its own', async () => {
    const a = replicaBus();
    const b = replicaBus();
    const seenByB = recorder();
    b.subscribe(CHANNEL, seenByB.handler);
    await a.start();
    await b.start();
    await ctx.db.transaction(async () => {
      expect(await a.publish(CHANNEL, 'read-only')).toBe(true);
    }, { readOnly: true });
    await until(() => seenByB.messages().length === 1);
  });

  it('reconnects after losing its connection and asks every handler to read again', async () => {
    const a = replicaBus();
    const b = replicaBus();
    const seenByB = recorder();
    b.subscribe(CHANNEL, seenByB.handler);
    await a.start();
    await b.start();
    // The first connection resyncs too: nothing loaded before it is trusted.
    await until(() => seenByB.resyncs() === 1);
    const pid = b.status().backendPid;
    expect(pid).toBeGreaterThan(0);

    // The server ends the listening connection (a restart, an administrator).
    await execRaw(sql`SELECT pg_terminate_backend(${pid})`, ctx.db);
    await until(() => seenByB.resyncs() === 2 && b.status().listening);
    expect(b.status().reconnects).toBe(1);
    expect(b.status().backendPid).not.toBe(pid);

    // It hears the other replica again.
    await a.publish(CHANNEL, 'after-reconnect');
    await until(() => seenByB.messages().some((event) => event.payload === 'after-reconnect'));
  });

  it('counts the live replicas of cluster_nodes, not the listening connections', async () => {
    const a = replicaBus();
    await a.start();
    // No replica has joined: this process alone.
    expect(await countReplicas(a)).toBe(1);
    const now = new Date().toISOString();
    const row = { hostname: 'web.example.com', version: '1.2.3', schemaVersion: '0055_cluster_node_instance', firstSeenAt: now, startedAt: now };
    await ctx.db.insert(schema.clusterNodes).values([
      { ...row, nodeId: 'web-1', lastHeartbeatAt: now },
      { ...row, nodeId: 'web-2', lastHeartbeatAt: now },
      { ...row, nodeId: 'web-3', lastHeartbeatAt: now, stoppedAt: now },
      { ...row, nodeId: 'web-4', lastHeartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    ]);
    // Two live ones, plus this process, which has not joined.
    expect(await countReplicas(a)).toBe(3);
  });
});

describe.runIf(testDbIsPostgres())('a cached value across replicas (PostgreSQL)', () => {
  const NAME = 'events test value';

  afterAll(async () => {
    await stopEventBus();
  });

  async function storedValue(): Promise<string> {
    const row = await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, 'events_cached')).limit(1));
    return row?.value ?? 'none';
  }

  it('reads itself again when another replica announces a change, and after a resync', async () => {
    const replica = createPgReplica();
    const other = new EventBus({ mode: 'postgres' });
    try {
      // This process: its bus and a value it keeps in memory.
      await startEventBus();
      const value = defineCachedValue<string>(NAME, { load: storedValue, fallback: 'fallback', ttlMs: 3_600_000 });
      await value.refresh();
      expect(value.current()).toBe('none');

      // The other replica changes the row on its own connections and announces it.
      await other.start();
      const stamp = new Date().toISOString();
      await replica.db.insert(schema.settings).values({ key: 'events_cached', value: 'first', updatedAt: stamp });
      await other.publish(CACHED_VALUE_CHANNEL, NAME);
      await until(() => value.current() === 'first');

      // A change this process never hears of (its listener was down): the resync reads it.
      await replica.db.update(schema.settings).set({ value: 'second' }).where(eq(schema.settings.key, 'events_cached'));
      const pid = getEventBus().status().backendPid;
      await execRaw(sql`SELECT pg_terminate_backend(${pid})`, ctx.db);
      await until(() => value.current() === 'second', 20_000);
    } finally {
      await other.stop();
      await replica.close();
    }
  });
});
