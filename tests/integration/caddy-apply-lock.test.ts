/**
 * applyCaddyConfig under the cluster lock "caddy-apply" (src/lib/caddy.ts),
 * against a fake Caddy admin API that serves what was last posted to it:
 * applies never overlap and each builds from the database when it starts,
 * so data committed while another apply pushes ends up in Caddy; a burst
 * coalesces; an unchanged document is not pushed again unless Caddy changed;
 * the decision uses the cluster's record, never this process's stale copy;
 * an apply whose lock was lost applies again; an unreachable Caddy fails
 * the apply within the connect timeout instead of holding the lock for
 * minutes; and, on PostgreSQL, an apply waits for another replica holding
 * the lock.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';

vi.unmock('@/src/lib/caddy');

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import * as schema from '../../src/lib/db/schema';
import { config } from '../../src/lib/config';
import {
  applyCaddyConfig,
  buildCaddyDocument,
  CADDY_APPLY_LOCK,
  CADDY_CONNECT_TIMEOUT_MS,
  getAppliedConfigHash,
  getCaddyLiveConfigHash,
  getLastAppliedConfigHash,
} from '../../src/lib/caddy';
import { getCaddyApplyStatus, readCaddyApplyState, recordCaddyApplyResult } from '../../src/lib/caddy-apply-status';
import { isClusterLockHeld, withClusterLock } from '../../src/lib/db/locks';
import { createPgReplica } from '../helpers/pg-test-db';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The fake Caddy: GET /config/ serves the configuration last posted to /load. */
const caddy = {
  current: '{"apps":{}}',
  loads: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  /** While set, posts to /load wait for it. */
  hold: null as Promise<void> | null,
  /** Runs when a post arrives, before it is taken. */
  onLoad: null as (() => Promise<void>) | null,
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => void (async () => {
      if (request.url === '/load' && request.method === 'POST') {
        const body = Buffer.concat(chunks).toString('utf8');
        caddy.loads.push(body);
        caddy.inFlight += 1;
        caddy.maxInFlight = Math.max(caddy.maxInFlight, caddy.inFlight);
        if (caddy.hold) await caddy.hold;
        if (caddy.onLoad) await caddy.onLoad();
        caddy.current = body;
        caddy.inFlight -= 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(request.url === '/config/' ? caddy.current : '{}');
    })());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  ctx.db = createTestDb();
  (config as { caddyApiUrl: string }).caddyApiUrl = baseUrl;
  Object.assign(caddy, { current: '{"apps":{}}', loads: [], inFlight: 0, maxInFlight: 0, hold: null, onLoad: null });
});

async function addHost(name: string) {
  const t = new Date().toISOString();
  await ctx.db.insert(schema.proxyHosts).values({
    name, domains: JSON.stringify([`${name}.example.com`]), upstreams: '["backend:8080"]', createdAt: t, updatedAt: t,
  });
}

