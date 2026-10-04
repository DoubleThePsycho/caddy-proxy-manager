/**
 * The invalidation bus (src/lib/db/README.md, "Events and shared state"):
 * how one web process tells the others that something they keep in memory
 * changed.
 *
 * - publish(channel, payload?) announces a change; subscribe(channel,
 *   handler) hears every announcement on that channel in every process,
 *   the publishing one included (`event.self` says so).
 * - A message means "read it again", never what the new value is: the
 *   handler reads the database. The payload only names what changed (an
 *   id, a cache name), at most MAX_EVENT_PAYLOAD_LENGTH characters.
 * - PostgreSQL: each process holds one connection of its own (not from the
 *   pool) that LISTENs on PG_EVENT_CHANNEL, opened by startEventBus().
 *   publish() runs pg_notify(). Inside a writing transaction the
 *   notification belongs to the transaction: PostgreSQL delivers it when the
 *   transaction commits and drops it when it (or the savepoint it was sent
 *   in) rolls back. Outside one it goes out at once on a pooled connection.
 * - The listening connection is checked with a query every 15 seconds. When
 *   it fails, ends or the check times out (the server restarted, the network
 *   is cut), it is closed and opened again after a growing delay (up to 30
 *   seconds), and every handler then gets a "resync" event: messages sent
 *   while it was down are lost, so everything is read again. The first
 *   connection resyncs too (values loaded before it may have changed).
 * - SQLite: one process, no connection. publish() calls this process's
 *   handlers; inside a transaction, after the caller's context has left it,
 *   so that what a handler reads is committed (after a rollback the handler
 *   reads the unchanged rows: a needless "read again", nothing worse).
 *
 * Handlers run one call per event; their errors are logged, never thrown at
 * the publisher. Publishing never throws for a delivery failure either (it
 * is logged and publish() resolves to false): a cache that misses a message
 * still has its time-to-live.
 *
 * The listening connection uses application_name "ingressi-events".
 * Connection poolers in transaction mode (PgBouncer's default) cannot carry
 * LISTEN: DATABASE_URL must reach PostgreSQL directly or in session mode.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { isPostgres } from "./dialect";
import { openFrame, outsideTransaction, transactionContext } from "./executor-core";
import { execRaw } from "./ops";
import { readPostgresConfig } from "./postgres";
import { onShutdown } from "../shutdown";

/** The PostgreSQL notification channel every message goes through. */
export const PG_EVENT_CHANNEL = "ingressi_events";
/** application_name of the listening connections. */
export const EVENT_LISTENER_APPLICATION_NAME = "ingressi-events";
export const MAX_EVENT_PAYLOAD_LENGTH = 1000;

const CHANNEL_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_MIN_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
/** Connection errors are logged at most this often. */
const ERROR_LOG_INTERVAL_MS = 60_000;

export type BusEvent =
  | {
      kind: "message";
      channel: string;
      /** What changed, as published (null when nothing was named). */
      payload: string | null;
      /** Published by this process. */
      self: boolean;
    }
  | {
      /** Messages may have been missed: read everything again. */
      kind: "resync";
      channel: string;
    };

export type BusHandler = (event: BusEvent) => void | Promise<void>;

export type EventBusOptions = {
  /**
   * "postgres": LISTEN/NOTIFY; "local": this process only. Default: the
   * configured dialect's, read when used.
   */
  mode?: "postgres" | "local";
  /** PostgreSQL: a new, unconnected client for the listening connection (default: from DATABASE_URL). */
  createClient?: () => pg.Client;
  /** PostgreSQL: sends a notification outside a transaction (default: on the application's pool). */
  notify?: (message: string) => Promise<void>;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
};

export type EventBusStatus = {
  mode: "postgres" | "local";
  /** Started (startEventBus) and not stopped. */
  started: boolean;
  /** The listening connection is open (PostgreSQL). */
  listening: boolean;
  /** The server process of the listening connection (PostgreSQL). */
  backendPid: number | null;
  connectedAt: string | null;
  /** Connections opened after the first one. */
  reconnects: number;
  lastError: string | null;
};

type Envelope = { c: string; p: string | null; o: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertChannel(channel: string): void {
  if (typeof channel !== "string" || !CHANNEL_NAME.test(channel)) {
    throw new Error(`Invalid event channel ${JSON.stringify(channel)}: lower-case letters, digits, ".", "_" and "-", at most 64`);
  }
}

function checkedPayload(payload: string | null | undefined): string | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload !== "string" || payload.length > MAX_EVENT_PAYLOAD_LENGTH || payload.includes("\u0000")) {
    throw new Error(`An event payload is a string of at most ${MAX_EVENT_PAYLOAD_LENGTH} characters`);
  }
  return payload;
}

function parseEnvelope(text: string | undefined): Envelope | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<Envelope> | null;
    if (!value || typeof value.c !== "string" || !CHANNEL_NAME.test(value.c) || typeof value.o !== "string") return null;
    if (value.p !== null && typeof value.p !== "string") return null;
    return { c: value.c, p: value.p ?? null, o: value.o };
  } catch {
    return null;
  }
}

