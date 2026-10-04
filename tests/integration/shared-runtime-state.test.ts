/**
 * Process state that several replicas must share (src/lib/db/README.md,
 * "Events and shared state"), in the 0054 tables, on both dialects:
 *
 * - the rate limiters' database store (src/lib/rate-limit.ts) keeps the
 *   memory store's rules: blocks, windows, fixed windows, resets, places held
 *   for attempts in progress (and given back by themselves after a crash);
 * - short-lived entries (src/lib/shared-runtime-state.ts): put, get, take
 *   once, expiry;
 * - the prune job removes what expired and keeps the rest;
 * - a sync-seal nonce is used up once (src/lib/sync-nonces.ts).
 *
 * On PostgreSQL, a second pool on the same database stands for a second
 * replica: attempts count across both, concurrent reservations never exceed
 * the limit, an entry is taken once, a sign-in's second factor finds the
 * first step another replica noted, and a sealed payload's nonce issued by
 * one replica is accepted once by another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';
import { createPgReplica } from '../helpers/pg-test-db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { createRateLimiter, HOLD_MS, type RateLimiter, type RateLimiterOptions } from '../../src/lib/rate-limit';
import { authRateLimitRetentionMs, defineRuntimeEntries, pruneSharedRuntimeState } from '../../src/lib/shared-runtime-state';
import { completedSignIn, noteFirstSignInStep } from '../../src/lib/sign-in-activity';
import { createSyncKeyResponse } from '../../src/lib/sync-crypto';
import { shareSyncNonce, useSyncNonce } from '../../src/lib/sync-nonces';

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
let clock = T0;

function limiter(options: Partial<RateLimiterOptions> = {}): RateLimiter {
  return createRateLimiter({ name: 'test-shared', maxAttempts: 3, windowMs: 60_000, blockMs: 600_000, store: 'database', ...options });
}

async function counterRows() {
  return await ctx.db.select().from(schema.rateLimitCounters);
}

beforeEach(() => {
  ctx.db = createTestDb();
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => vi.restoreAllMocks());

describe('rate limiter counters in the database', () => {
  it('block on the maxAttempts-th attempt for blockMs, and a blocked key stays as it is', async () => {
    const limit = limiter();
    expect(await limit.registerAttempt('ip:192.0.2.1')).toEqual({ blocked: false });
    clock += 1_000;
    expect(await limit.registerAttempt('ip:192.0.2.1')).toEqual({ blocked: false });
    expect(await limit.isRateLimited('ip:192.0.2.1')).toEqual({ blocked: false });
    clock += 1_000;
    expect(await limit.registerAttempt('ip:192.0.2.1')).toEqual({ blocked: true, retryAfterMs: 600_000 });
    clock += 100_000;
    expect(await limit.isRateLimited('ip:192.0.2.1')).toEqual({ blocked: true, retryAfterMs: 500_000 });
    expect(await limit.registerAttempt('ip:192.0.2.1')).toEqual({ blocked: true, retryAfterMs: 500_000 });
    expect(await limit.isRateLimited('ip:192.0.2.2')).toEqual({ blocked: false });

    // The block ends; counting starts again.
    clock += 500_000;
    expect(await limit.isRateLimited('ip:192.0.2.1')).toEqual({ blocked: false });
    expect(await limit.registerAttempt('ip:192.0.2.1')).toEqual({ blocked: false });
    expect(await limit.registerAttempt('ip:192.0.2.1')).toEqual({ blocked: false });
    expect((await limit.registerAttempt('ip:192.0.2.1')).blocked).toBe(true);
  });

  it('forget attempts once their window ends', async () => {
    const limit = limiter();
    await limit.registerAttempt('k');
    await limit.registerAttempt('k');
    clock += 60_000;
    // A fresh window: two more attempts do not block.
    expect(await limit.registerAttempt('k')).toEqual({ blocked: false });
    clock += 59_999;
    expect(await limit.registerAttempt('k')).toEqual({ blocked: false });
    expect((await limit.registerAttempt('k')).blocked).toBe(true);
  });

  it('block on the first attempt with a limit of one', async () => {
    const once = limiter({ maxAttempts: 1 });
    expect(await once.registerAttempt('k')).toEqual({ blocked: true, retryAfterMs: 600_000 });
    expect((await once.isRateLimited('k')).blocked).toBe(true);
  });

  it('refuse only until the current window ends with blockMs "window"', async () => {
    const fixed = limiter({ blockMs: 'window' });
    expect((await fixed.registerAttempt('k')).blocked).toBe(false);
    clock = T0 + 20_000;
    expect((await fixed.registerAttempt('k')).blocked).toBe(false);
    clock = T0 + 40_000;
    expect(await fixed.registerAttempt('k')).toEqual({ blocked: true, retryAfterMs: 20_000 });
    clock = T0 + 59_000;
    expect(await fixed.isRateLimited('k')).toEqual({ blocked: true, retryAfterMs: 1_000 });
    clock = T0 + 60_000;
    expect((await fixed.isRateLimited('k')).blocked).toBe(false);
    expect((await fixed.registerAttempt('k')).blocked).toBe(false);
  });

  it('unblock a key that is reset', async () => {
    const limit = limiter();
    for (let i = 0; i < 3; i++) await limit.registerAttempt('k');
    expect((await limit.isRateLimited('k')).blocked).toBe(true);
    await limit.resetAttempts('k');
    expect((await limit.isRateLimited('k')).blocked).toBe(false);
    expect((await limit.registerAttempt('k')).blocked).toBe(false);
  });

  it('count places held for attempts in progress until they are given back', async () => {
    const limit = limiter();
    await limit.registerAttempt('k');
    const first = await limit.reserveAttempt('k');
    const second = await limit.reserveAttempt('k');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // One failure plus two attempts in flight reach the limit of 3.
    expect(await limit.reserveAttempt('k')).toBeNull();
    // Holding a place is not a failure.
    expect((await limit.isRateLimited('k')).blocked).toBe(false);

    await first!();
    await first!();
    const third = await limit.reserveAttempt('k');
    expect(third).not.toBeNull();
    expect(await limit.reserveAttempt('k')).toBeNull();
    await second!();
    await third!();
    expect(await limit.reserveAttempt('other')).not.toBeNull();
  });

  it('refuse a place on a blocked key, and keep places across a reset', async () => {
    const limit = limiter();
    for (let i = 0; i < 3; i++) await limit.registerAttempt('k');
    expect(await limit.reserveAttempt('k')).toBeNull();
    await limit.resetAttempts('k');
    const held = await Promise.all([limit.reserveAttempt('k'), limit.reserveAttempt('k'), limit.reserveAttempt('k')]);
    expect(held.every(Boolean)).toBe(true);
    await limit.resetAttempts('k');
    expect(await limit.reserveAttempt('k')).toBeNull();
  });

  it('give back by themselves the places a stopped replica never released', async () => {
    const limit = limiter();
    for (let i = 0; i < 3; i++) expect(await limit.reserveAttempt('k')).not.toBeNull();
    expect(await limit.reserveAttempt('k')).toBeNull();
    clock += HOLD_MS;
    expect(await limit.reserveAttempt('k')).not.toBeNull();
  });

  it('keep each limiter apart, store long keys by their hash, and clear only their own', async () => {
    const a = limiter({ name: 'test-a', maxAttempts: 2 });
    const b = limiter({ name: 'test-b', maxAttempts: 2 });
    await a.registerAttempt('shared-key');
    expect((await a.registerAttempt('shared-key')).blocked).toBe(true);
    expect((await b.isRateLimited('shared-key')).blocked).toBe(false);

    const long = 'x'.repeat(500);
    await b.registerAttempt(`${long}1`);
    expect((await b.isRateLimited(`${long}2`)).blocked).toBe(false);
    expect((await b.registerAttempt(`${long}1`)).blocked).toBe(true);
    expect((await counterRows()).every((row) => row.bucket.length < 300)).toBe(true);

    await b.clear();
    expect((await counterRows()).map((row) => row.bucket)).toEqual(['test-a:shared-key']);
    expect(() => createRateLimiter({ name: 'Not valid', maxAttempts: 1, windowMs: 1, blockMs: 1 })).toThrow(/Invalid rate limiter name/);
  });
});

describe('short-lived entries in the database', () => {
  const isText = (value: unknown): value is string => typeof value === 'string';

  it('are read until they expire and taken once', async () => {
    const entries = defineRuntimeEntries<string>('test-entries', { maxEntries: 10, isValue: isText, store: 'database' });
    await entries.put('a', 'first', 60_000);
    await entries.put('a', 'second', 60_000);
    expect(await entries.get('a')).toBe('second');
    expect(await entries.take('a')).toBe('second');
    expect(await entries.take('a')).toBeNull();

    await entries.put('b', 'soon gone', 1_000);
    clock += 1_000;
    expect(await entries.get('b')).toBeNull();
    expect(await entries.take('b')).toBeNull();

    await entries.put('c', 'kept', 60_000);
    await entries.delete('c');
    expect(await entries.get('c')).toBeNull();
  });

  it('ignore a stored value of the wrong shape', async () => {
    const entries = defineRuntimeEntries<string>('test-shape', { maxEntries: 10, isValue: isText, store: 'database' });
    await ctx.db.insert(schema.sharedRuntimeEntries).values({ key: 'test-shape:x', value: '{"not":"text"}', expiresAt: new Date(T0 + 60_000).toISOString() });
    expect(await entries.get('x')).toBeNull();
  });

  it('keep the memory store\'s rules in memory', async () => {
    const entries = defineRuntimeEntries<string>('test-memory', { maxEntries: 2, isValue: isText, store: 'memory' });
    await entries.put('a', 'one', 60_000);
    await entries.put('b', 'two', 60_000);
    await entries.put('c', 'three', 60_000);
    // The oldest went first.
    expect(await entries.get('a')).toBeNull();
    expect(await entries.take('b')).toBe('two');
    expect(await entries.take('b')).toBeNull();
    expect(await ctx.db.select().from(schema.sharedRuntimeEntries)).toEqual([]);
  });
});

describe('sync-seal nonces', () => {
  it('are used up once', async () => {
    const { nonce } = createSyncKeyResponse();
    await shareSyncNonce(nonce);
    expect(await useSyncNonce(nonce)).toBe(true);
    expect(await useSyncNonce(nonce)).toBe(false);
    expect(await useSyncNonce('AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(await useSyncNonce('not a nonce')).toBe(false);
  });

  it('expire', async () => {
    const { nonce } = createSyncKeyResponse();
    await shareSyncNonce(nonce);
    clock += 10 * 60_000;
    expect(await useSyncNonce(nonce)).toBe(false);
  });
});

describe('the prune job', () => {
  it('deletes what has expired and keeps the rest', async () => {
    const limit = limiter();
    await limit.registerAttempt('old');
    const entries = defineRuntimeEntries<string>('test-prune', { maxEntries: 10, isValue: (value): value is string => typeof value === 'string', store: 'database' });
    await entries.put('old', 'x', 1_000);
    await ctx.db.insert(schema.authRateLimits).values([
      { key: '192.0.2.1/sign-in/email', count: 1, lastRequest: T0 },
    ]);

    clock += 2_000;
    await entries.put('new', 'y', 60_000);
    await limit.registerAttempt('new');
    expect(await pruneSharedRuntimeState(clock)).toEqual({ entries: 1, rateLimitCounters: 0, authRateLimits: 0 });

    // The counter of 'old' lasts as long as its block would (blockMs).
    clock = T0 + 600_000 + 1;
    await ctx.db.insert(schema.authRateLimits).values({ key: '192.0.2.2/sign-in/email', count: 1, lastRequest: clock });
    expect(await pruneSharedRuntimeState(clock)).toEqual({ entries: 1, rateLimitCounters: 1, authRateLimits: 0 });
    expect((await counterRows()).map((row) => row.bucket)).toEqual(['test-shared:new']);

    clock = T0 + authRateLimitRetentionMs() + 1;
    expect((await pruneSharedRuntimeState(clock)).authRateLimits).toBe(1);
    expect((await ctx.db.select().from(schema.authRateLimits)).map((row) => row.key)).toEqual(['192.0.2.2/sign-in/email']);
    expect(await entries.get('new')).toBeNull();
  });
});

describe.runIf(testDbIsPostgres())('two replicas on one database (PostgreSQL)', () => {
  let replica: ReturnType<typeof createPgReplica>;
  let primary: TestDb;

  beforeEach(() => {
    primary = ctx.db;
    replica = createPgReplica();
  });

  afterEach(async () => {
    ctx.db = primary;
    await replica.close();
  });

  /** Runs `fn` as the other replica: its own pool and connections. */
  async function onReplica<T>(fn: () => Promise<T>): Promise<T> {
    ctx.db = replica.db as TestDb;
    try {
      return await fn();
    } finally {
      ctx.db = primary;
    }
  }

  it('count attempts made on either replica towards one limit', async () => {
    const onA = limiter();
    const onB = limiter();
    await onA.registerAttempt('account:alice');
    await onReplica(() => onB.registerAttempt('account:alice'));
    expect(await onA.registerAttempt('account:alice')).toEqual({ blocked: true, retryAfterMs: 600_000 });
    expect(await onReplica(() => onB.isRateLimited('account:alice'))).toEqual({ blocked: true, retryAfterMs: 600_000 });
  });

  it('never admit more concurrent attempts than the limit, whichever connection they use', async () => {
    const limit = limiter({ maxAttempts: 4 });
    const replicaLimit = limiter({ maxAttempts: 4 });
    // Ten attempts at once, through both replicas' pools.
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => limit.reserveAttempt('account:bob')),
      ...Array.from({ length: 5 }, () => {
        const db = replica.db as TestDb;
        const previous = ctx.db;
        ctx.db = db;
        const reserved = replicaLimit.reserveAttempt('account:bob');
        ctx.db = previous;
        return reserved;
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(4);
    const [row] = await counterRows();
    expect(row).toMatchObject({ bucket: 'test-shared:account:bob', held: 4, attempts: 0 });
  });

  it('let one replica take what another left, once', async () => {
    const entries = defineRuntimeEntries<string>('test-replicas', { maxEntries: 10, isValue: (value): value is string => typeof value === 'string' });
    await entries.put('challenge', 'value', 60_000);
    const taken = await Promise.all([entries.take('challenge'), onReplica(() => entries.take('challenge')), entries.take('challenge')]);
    expect(taken.filter((value) => value === 'value')).toHaveLength(1);
  });

  it('accept a sealed payload\'s nonce on the replica the push reached, once', async () => {
    const { nonce } = createSyncKeyResponse();
    await shareSyncNonce(nonce);
    expect(await onReplica(() => useSyncNonce(nonce))).toBe(true);
    expect(await useSyncNonce(nonce)).toBe(false);
    expect(await onReplica(() => useSyncNonce(nonce))).toBe(false);
    // A nonce no replica shared is refused, never accepted on trust.
    expect(await useSyncNonce(createSyncKeyResponse().nonce)).toBe(false);
  });

  it('complete a sign-in on the replica its second factor reached', async () => {
    await noteFirstSignInStep(41, { path: '/sign-in/ldap', body: { directoryId: 2 } });
    expect(await onReplica(() => completedSignIn(41, { path: '/two-factor/verify-totp' }))).toEqual({ method: 'ldap', providerId: 'ldap:2' });
    // Used once, wherever.
    expect(await completedSignIn(41, { path: '/two-factor/verify-totp' })).toEqual({ method: 'password', providerId: null });
    const rows = await ctx.db.select().from(schema.sharedRuntimeEntries).where(eq(schema.sharedRuntimeEntries.key, 'sign-in-first-step:41'));
    expect(rows).toEqual([]);
  });
});
