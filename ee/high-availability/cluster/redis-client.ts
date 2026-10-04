// SPDX-License-Identifier: Elastic-2.0
/**
 * A long-lived Redis or Valkey connection for the leader lease, built on the
 * RESP2 client of the certificate storage test (../resp.ts): standalone,
 * Sentinel (asks the Sentinels where the master is) and cluster (follows
 * MOVED redirects). One command at a time; every command has a deadline.
 *
 * Failures are RedisUnavailableError with fixed messages: nothing a server
 * sends is logged or shown.
 */
import {
  KNOWN_REDIS_ERRORS,
  RespError,
  describeSocketError,
  joinAddress,
  openConnection,
  sendCommand,
  splitAddress,
  type Resp,
  type RespConnection,
} from "../resp";
import type { HaRedisConfig } from "./config";

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
/** Errors after which another server (or a new master) must be asked. */
const RECONNECT_CODES = new Set(["READONLY", "MASTERDOWN", "LOADING", "CLUSTERDOWN", "TRYAGAIN", "ASK"]);

/** Redis or Valkey cannot be used right now; the message is safe to show. */
export class RedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisUnavailableError";
  }
}

/** The part of the client the lease store uses; tests pass a fake. */
export interface RedisCommander {
  /** Runs one command; a RespError reply is returned, connection problems throw RedisUnavailableError. */
  command(args: string[], timeoutMs?: number): Promise<Resp>;
  close(): void;
}

const MESSAGES = { expired: "Redis or Valkey did not answer in time", timeout: "Redis or Valkey did not answer in time" };

function describeReply(error: RespError): string {
  return KNOWN_REDIS_ERRORS[error.code] ?? "the server answered with an error";
}

function redirectTarget(error: RespError, current: string | null): string | null {
  const [, , where] = error.text.split(" ");
  if (!where) return null;
  const colon = where.lastIndexOf(":");
  if (colon < 0) return null;
  const host = where.slice(0, colon).replace(/^\[|\]$/g, "") || (current ? splitAddress(current).host : "");
  return joinAddress(host, where.slice(colon + 1));
}

export class RedisClient implements RedisCommander {
  private connection: RespConnection | null = null;
  private address: string | null = null;
  /** Cluster mode: the node a MOVED redirect named, tried first from then on. */
  private preferred: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly config: HaRedisConfig,
    private readonly defaultTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
  ) {}

  command(args: string[], timeoutMs: number = this.defaultTimeoutMs): Promise<Resp> {
    const run = () => this.run(args, Date.now() + Math.max(1, timeoutMs));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.closed = true;
    this.drop();
  }

  private drop() {
    this.connection?.close();
    this.connection = null;
    this.address = null;
  }

  private async run(args: string[], deadline: number): Promise<Resp> {
    if (this.closed) throw new RedisUnavailableError("the connection was closed");
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const connection = await this.connect(deadline);
      let reply: Resp;
      try {
        reply = await sendCommand(connection, args, deadline, MESSAGES);
      } catch (error) {
        this.drop();
        throw new RedisUnavailableError(describeSocketError(error));
      }
      if (reply instanceof RespError) {
        if (reply.code === "MOVED" && this.config.mode === "cluster") {
          const target = redirectTarget(reply, this.address);
          if (!target) throw new RedisUnavailableError("the cluster answered with a redirect that cannot be followed");
          this.drop();
          this.preferred = target;
          continue;
        }
        if (RECONNECT_CODES.has(reply.code)) {
          this.drop();
          this.preferred = null;
          throw new RedisUnavailableError(describeReply(reply));
        }
      }
      return reply;
    }
    throw new RedisUnavailableError("the cluster kept redirecting the command");
  }

  private async connect(deadline: number): Promise<RespConnection> {
    if (this.connection?.usable) return this.connection;
    this.drop();
    const candidates =
      this.config.mode === "sentinel"
        ? [await this.findMaster(deadline)]
        : [...new Set([...(this.preferred ? [this.preferred] : []), ...this.config.addresses])];
    let problem = "no server could be reached";
    for (const address of candidates) {
      let connection: RespConnection | null = null;
      try {
        connection = await openConnection(address, this.config, deadline);
        await this.handshake(connection, deadline);
        this.connection = connection;
        this.address = address;
        return connection;
      } catch (error) {
        connection?.close();
        problem = `${address}: ${error instanceof RedisUnavailableError ? error.message : describeSocketError(error)}`;
      }
    }
    throw new RedisUnavailableError(problem);
  }

  private async handshake(connection: RespConnection, deadline: number) {
    if (this.config.password !== null) {
      const auth = await sendCommand(
        connection,
        this.config.username ? ["AUTH", this.config.username, this.config.password] : ["AUTH", this.config.password],
        deadline,
        MESSAGES
      );
      if (auth instanceof RespError) throw new RedisUnavailableError(`sign-in refused: ${describeReply(auth)}`);
    }
    if (this.config.db !== 0 && this.config.mode !== "cluster") {
      const select = await sendCommand(connection, ["SELECT", String(this.config.db)], deadline, MESSAGES);
      if (select instanceof RespError) throw new RedisUnavailableError(`database ${this.config.db} cannot be selected`);
    }
  }

  /** Asks the Sentinels, in order, where the master is. */
  private async findMaster(deadline: number): Promise<string> {
    let problem = "no Sentinel could be reached";
    for (const address of this.config.addresses) {
      let connection: RespConnection | null = null;
      try {
        connection = await openConnection(address, this.config, deadline);
        if (this.config.sentinelPassword !== null) {
          const auth = await sendCommand(connection, ["AUTH", this.config.sentinelPassword], deadline, MESSAGES);
          if (auth instanceof RespError) {
            problem = `Sentinel ${address}: sign-in refused`;
            continue;
          }
        }
        const reply = await sendCommand(connection, ["SENTINEL", "get-master-addr-by-name", this.config.masterName ?? ""], deadline, MESSAGES);
        if (Array.isArray(reply) && reply.length === 2 && typeof reply[0] === "string" && typeof reply[1] === "string") {
          const master = joinAddress(reply[0], reply[1]);
          if (master) return master;
        }
        problem = `Sentinel ${address} did not name a master`;
      } catch (error) {
        problem = `Sentinel ${address}: ${describeSocketError(error)}`;
      } finally {
        connection?.close();
      }
    }
    throw new RedisUnavailableError(problem);
  }
}