/** The listening connection's configuration: the pool's, without pool settings, under its own application name. */
function listenerConfig(): pg.ClientConfig {
  const config = readPostgresConfig();
  return {
    connectionString: config.connectionString,
    ssl: config.ssl,
    options: config.options,
    types: config.types,
    application_name: EVENT_LISTENER_APPLICATION_NAME,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statement_timeout,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

async function notifyOnAppDatabase(message: string): Promise<void> {
  await execRaw(sql`SELECT pg_notify(${PG_EVENT_CHANNEL}, ${message})`);
}

/** Forcibly closes a client whose connection may be dead (end() could wait for a server that never answers). */
function destroyClient(client: pg.Client): void {
  client.removeAllListeners();
  // A late error from the closing connection must not end the process.
  client.on("error", () => {});
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream;
  try {
    stream?.destroy?.();
  } catch {
    // Already closed.
  }
  client.end().catch(() => {});
}

export class EventBus {
  /** Identifies this process's messages. */
  readonly origin = randomBytes(9).toString("base64url");
  private readonly options: EventBusOptions;
  private readonly handlers = new Map<string, Set<BusHandler>>();
  private readonly inFlight = new Set<Promise<void>>();
  private client: pg.Client | null = null;
  private started = false;
  private opening: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatRunning = false;
  private failures = 0;
  private connections = 0;
  private backendPid: number | null = null;
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private lastLoggedAt = 0;

  constructor(options: EventBusOptions = {}) {
    this.options = options;
  }

  get mode(): "postgres" | "local" {
    return this.options.mode ?? (isPostgres() ? "postgres" : "local");
  }

  /** Calls `handler` for every message on `channel` and for every resync; returns the function that stops it. */
  subscribe(channel: string, handler: BusHandler): () => void {
    assertChannel(channel);
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(handler);
    return () => {
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(channel);
    };
  }

  /**
   * Announces a change on `channel` to every process. Resolves to whether
   * the announcement was sent (false after a failure, which is logged);
   * throws only for an invalid channel or payload.
   */
  async publish(channel: string, payload?: string | null): Promise<boolean> {
    assertChannel(channel);
    const text = checkedPayload(payload);
    if (this.mode === "local") {
      const event: BusEvent = { kind: "message", channel, payload: text, self: true };
      const frame = transactionContext.getStore();
      if (frame && openFrame(frame)) {
        // Called inside a transaction: deliver once the caller has left it.
        outsideTransaction(() => {
          setImmediate(() => void this.dispatch(channel, event));
        });
        return true;
      }
      await this.dispatch(channel, event);
      return true;
    }

    const message = JSON.stringify({ c: channel, p: text, o: this.origin } satisfies Envelope);
    const frame = transactionContext.getStore();
    const open = frame ? openFrame(frame) : null;
    try {
      if (open && !open.root.readOnly) {
        // The transaction's own notification (sent when it commits), in a
        // savepoint so that a failure cannot abort the caller's transaction.
        await open.tx.transaction(async (savepoint) => {
          await execRaw(sql`SELECT pg_notify(${PG_EVENT_CHANNEL}, ${message})`, savepoint);
        });
      } else {
        // NOTIFY is refused in a read-only transaction: send it on its own.
        await outsideTransaction(() => (this.options.notify ?? notifyOnAppDatabase)(message));
      }
      return true;
    } catch (error) {
      console.warn(`[db] Could not announce a change on "${channel}":`, errorMessage(error));
      return false;
    }
  }

  /**
   * PostgreSQL: opens the listening connection (waits for the first attempt;
   * when it fails, keeps trying in the background). Nothing to do locally.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.mode !== "postgres") return;
    await this.connect();
  }

  /** Closes the listening connection and stops reconnecting. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const client = this.client;
    this.client = null;
    this.backendPid = null;
    if (this.opening) await this.opening.catch(() => undefined);
    if (!client) return;
    client.removeAllListeners();
    client.on("error", () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await client.query(`UNLISTEN ${PG_EVENT_CHANNEL}`);
          await client.end();
        })(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2_000);
        }),
      ]);
    } catch {
      // Closing anyway.
    } finally {
      clearTimeout(timer);
      destroyClient(client);
    }
  }

  status(): EventBusStatus {
    return {
      mode: this.mode,
      started: this.started,
      listening: this.client !== null,
      backendPid: this.backendPid,
      connectedAt: this.connectedAt,
      reconnects: Math.max(0, this.connections - 1),
      lastError: this.lastError,
    };
  }

  /** Resolves once every handler call started so far has finished (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Calls every handler of `channel` with `event`; never rejects. */
  private dispatch(channel: string, event: BusEvent): Promise<void> {
    const handlers = [...(this.handlers.get(channel) ?? [])];
    const runs = handlers.map((handler) => {
      const run = (async () => {
        try {
          await handler(event);
        } catch (error) {
          console.warn(`[db] A handler of "${channel}" events failed:`, errorMessage(error));
        }
      })();
      this.inFlight.add(run);
      void run.finally(() => this.inFlight.delete(run));
      return run;
    });
    return Promise.all(runs).then(() => undefined);
  }

  private resyncAll(): void {
    for (const channel of [...this.handlers.keys()]) void this.dispatch(channel, { kind: "resync", channel });
  }

  private receive(message: { channel: string; payload?: string }): void {
    if (message.channel !== PG_EVENT_CHANNEL) return;
    const envelope = parseEnvelope(message.payload);
    if (!envelope) return;
    void this.dispatch(envelope.c, { kind: "message", channel: envelope.c, payload: envelope.p, self: envelope.o === this.origin });
  }

  private logFailure(what: string, error: unknown): void {
    this.lastError = errorMessage(error);
    const now = Date.now();
    if (now - this.lastLoggedAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastLoggedAt = now;
    console.error(`[db] ${what}:`, this.lastError);
  }

  /** One attempt to open the listening connection; on failure the next is scheduled. */
  private connect(): Promise<void> {
    this.opening ??= this.open()
      .catch((error: unknown) => {
        this.failures += 1;
        this.logFailure("The event listener could not connect to PostgreSQL; trying again", error);
        this.scheduleReconnect();
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async open(): Promise<void> {
    const client = this.options.createClient ? this.options.createClient() : new pg.Client(listenerConfig());
    client.on("error", (error) => this.lost(client, error));
    client.on("end", () => this.lost(client, new Error("the connection was closed")));
    client.on("notification", (message) => this.receive(message));
    let pid: number | null;
    try {
      await client.connect();
      await client.query(`LISTEN ${PG_EVENT_CHANNEL}`);
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pid = Number(rows[0]?.pid ?? 0) || null;
    } catch (error) {
      destroyClient(client);
      throw error;
    }
    if (!this.started) {
      destroyClient(client);
      return;
    }
    this.client = client;
    this.backendPid = pid;
    this.connectedAt = new Date().toISOString();
    this.connections += 1;
    this.failures = 0;
    this.startHeartbeat(client);
    // Changes made before this connection listened are unknown here.
    this.resyncAll();
  }

  /** The listening connection `client` failed or ended: close it and open another. */
  private lost(client: pg.Client, error: unknown): void {
    if (client !== this.client) return;
    this.client = null;
    this.backendPid = null;
    this.stopHeartbeat();
    destroyClient(client);
    this.logFailure("The event listener lost its PostgreSQL connection; reconnecting", error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const min = this.options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
    const max = this.options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    const base = Math.min(max, min * 2 ** Math.min(this.failures, 16));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started && !this.client) void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(client: pg.Client): void {
    this.stopHeartbeat();
    const every = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const timeout = this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatRunning || client !== this.client) return;
      this.heartbeatRunning = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        client.query("SELECT 1"),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${timeout} ms`)), timeout);
        }),
      ])
        .catch((error: unknown) => this.lost(client, error))
        .finally(() => {
          clearTimeout(timer);
          this.heartbeatRunning = false;
        });
    }, every);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

// ── The process's bus ──

type GlobalBusState = typeof globalThis & { __ingressiEventBus?: EventBus };
const globalBus = globalThis as GlobalBusState;

/** This process's bus (one per process, shared by every copy of this module). */
export function getEventBus(): EventBus {
  return (globalBus.__ingressiEventBus ??= new EventBus());
}

/** Subscribes to `channel` on this process's bus. */
export function subscribe(channel: string, handler: BusHandler): () => void {
  return getEventBus().subscribe(channel, handler);
}

/** Publishes on this process's bus: see EventBus.publish. */
export function publish(channel: string, payload?: string | null): Promise<boolean> {
  return getEventBus().publish(channel, payload);
}

/**
 * Starts this process's bus: on PostgreSQL, opens the listening connection
 * (closed on SIGTERM and SIGINT, src/lib/shutdown.ts). Called once at
 * start-up (src/lib/startup-caches.ts), on every node.
 */
export async function startEventBus(): Promise<void> {
  onShutdown("closing the event listener", stopEventBus);
  await getEventBus().start();
}

export async function stopEventBus(): Promise<void> {
  await getEventBus().stop();
}

/**
 * How many web processes use this database, this one included: 1 on SQLite
 * (`bus` in local mode); on PostgreSQL the live replicas of cluster_nodes
 * (countLiveReplicas in src/lib/cluster-nodes.ts, with membership's
 * definition of live), plus this process while it is not among them.
 */
export async function countReplicas(bus: EventBus = getEventBus()): Promise<number> {
  if (bus.mode !== "postgres") return 1;
  // Imported when used: membership sits above the database layer.
  const { countLiveReplicas } = await import("../cluster-nodes");
  return await countLiveReplicas();
}
