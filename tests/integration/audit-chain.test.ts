/**
 * Audit log hash chain (src/lib/audit-chain.ts), its verification, retention
 * and export (ee/audit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import * as schema from '@/src/lib/db/schema';
import {
  auditActorDigest,
  canonicalAuditJson,
  computeAuditHash,
  insertAuditEvent,
} from '@/src/lib/audit-chain';
import { createAuditEvent } from '@/src/lib/models/audit';
import { deleteUser } from '@/src/lib/models/user';
import { verifyAuditChain } from '@/ee/audit/verify';
import { pruneAuditEvents, AUDIT_RETENTION_KEY } from '@/ee/audit/retention';
import { createAuditExportStream, csvCell, parseExportQuery } from '@/ee/audit/export';
import { setSetting } from '@/src/lib/settings';
import { asc } from '@/src/lib/db/ops';

const { logAuditEvent } = await vi.importActual<typeof import('@/src/lib/audit')>('@/src/lib/audit');

async function rows() {
  return await ctx.db.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.id));
}

async function seedUser(email: string): Promise<number> {
  const now = new Date().toISOString();
  const [user] = await ctx.db.insert(schema.users).values({
    email, name: email, role: 'admin', provider: 'credentials', subject: email, status: 'active',
    createdAt: now, updatedAt: now,
  }).returning();
  return user.id;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

beforeEach(async () => {
  await ctx.db.delete(schema.auditEvents);
  await ctx.db.delete(schema.settings);
  await ctx.db.delete(schema.users);
});

describe('hash chain on insert', () => {
  it('links every event to the previous one and hashes its fields', async () => {
    await logAuditEvent({ userId: null, action: 'proxy_host_created', entityType: 'proxy_host', entityId: 3, summary: 'Created', data: { a: 1 } });
    await createAuditEvent({ userId: null, action: 'password_changed', entityType: 'user', summary: 'Changed', data: '{"b":2}' });
    await insertAuditEvent({ action: 'x', entityType: 'y' });

    const [first, second, third] = await rows();
    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    expect(first.data).toBe('{"a":1}');
    expect(second.data).toBe('{"b":2}');
    for (const row of [first, second, third]) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.hash).toBe(computeAuditHash(row.prevHash, {
        createdAt: row.createdAt, actorDigest: row.actorDigest, action: row.action, entityType: row.entityType,
        entityId: row.entityId, summary: row.summary, data: row.data,
      }));
    }
  });

  it('starts the chain after events recorded before it existed', async () => {
    await ctx.db.insert(schema.auditEvents).values({ action: 'old', entityType: 'legacy', createdAt: '2026-01-01T00:00:00.000Z' });
    await logAuditEvent({ action: 'new', entityType: 'proxy_host' });
    const [legacy, chained] = await rows();
    expect(legacy.hash).toBeNull();
    expect(chained.prevHash).toBeNull();
    expect(chained.hash).not.toBeNull();
    const result = await verifyAuditChain();
    expect(result).toMatchObject({ ok: true, checked: 1, unchainedEvents: 1, anchorId: chained.id, anchorHash: null });
  });

  it('does not depend on the row id and uses a fixed key order', () => {
    const fields = { createdAt: '2026-10-01T00:00:00.000Z', actorDigest: auditActorDigest(7), action: 'a', entityType: 'b', entityId: null, summary: 's', data: null };
    expect(canonicalAuditJson(fields)).toBe(
      `{"v":1,"createdAt":"2026-10-01T00:00:00.000Z","actor":"${auditActorDigest(7)}","action":"a","entityType":"b","entityId":null,"summary":"s","data":null}`
    );
    expect(computeAuditHash('p', fields)).toBe(computeAuditHash('p', { ...fields }));
    expect(computeAuditHash('p', fields)).not.toBe(computeAuditHash('q', fields));
    expect(auditActorDigest(null)).toBeNull();
    expect(auditActorDigest(1)).not.toBe(auditActorDigest(2));
  });

  it('logAuditEvent stays synchronous and never throws', async () => {
    const spy = vi.spyOn(ctx.db, 'transaction').mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
    try {
      expect(await logAuditEvent({ action: 'a', entityType: 'b' })).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('createAuditEvent still rejects on database errors', async () => {
    const spy = vi.spyOn(ctx.db, 'transaction').mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
    try {
      await expect(createAuditEvent({ userId: null, action: 'a', entityType: 'b' })).rejects.toThrow('SQLITE_BUSY');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('verifyAuditChain', () => {
  async function seed(count: number, userId: number | null = null) {
    for (let i = 0; i < count; i++) {
      await logAuditEvent({ userId, action: `action_${i}`, entityType: 'proxy_host', entityId: i, summary: `Event ${i}`, data: { i } });
    }
    return rows();
  }

  it('reports an empty log as intact', async () => {
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 0, firstMismatchId: null, anchoredAt: null, headHash: null });
  });

  it('accepts an untouched chain and reports its head', async () => {
    const events = await seed(5);
    const result = await verifyAuditChain();
    expect(result).toMatchObject({
      ok: true,
      checked: 5,
      firstMismatchId: null,
      anchoredAt: events[0].createdAt,
      anchorId: events[0].id,
      headId: events[4].id,
      headHash: events[4].hash,
    });
  });

  it('finds a changed event', async () => {
    const events = await seed(5);
    await ctx.db.update(schema.auditEvents).set({ summary: 'Nothing to see' }).where(eq(schema.auditEvents.id, events[2].id));
    const result = await verifyAuditChain();
    expect(result).toMatchObject({ ok: false, firstMismatchId: events[2].id, checked: 3 });
    expect(result.reason).toMatch(/contents/);
  });

  it('finds an event removed from the middle', async () => {
    const events = await seed(5);
    await ctx.db.delete(schema.auditEvents).where(eq(schema.auditEvents.id, events[2].id));
    const result = await verifyAuditChain();
    expect(result).toMatchObject({ ok: false, firstMismatchId: events[3].id });
    expect(result.reason).toMatch(/does not link/);
  });

  it('finds a recomputed hash that breaks the link to the next event', async () => {
    const events = await seed(4);
    const forged = { ...events[1], summary: 'Forged' };
    await ctx.db.update(schema.auditEvents).set({
      summary: forged.summary,
      hash: computeAuditHash(forged.prevHash, { ...forged }),
    }).where(eq(schema.auditEvents.id, events[1].id));
    expect(await verifyAuditChain()).toMatchObject({ ok: false, firstMismatchId: events[2].id });
  });

  it('finds an event attributed to another user', async () => {
    const alice = await seedUser('alice@example.com');
    const bob = await seedUser('bob@example.com');
    const events = await seed(3, alice);
    await ctx.db.update(schema.auditEvents).set({ userId: bob }).where(eq(schema.auditEvents.id, events[1].id));
    const result = await verifyAuditChain();
    expect(result).toMatchObject({ ok: false, firstMismatchId: events[1].id });
    expect(result.reason).toMatch(/user/);
  });

  it('stays intact when a user is deleted and their events lose the user id', async () => {
    const alice = await seedUser('alice@example.com');
    await seed(3, alice);
    await deleteUser(alice);
    expect((await rows()).every((row) => row.userId === null)).toBe(true);
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
  });

  it('flags an event without a hash after the chain started', async () => {
    await seed(2);
    await ctx.db.insert(schema.auditEvents).values({ action: 'sneaky', entityType: 'x', createdAt: new Date().toISOString() });
    const [, , sneaky] = await rows();
    expect(await verifyAuditChain()).toMatchObject({ ok: false, firstMismatchId: sneaky.id });
  });
});

describe('retention', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');

  async function seedAt(createdAt: string, n = 1) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(createdAt));
    try {
      for (let i = 0; i < n; i++) await logAuditEvent({ action: 'a', entityType: 'b', summary: createdAt });
    } finally {
      vi.useRealTimers();
    }
  }

  it('keeps everything when retention is 0 (the default)', async () => {
    await seedAt('2020-01-01T00:00:00.000Z', 3);
    expect(await pruneAuditEvents(now)).toBe(0);
    expect(await rows()).toHaveLength(3);
  });

  it('deletes the oldest events and leaves a verifiable chain anchored at the oldest kept one', async () => {
    await setSetting(AUDIT_RETENTION_KEY, { days: 30 });
    await seedAt('2026-08-01T00:00:00.000Z', 3);
    await seedAt('2026-09-20T00:00:00.000Z', 2);
    const before = await rows();

    expect(await pruneAuditEvents(now)).toBe(3);
    const after = await rows();
    expect(after.map((row) => row.id)).toEqual([before[3].id, before[4].id]);
    expect(await verifyAuditChain()).toMatchObject({
      ok: true, checked: 2, anchorId: before[3].id, anchorHash: before[2].hash, anchoredAt: '2026-09-20T00:00:00.000Z',
    });
    // New events still link to the chain.
    await logAuditEvent({ action: 'later', entityType: 'b' });
    expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 3 });
  });

  it('always keeps the newest event so the chain keeps its head', async () => {
    await setSetting(AUDIT_RETENTION_KEY, { days: 1 });
    await seedAt('2026-01-01T00:00:00.000Z', 3);
    const before = await rows();
    expect(await pruneAuditEvents(now)).toBe(2);
    expect((await rows()).map((row) => row.id)).toEqual([before[2].id]);
    await logAuditEvent({ action: 'later', entityType: 'b' });
    const [, latest] = await rows();
    expect(latest.prevHash).toBe(before[2].hash);
  });
});

describe('export', () => {
  it('neutralizes spreadsheet formulas and quotes CSV fields', () => {
    expect(csvCell('=HYPERLINK("http://example.com")')).toBe(`"'=HYPERLINK(""http://example.com"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
  });

  it('parses formats and date ranges', () => {
    expect(parseExportQuery(new URLSearchParams())).toEqual({ format: 'csv', from: null, to: null });
    expect(parseExportQuery(new URLSearchParams('format=json&from=2026-10-01&to=2026-10-01'))).toEqual({
      format: 'json', from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T23:59:59.999Z',
    });
    expect(() => parseExportQuery(new URLSearchParams('format=xml'))).toThrow(/csv or json/);
    expect(() => parseExportQuery(new URLSearchParams('from=yesterday'))).toThrow(/ISO 8601/);
    expect(() => parseExportQuery(new URLSearchParams('from=2026-10-02&to=2026-10-01'))).toThrow(/after/);
  });

  it('streams CSV with a header row and every event in id order', async () => {
    await logAuditEvent({ action: 'a', entityType: 'b', summary: '=cmd|calc' });
    await logAuditEvent({ action: 'c', entityType: 'd', summary: 'two, words' });
    const csv = await readStream(createAuditExportStream({ format: 'csv', from: null, to: null }));
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('id,createdAt,userId,userEmail,userName,action,entityType,entityId,summary,data,prevHash,hash,actorDigest');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",'=cmd|calc,");
    expect(lines[2]).toContain(',"two, words",');
  });

  it('streams valid JSON that carries the hash chain', async () => {
    const alice = await seedUser('alice@example.com');
    await logAuditEvent({ userId: alice, action: 'a', entityType: 'b', data: { x: 1 } });
    await logAuditEvent({ action: 'c', entityType: 'd' });
    const parsed = JSON.parse(await readStream(createAuditExportStream({ format: 'json', from: null, to: null })));
    expect(parsed.hashChain).toEqual({ version: 1, algorithm: 'sha256' });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({ action: 'a', userEmail: 'alice@example.com', data: '{"x":1}' });
    expect(parsed.events[1].prevHash).toBe(parsed.events[0].hash);
    // The exported fields are enough to recompute every hash.
    for (const event of parsed.events) {
      expect(computeAuditHash(event.prevHash, event)).toBe(event.hash);
    }
  });

  it('exports an empty JSON document when nothing matches', async () => {
    await logAuditEvent({ action: 'a', entityType: 'b' });
    const parsed = JSON.parse(await readStream(createAuditExportStream({ format: 'json', from: '2099-01-01T00:00:00.000Z', to: null })));
    expect(parsed.events).toEqual([]);
  });
});

describe('hash chain inside a caller transaction', () => {
  it('records events logged while the connection already holds a transaction', async () => {
    await ctx.db.transaction(async () => {
      await logAuditEvent({ userId: null, action: 'inside_tx', entityType: 'test' });
    });
    await insertAuditEvent({ action: 'after_tx', entityType: 'test' });
    const stored = await rows();
    expect(stored.map((row) => row.action)).toEqual(['inside_tx', 'after_tx']);
    expect(stored[1].prevHash).toBe(stored[0].hash);
    expect((await verifyAuditChain()).ok).toBe(true);
  });
});
