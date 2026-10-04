// SPDX-License-Identifier: Elastic-2.0
/**
 * The cluster's shared state in Redis or Valkey: the leader lease with its
 * fencing epoch, the pointer to the replica the current leader writes, and
 * the nodes' self-reports. Every key shares one hash tag, so the scripts also
 * run on Redis Cluster.
 *
 *   {<prefix>}:lease    "<token>|<epoch>|<node>|<acquired ms>", set with SET NX PX
 *   {<prefix>}:epoch    the fencing counter, INCR on every acquisition
 *   {<prefix>}:replica  JSON ReplicaPointer, written only by the lease holder
 *   {<prefix>}:nodes    hash of node id -> JSON NodeReport
 */
import { RespError, type Resp } from "../resp";
import type { NodeReport } from "./types";
import { RedisUnavailableError, type RedisCommander } from "./redis-client";

/** A lease as stored. `value` is the exact string, which renewals and releases compare. */
export type LeaseRecord = {
  token: string;
  epoch: number;
  nodeId: string;
  acquiredAt: number;
  value: string;
};

/** Which replica (directory under the storage path) holds the cluster's newest database. */
export type ReplicaPointer = {
  replicaId: string;
  epoch: number;
  nodeId: string;
  /** The replica it was restored from, kept until the next promotion. */
  previous: string | null;
  updatedAt: string;
};

export interface LeaseStore {
  /** Takes the lease when nobody holds it; the epoch is above `minEpoch`. Null when it is held. */
  acquire(token: string, nodeId: string, ttlMs: number, minEpoch: number, timeoutMs?: number): Promise<LeaseRecord | null>;
  /** Extends our lease; false when it is no longer ours (expired, or taken over). */
  renew(lease: LeaseRecord, ttlMs: number, timeoutMs?: number): Promise<boolean>;
  /** Gives the lease up if it is still ours. */
  release(lease: LeaseRecord, timeoutMs?: number): Promise<boolean>;
  read(timeoutMs?: number): Promise<LeaseRecord | null>;
  readPointer(timeoutMs?: number): Promise<ReplicaPointer | null>;
  /** Writes the pointer only while `lease` is held; false otherwise. */
  writePointer(lease: LeaseRecord, pointer: ReplicaPointer, timeoutMs?: number): Promise<boolean>;
  reportNode(report: NodeReport, timeoutMs?: number): Promise<void>;
  listNodes(timeoutMs?: number): Promise<NodeReport[]>;
  forgetNodes(ids: string[], timeoutMs?: number): Promise<void>;
  close(): void;
}

// The first line names each script for logs and for the tests' fake server.
export const ACQUIRE_SCRIPT = `-- ingressi:ha:acquire
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
local epoch = redis.call('INCR', KEYS[2])
local floor = tonumber(ARGV[5])
if epoch <= floor then
  epoch = floor + 1
  redis.call('SET', KEYS[2], epoch)
end
local value = ARGV[1] .. '|' .. epoch .. '|' .. ARGV[2] .. '|' .. ARGV[4]
redis.call('SET', KEYS[1], value, 'NX', 'PX', ARGV[3])
return value`;

export const RENEW_SCRIPT = `-- ingressi:ha:renew
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

export const RELEASE_SCRIPT = `-- ingressi:ha:release
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export const WRITE_POINTER_SCRIPT = `-- ingressi:ha:pointer
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1`;

const TOKEN = /^[0-9a-f]{16,64}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const REPLICA_ID = /^e(\d{1,12})-[0-9a-f]{8}$/;

export function leaseKeys(prefix: string) {
  const tag = `{${prefix}}`;
  return { lease: `${tag}:lease`, epoch: `${tag}:epoch`, replica: `${tag}:replica`, nodes: `${tag}:nodes` };
}

/** Parses a stored lease value; null when it is not one of ours. */
export function parseLeaseValue(value: unknown): LeaseRecord | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const parts = value.split("|");
  if (parts.length !== 4) return null;
  const [token, epochText, nodeId, acquiredText] = parts;
  if (!TOKEN.test(token) || !/^\d{1,15}$/.test(epochText) || !NODE_ID.test(nodeId) || !/^\d{1,15}$/.test(acquiredText)) return null;
  return { token, epoch: Number(epochText), nodeId, acquiredAt: Number(acquiredText), value };
}

