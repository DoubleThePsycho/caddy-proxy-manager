/**
 * The leader lease (ee/high-availability/cluster): acquisition with SET NX PX
 * and a fencing epoch, renewal with the compare-and-renew script, release,
 * the guarded replica pointer and node reports, against a fake Redis that
 * runs the scripts; and the LeaseKeeper's renewal schedule and fencing
 * deadline, including Redis going away and a lease taken over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeRedis, type FakeRedis } from '../helpers/fake-redis';
import { RedisClient, RedisUnavailableError } from '@/ee/high-availability/cluster/redis-client';
import {
  ACQUIRE_SCRIPT,
  RedisLeaseStore,
  leaseKeys,
  parseLeaseValue,
  type LeaseRecord,
  type LeaseStore,
  type ReplicaPointer,
} from '@/ee/high-availability/cluster/lease-store';
import { LeaseKeeper, fenceMarginMs, renewIntervalMs } from '@/ee/high-availability/cluster/lease';
import type { HaRedisConfig } from '@/ee/high-availability/cluster/config';
import type { NodeReport } from '@/ee/high-availability/cluster/types';

const bulk = (value: string) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;

/** A fake Redis that runs the lease scripts and the node hash, with expiries on a clock the test moves. */
function leaseServer() {
  const expiries = new Map<string, number>();
  const hashes = new Map<string, Map<string, string>>();
  const state = { now: 1_000_000 };
  function expire(store: Map<string, string>) {
    for (const [key, at] of expiries) {
      if (at <= state.now) {
        store.delete(key);
        expiries.delete(key);
      }
    }
  }
  const extra = (args: string[], store: Map<string, string>): string | undefined => {
    expire(store);
    const name = args[0].toUpperCase();
    if (name === 'EVAL') {
      const [, script, count, ...rest] = args;
      const keys = rest.slice(0, Number(count));
      const argv = rest.slice(Number(count));
      switch (script.split('\n', 1)[0]) {
        case '-- ingressi:ha:acquire': {
          if (store.has(keys[0])) return '$-1\r\n';
          let epoch = Number(store.get(keys[1]) ?? '0') + 1;
          if (epoch <= Number(argv[4])) epoch = Number(argv[4]) + 1;
          store.set(keys[1], String(epoch));
          const value = `${argv[0]}|${epoch}|${argv[1]}|${argv[3]}`;
          store.set(keys[0], value);
          expiries.set(keys[0], state.now + Number(argv[2]));
          return bulk(value);
        }
        case '-- ingressi:ha:renew':
          if (store.get(keys[0]) !== argv[0]) return ':0\r\n';
          expiries.set(keys[0], state.now + Number(argv[1]));
          return ':1\r\n';
        case '-- ingressi:ha:release':
          if (store.get(keys[0]) !== argv[0]) return ':0\r\n';
          store.delete(keys[0]);
          expiries.delete(keys[0]);
          return ':1\r\n';
        case '-- ingressi:ha:pointer':
          if (store.get(keys[0]) !== argv[0]) return ':0\r\n';
          store.set(keys[1], argv[1]);
          return ':1\r\n';
        default:
          return '-NOSCRIPT unknown\r\n';
      }
    }
    if (name === 'HSET') {
      const hash = hashes.get(args[1]) ?? new Map<string, string>();
      hashes.set(args[1], hash);
      const added = hash.has(args[2]) ? 0 : 1;
      hash.set(args[2], args[3]);
      return `:${added}\r\n`;
    }
    if (name === 'HGETALL') {
      const hash = hashes.get(args[1]) ?? new Map<string, string>();
      return `*${hash.size * 2}\r\n${[...hash].map(([field, value]) => bulk(field) + bulk(value)).join('')}`;
    }
    if (name === 'HDEL') {
      const hash = hashes.get(args[1]);
      let removed = 0;
      for (const field of args.slice(2)) if (hash?.delete(field)) removed++;
      return `:${removed}\r\n`;
    }
    return undefined;
  };
  return { extra, state, expiries, hashes };
}