describe('applyCaddyConfig under the cluster lock', () => {
  it('applies one at a time, each built from the database when it starts', async () => {
    await addHost('alpha');
    const gate = deferred();
    caddy.hold = gate.promise;
    const first = applyCaddyConfig();
    await vi.waitFor(() => expect(caddy.inFlight).toBe(1));

    // Committed while the first push is in flight, before and after the second apply is asked for.
    await addHost('beta');
    const second = applyCaddyConfig();
    await addHost('gamma');
    await sleep(50);
    expect(caddy.loads).toHaveLength(1);

    caddy.hold = null;
    gate.resolve();
    await Promise.all([first, second]);
    expect(caddy.maxInFlight).toBe(1);
    expect(caddy.loads).toHaveLength(2);
    expect(caddy.loads[0]).toContain('alpha.example.com');
    expect(caddy.loads[0]).not.toContain('beta.example.com');
    // The last push carries the latest data, and it is what Caddy serves.
    expect(caddy.loads[1]).toContain('beta.example.com');
    expect(caddy.loads[1]).toContain('gamma.example.com');
    expect(caddy.current).toBe(caddy.loads[1]);
    const state = await readCaddyApplyState();
    expect(state).toMatchObject({ documentHash: sha256(caddy.loads[1]), liveHash: sha256(caddy.current) });
    expect(await getCaddyApplyStatus()).toMatchObject({ ok: true, consecutiveFailures: 0 });
  });

  it('runs a burst of applies made during a push as one more push with all of their changes', async () => {
    await addHost('alpha');
    const gate = deferred();
    caddy.hold = gate.promise;
    const first = applyCaddyConfig();
    await vi.waitFor(() => expect(caddy.inFlight).toBe(1));
    await addHost('beta');
    const burst = [applyCaddyConfig(), applyCaddyConfig(), applyCaddyConfig()];
    await addHost('gamma');
    caddy.hold = null;
    gate.resolve();
    await Promise.all([first, ...burst]);
    expect(caddy.loads).toHaveLength(2);
    expect(caddy.loads[1]).toContain('beta.example.com');
    expect(caddy.loads[1]).toContain('gamma.example.com');
  });

  it('does not push a document Caddy already serves, and pushes it again once Caddy serves something else', async () => {
    await addHost('alpha');
    await applyCaddyConfig();
    expect(caddy.loads).toHaveLength(1);
    const { generation } = await readCaddyApplyState();

    await applyCaddyConfig();
    expect(caddy.loads).toHaveLength(1);
    // Nothing was written either.
    expect((await readCaddyApplyState()).generation).toBe(generation);

    // Caddy restarted onto its default configuration.
    caddy.current = '{"apps":{"http":{"servers":{}}}}';
    await applyCaddyConfig();
    expect(caddy.loads).toHaveLength(2);
    expect(caddy.current).toBe(caddy.loads[1]);
  });

  it('clears a recorded failure when Caddy already serves the document', async () => {
    await addHost('alpha');
    await applyCaddyConfig();
    await recordCaddyApplyResult({ ok: false, code: 'CADDY_UNREACHABLE', message: 'Unable to reach Caddy API' });
    await applyCaddyConfig();
    expect(caddy.loads).toHaveLength(1);
    expect(await getCaddyApplyStatus()).toMatchObject({ ok: true, code: null, consecutiveFailures: 0 });
  });

  it('never skips a push because this process\'s copy of the last applied hash is stale', async () => {
    await addHost('alpha');
    await applyCaddyConfig();
    const ownCopy = getLastAppliedConfigHash();
    expect(ownCopy).toBe(sha256(caddy.current));

    // Another replica applies a document with beta to the same Caddy and records it.
    await addHost('beta');
    const other = JSON.stringify(await buildCaddyDocument());
    caddy.current = other;
    await recordCaddyApplyResult({ ok: true }, { applied: { documentHash: sha256(other), liveHash: sha256(other) } });
    // The monitor of this replica expects what the other replica applied.
    expect(await getAppliedConfigHash()).toBe(sha256(other));

    // Then beta goes again: the database matches what this process applied last.
    await ctx.db.delete(schema.proxyHosts).where(eq(schema.proxyHosts.name, 'beta'));
    await applyCaddyConfig();
    expect(caddy.loads).toHaveLength(2);
    expect(caddy.loads[1]).toBe(caddy.loads[0]);
    expect(caddy.current).not.toContain('beta.example.com');
  });

  it('applies again when another apply was recorded while it pushed (its lock was lost)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await addHost('alpha');
      let interfered = false;
      caddy.onLoad = async () => {
        if (interfered) return;
        interfered = true;
        // What another replica's apply writes when it took the lock meanwhile.
        await recordCaddyApplyResult({ ok: true });
      };
      await applyCaddyConfig();
      expect(caddy.loads).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lost its cluster lock'));
      expect(await readCaddyApplyState()).toMatchObject({
        documentHash: sha256(caddy.loads[1]),
        liveHash: sha256(caddy.current),
        status: { ok: true },
      });
    } finally {
      warn.mockRestore();
    }
  });

  // Regression: a Caddy that is down does not always refuse the connection
  // (its address answers nothing, or its container's name resolves elsewhere
  // once it stopped). The apply waited minutes for the operating system to
  // give up, holding the lock, and every apply behind it (an instance sync a
  // slave received) timed out. 192.0.2.1 (TEST-NET-1) answers nothing.
  it('gives up on a Caddy that cannot be reached within the connect timeout, so applies queued behind it go ahead', async () => {
    await addHost('alpha');
    (config as { caddyApiUrl: string }).caddyApiUrl = 'http://192.0.2.1:2019';
    const startedAt = Date.now();
    const first = applyCaddyConfig();
    await vi.waitFor(() => expect(isClusterLockHeld(CADDY_APPLY_LOCK)).toBe(true));
    // Asked for while the first holds the lock: it waits for it, then tries on its own.
    const queued = applyCaddyConfig();
    await expect(first).rejects.toMatchObject({ code: 'CADDY_UNREACHABLE' });
    await expect(queued).rejects.toMatchObject({ code: 'CADDY_UNREACHABLE' });
    expect(Date.now() - startedAt).toBeLessThan(2 * CADDY_CONNECT_TIMEOUT_MS + 5_000);
    expect(isClusterLockHeld(CADDY_APPLY_LOCK)).toBe(false);
    expect(await getCaddyApplyStatus()).toMatchObject({ ok: false, code: 'CADDY_UNREACHABLE' });

    // Caddy is back.
    (config as { caddyApiUrl: string }).caddyApiUrl = baseUrl;
    await applyCaddyConfig();
    expect(caddy.loads).toHaveLength(1);
    expect(caddy.loads[0]).toContain('alpha.example.com');
    expect(await getCaddyApplyStatus()).toMatchObject({ ok: true });
  }, 40_000);

  it('reads no live configuration from a Caddy that cannot be reached, within the connect timeout', async () => {
    (config as { caddyApiUrl: string }).caddyApiUrl = 'http://192.0.2.1:2019';
    const startedAt = Date.now();
    expect(await getCaddyLiveConfigHash()).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(CADDY_CONNECT_TIMEOUT_MS + 3_000);
  }, 30_000);

  it.skipIf(!testDbIsPostgres())('waits while another replica holds the apply lock', async () => {
    await addHost('alpha');
    const replica = createPgReplica();
    try {
      const release = deferred();
      let held!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve; });
      const holder = withClusterLock(CADDY_APPLY_LOCK, async () => {
        held();
        await release.promise;
      }, { pool: replica.pool });
      await holding;
      const apply = applyCaddyConfig();
      await sleep(200);
      expect(caddy.loads).toHaveLength(0);
      release.resolve();
      await holder;
      await apply;
      expect(caddy.loads).toHaveLength(1);
      expect(caddy.loads[0]).toContain('alpha.example.com');
    } finally {
      await replica.close();
    }
  });
});