export function parsePointer(value: unknown): ReplicaPointer | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.replicaId !== "string" ||
      !REPLICA_ID.test(parsed.replicaId) ||
      typeof parsed.epoch !== "number" ||
      !Number.isSafeInteger(parsed.epoch) ||
      typeof parsed.nodeId !== "string" ||
      !NODE_ID.test(parsed.nodeId) ||
      (parsed.previous !== null && (typeof parsed.previous !== "string" || !REPLICA_ID.test(parsed.previous))) ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return {
      replicaId: parsed.replicaId,
      epoch: parsed.epoch,
      nodeId: parsed.nodeId,
      previous: (parsed.previous as string | null) ?? null,
      updatedAt: parsed.updatedAt.slice(0, 40),
    };
  } catch {
    return null;
  }
}

function parseReport(id: string, value: unknown): NodeReport | null {
  if (typeof value !== "string" || value.length > 4096 || !NODE_ID.test(id)) return null;
  try {
    const parsed = JSON.parse(value) as NodeReport;
    if (parsed?.id !== id || typeof parsed.role !== "string" || typeof parsed.updatedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function unexpected(reply: Resp): never {
  if (reply instanceof RespError) throw new RedisUnavailableError("Redis or Valkey refused the command (it must allow EVAL)");
  throw new RedisUnavailableError("Redis or Valkey answered unexpectedly");
}

export class RedisLeaseStore implements LeaseStore {
  private readonly keys: ReturnType<typeof leaseKeys>;

  constructor(
    private readonly redis: RedisCommander,
    prefix: string
  ) {
    this.keys = leaseKeys(prefix);
  }

  async acquire(token: string, nodeId: string, ttlMs: number, minEpoch: number, timeoutMs?: number): Promise<LeaseRecord | null> {
    const reply = await this.redis.command(
      ["EVAL", ACQUIRE_SCRIPT, "2", this.keys.lease, this.keys.epoch, token, nodeId, String(ttlMs), String(Date.now()), String(Math.max(0, minEpoch))],
      timeoutMs
    );
    if (reply === null) return null;
    const lease = parseLeaseValue(reply);
    if (!lease) unexpected(reply);
    return lease;
  }

  async renew(lease: LeaseRecord, ttlMs: number, timeoutMs?: number): Promise<boolean> {
    const reply = await this.redis.command(["EVAL", RENEW_SCRIPT, "1", this.keys.lease, lease.value, String(ttlMs)], timeoutMs);
    if (typeof reply !== "number") unexpected(reply);
    return reply === 1;
  }

  async release(lease: LeaseRecord, timeoutMs?: number): Promise<boolean> {
    const reply = await this.redis.command(["EVAL", RELEASE_SCRIPT, "1", this.keys.lease, lease.value], timeoutMs);
    if (typeof reply !== "number") unexpected(reply);
    return reply === 1;
  }

  async read(timeoutMs?: number): Promise<LeaseRecord | null> {
    const reply = await this.redis.command(["GET", this.keys.lease], timeoutMs);
    if (reply instanceof RespError) unexpected(reply);
    return reply === null ? null : parseLeaseValue(reply);
  }

  async readPointer(timeoutMs?: number): Promise<ReplicaPointer | null> {
    const reply = await this.redis.command(["GET", this.keys.replica], timeoutMs);
    if (reply instanceof RespError) unexpected(reply);
    return reply === null ? null : parsePointer(reply);
  }

  async writePointer(lease: LeaseRecord, pointer: ReplicaPointer, timeoutMs?: number): Promise<boolean> {
    const reply = await this.redis.command(
      ["EVAL", WRITE_POINTER_SCRIPT, "2", this.keys.lease, this.keys.replica, lease.value, JSON.stringify(pointer)],
      timeoutMs
    );
    if (typeof reply !== "number") unexpected(reply);
    return reply === 1;
  }

  async reportNode(report: NodeReport, timeoutMs?: number): Promise<void> {
    const reply = await this.redis.command(["HSET", this.keys.nodes, report.id, JSON.stringify(report)], timeoutMs);
    if (typeof reply !== "number") unexpected(reply);
  }

  async listNodes(timeoutMs?: number): Promise<NodeReport[]> {
    const reply = await this.redis.command(["HGETALL", this.keys.nodes], timeoutMs);
    if (!Array.isArray(reply)) unexpected(reply);
    const reports: NodeReport[] = [];
    for (let index = 0; index + 1 < reply.length; index += 2) {
      const id = reply[index];
      const report = typeof id === "string" ? parseReport(id, reply[index + 1]) : null;
      if (report) reports.push(report);
    }
    return reports.sort((a, b) => a.id.localeCompare(b.id));
  }

  async forgetNodes(ids: string[], timeoutMs?: number): Promise<void> {
    if (ids.length === 0) return;
    const reply = await this.redis.command(["HDEL", this.keys.nodes, ...ids], timeoutMs);
    if (typeof reply !== "number") unexpected(reply);
  }

  close(): void {
    this.redis.close();
  }
}