function redisConfig(overrides: Partial<HaRedisConfig>): HaRedisConfig {
  return {
    mode: 'standalone',
    addresses: ['127.0.0.1:1'],
    masterName: null,
    db: 0,
    username: null,
    password: null,
    sentinelPassword: null,
    tls: { enabled: false, insecureSkipVerify: false },
    keyPrefix: 'ingressi-ha',
    ...overrides,
  };
}

const servers: FakeRedis[] = [];
const clients: RedisClient[] = [];
async function server(options: Parameters<typeof startFakeRedis>[0] = {}) {
  const started = await startFakeRedis(options);
  servers.push(started);
  return started;
}
function client(config: HaRedisConfig) {
  const created = new RedisClient(config, 2_000);
  clients.push(created);
  return created;
}

afterEach(async () => {
  for (const created of clients.splice(0)) created.close();
  await Promise.all(servers.splice(0).map((started) => started.close()));
});

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

describe('RedisLeaseStore', () => {
  it('takes a free lease with SET NX PX and a fencing epoch, and refuses a held one', async () => {
    const fake = leaseServer();
    const redis = await server({ password: 'lease-password', extra: fake.extra });
    const store = new RedisLeaseStore(client(redisConfig({ addresses: [redis.address], password: 'lease-password' })), 'ingressi-ha');

    const first = await store.acquire(TOKEN_A, 'web-1', 15_000, 0);
    expect(first).toMatchObject({ token: TOKEN_A, epoch: 1, nodeId: 'web-1' });
    expect(await store.acquire(TOKEN_B, 'web-2', 15_000, 0)).toBeNull();
    expect(await store.read()).toMatchObject({ nodeId: 'web-1', epoch: 1 });

    const evalCall = redis.commands.find((command) => command[0] === 'EVAL')!;
    expect(evalCall.slice(2, 5)).toEqual(['2', '{ingressi-ha}:lease', '{ingressi-ha}:epoch']);
    expect(evalCall.slice(5, 8)).toEqual([TOKEN_A, 'web-1', '15000']);
    expect(ACQUIRE_SCRIPT).toContain("redis.call('SET', KEYS[1], value, 'NX', 'PX', ARGV[3])");
    expect(ACQUIRE_SCRIPT).toContain("redis.call('INCR', KEYS[2])");
    expect(redis.commands[0]).toEqual(['AUTH', 'lease-password']);
  });

  it('raises the epoch on every acquisition and keeps it above a known floor', async () => {
    const fake = leaseServer();
    const redis = await server({ extra: fake.extra });
    const store = new RedisLeaseStore(client(redisConfig({ addresses: [redis.address] })), 'ingressi-ha');
    const first = (await store.acquire(TOKEN_A, 'web-1', 15_000, 0))!;
    expect(await store.release(first)).toBe(true);
    expect((await store.acquire(TOKEN_B, 'web-2', 15_000, 0))!.epoch).toBe(2);
    redis.store.delete('{ingressi-ha}:lease');
    // Redis lost its counter, but object storage knows epoch 7.
    redis.store.delete('{ingressi-ha}:epoch');
    expect((await store.acquire(TOKEN_A, 'web-1', 15_000, 7))!.epoch).toBe(8);
  });

  it('renews and releases only its own lease', async () => {
    const fake = leaseServer();
    const redis = await server({ extra: fake.extra });
    const store = new RedisLeaseStore(client(redisConfig({ addresses: [redis.address] })), 'ingressi-ha');
    const lease = (await store.acquire(TOKEN_A, 'web-1', 15_000, 0))!;
    expect(await store.renew(lease, 15_000)).toBe(true);

    // The lease expired and another node took it: the old holder can neither renew nor release it.
    fake.state.now += 20_000;
    const taken = (await store.acquire(TOKEN_B, 'web-2', 15_000, 0))!;
    expect(taken.epoch).toBe(2);
    expect(await store.renew(lease, 15_000)).toBe(false);
    expect(await store.release(lease)).toBe(false);
    expect(await store.read()).toMatchObject({ nodeId: 'web-2' });
    expect(await store.release(taken)).toBe(true);
    expect(await store.read()).toBeNull();
  });

  it('writes the replica pointer only while the lease is held', async () => {
    const fake = leaseServer();
    const redis = await server({ extra: fake.extra });
    const store = new RedisLeaseStore(client(redisConfig({ addresses: [redis.address] })), 'ingressi-ha');
    const lease = (await store.acquire(TOKEN_A, 'web-1', 15_000, 0))!;
    const pointer: ReplicaPointer = { replicaId: 'e1-0011aabb', epoch: 1, nodeId: 'web-1', previous: null, updatedAt: '2026-10-03T10:00:00.000Z' };
    expect(await store.writePointer(lease, pointer)).toBe(true);
    expect(await store.readPointer()).toEqual(pointer);

    await store.release(lease);
    expect(await store.writePointer(lease, { ...pointer, replicaId: 'e1-ffffffff' })).toBe(false);
    expect((await store.readPointer())!.replicaId).toBe('e1-0011aabb');
  });

  it('keeps and forgets node reports', async () => {
    const fake = leaseServer();
    const redis = await server({ extra: fake.extra });
    const store = new RedisLeaseStore(client(redisConfig({ addresses: [redis.address] })), 'ingressi-ha');
    const report = (id: string): NodeReport => ({ id, role: 'standby', epoch: null, follow: null, lastRestore: null, updatedAt: '2026-10-03T10:00:00.000Z' });
    await store.reportNode(report('web-2'));
    await store.reportNode(report('web-1'));
    expect((await store.listNodes()).map((node) => node.id)).toEqual(['web-1', 'web-2']);
    await store.forgetNodes(['web-2']);
    expect((await store.listNodes()).map((node) => node.id)).toEqual(['web-1']);
  });

  it('ignores values that are not leases or pointers', () => {
    expect(parseLeaseValue('not|a|lease')).toBeNull();
    expect(parseLeaseValue(`${TOKEN_A}|1|web 1|5`)).toBeNull();
    expect(parseLeaseValue(`${TOKEN_A}|3|web-1|1700000000000`)).toMatchObject({ epoch: 3, nodeId: 'web-1' });
    expect(leaseKeys('a/b')).toEqual({ lease: '{a/b}:lease', epoch: '{a/b}:epoch', replica: '{a/b}:replica', nodes: '{a/b}:nodes' });
  });
});

describe('RedisClient', () => {
  it('signs in with a user, selects the database and reports the server going away', async () => {
    const redis = await server({ username: 'ha', password: 'secret' });
    const commander = client(redisConfig({ addresses: [redis.address], username: 'ha', password: 'secret', db: 3 }));
    expect(await commander.command(['PING'])).toBe('PONG');
    expect(redis.commands.slice(0, 2)).toEqual([['AUTH', 'ha', 'secret'], ['SELECT', '3']]);
    await redis.close();
    servers.splice(servers.indexOf(redis), 1);
    await expect(commander.command(['PING'])).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it('describes failures without the server\'s words', async () => {
    const redis = await server({ password: 'right' });
    const commander = client(redisConfig({ addresses: [redis.address], password: 'wrong' }));
    const error = await commander.command(['PING']).catch((caught) => caught);
    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(error.message).toContain('sign-in refused: the user name or password was not accepted');
    expect(error.message).not.toContain('invalid username-password pair');
  });

  it('asks the Sentinels for the master', async () => {
    const fake = leaseServer();
    const master = await server({ extra: fake.extra });
    const sentinel = await server({ sentinel: { masterName: 'leases', master: ['127.0.0.1', String(master.port)] } });
    const store = new RedisLeaseStore(
      client(redisConfig({ mode: 'sentinel', addresses: [sentinel.address], masterName: 'leases' })),
      'ingressi-ha'
    );
    expect(await store.acquire(TOKEN_A, 'web-1', 15_000, 0)).toMatchObject({ epoch: 1 });
    expect(sentinel.commands[0]).toEqual(['SENTINEL', 'get-master-addr-by-name', 'leases']);
    expect(master.commands.some((command) => command[0] === 'EVAL')).toBe(true);
  });

  it('follows a cluster redirect to the node that owns the keys', async () => {
    const fake = leaseServer();
    const owner = await server({ extra: fake.extra });
    const other = await server({ extra: (args) => (args[0] === 'EVAL' ? `-MOVED 4321 127.0.0.1:${owner.port}\r\n` : undefined) });
    const store = new RedisLeaseStore(client(redisConfig({ mode: 'cluster', addresses: [other.address] })), 'ingressi-ha');
    expect(await store.acquire(TOKEN_A, 'web-1', 15_000, 0)).toMatchObject({ epoch: 1 });
    expect(owner.commands.some((command) => command[0] === 'EVAL')).toBe(true);
  });
});

/** An in-memory store whose renewals the test scripts. */
class ScriptedStore implements LeaseStore {
  renewals: Array<boolean | Error | Promise<boolean>> = [];
  renewCalls: number[] = [];
  released = 0;
  async acquire() { return null; }
  async renew(_lease: LeaseRecord, _ttl: number, timeoutMs?: number) {
    this.renewCalls.push(timeoutMs ?? -1);
    const next = this.renewals.length > 0 ? this.renewals.shift()! : true;
    if (next instanceof Error) throw next;
    return next;
  }
  async release() { this.released++; return true; }
  async read() { return null; }
  async readPointer() { return null; }
  async writePointer() { return true; }
  async reportNode() {}
  async listNodes() { return []; }
  async forgetNodes() {}
  close() {}
}

const LEASE: LeaseRecord = { token: TOKEN_A, epoch: 4, nodeId: 'web-1', acquiredAt: 0, value: `${TOKEN_A}|4|web-1|0` };

describe('LeaseKeeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews every third of the TTL and moves the fencing deadline from the time each renewal was sent', async () => {
    const start = Date.now();
    const store = new ScriptedStore();
    const onLost = vi.fn();
    const renewed: number[] = [];
    const keeper = new LeaseKeeper(store, LEASE, start, { ttlMs: 15_000, onLost, onRenewed: (at) => renewed.push(at) });
    keeper.start();
    expect(keeper.fenceAt).toBe(start + 15_000 - fenceMarginMs(15_000));
    expect(renewIntervalMs(15_000)).toBe(5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.renewCalls).toHaveLength(1);
    expect(renewed).toEqual([start + 5_000 + 13_000]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.renewCalls).toHaveLength(13);
    expect(onLost).not.toHaveBeenCalled();
    keeper.stop();
  });

  it('fences at once when another node holds the lease', async () => {
    const store = new ScriptedStore();
    store.renewals = [false];
    const onLost = vi.fn();
    new LeaseKeeper(store, LEASE, Date.now(), { ttlMs: 15_000, onLost }).start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('another node holds the lease now');
  });

  it('keeps retrying while Redis is unreachable and fences before the lease can expire', async () => {
    const start = Date.now();
    const store = new ScriptedStore();
    store.renewals = Array.from({ length: 30 }, () => new Error('Redis or Valkey did not answer in time'));
    const onLost = vi.fn();
    const failures = vi.fn();
    new LeaseKeeper(store, LEASE, start, { ttlMs: 15_000, onLost, onRenewFailed: failures }).start();

    await vi.advanceTimersByTimeAsync(12_999);
    expect(onLost).not.toHaveBeenCalled();
    expect(failures.mock.calls.length).toBeGreaterThanOrEqual(7);
    // Every attempt is bounded by the time left before the deadline.
    expect(Math.max(...store.renewCalls)).toBeLessThanOrEqual(13_000 - 5_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('the lease could not be renewed before it expired');
    // The fence is local and earlier than the lease's expiry in Redis (start + TTL).
    expect(Date.now()).toBeLessThan(start + 15_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('fences when a renewal is confirmed only after the deadline', async () => {
    const store = new ScriptedStore();
    let answer: (ok: boolean) => void = () => {};
    store.renewals = [new Promise<boolean>((resolve) => { answer = resolve; })];
    const onLost = vi.fn();
    new LeaseKeeper(store, LEASE, Date.now(), { ttlMs: 15_000, onLost }).start();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    answer(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('gives the lease back on release and stops renewing', async () => {
    const store = new ScriptedStore();
    const keeper = new LeaseKeeper(store, LEASE, Date.now(), { ttlMs: 15_000, onLost: vi.fn() });
    keeper.start();
    expect(await keeper.release()).toBe(true);
    expect(store.released).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.renewCalls).toHaveLength(0);
  });
});
