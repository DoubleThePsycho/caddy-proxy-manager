// SPDX-License-Identifier: Elastic-2.0
/**
 * A minimal RESP2 client on node:net / node:tls, shared by the certificate
 * storage connection test (redis-check.ts) and the dashboard leader lease
 * (cluster/redis-client.ts), so neither needs a dependency.
 *
 * Replies are bounded in size and depth; one command is in flight per
 * connection. Errors raised here carry fixed messages, never anything a
 * server sent, so callers can show them.
 */
import net from "node:net";
import tls from "node:tls";

/** One connection attempt. */
export const CONNECT_TIMEOUT_MS = 5_000;
export const MAX_REPLY_BYTES = 64 * 1024;
const MAX_ARRAY_LENGTH = 64;

export type Resp = string | number | null | RespError | Resp[];

/** An error reply ("-ERR ..."). `code` is its first word, upper-cased. */
export class RespError {
  constructor(readonly text: string) {}
  get code(): string {
    return this.text.split(" ", 1)[0].toUpperCase();
  }
}

/** A failure whose message is safe to show. */
export class RespClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RespClientError";
  }
}

export class ProtocolError extends Error {
  constructor() {
    super("the server did not answer like Redis or Valkey");
    this.name = "ProtocolError";
  }
}

export type RespTls = { enabled: boolean; insecureSkipVerify: boolean; caPem?: string };

export function splitAddress(address: string): { host: string; port: number } {
  const colon = address.lastIndexOf(":");
  const host = address.slice(0, colon).replace(/^\[|\]$/g, "");
  return { host, port: Number(address.slice(colon + 1)) };
}

/** host:port with an IPv6 address in brackets, or null when `host`/`port` are not plausible. */
export function joinAddress(host: string, port: string): string | null {
  if (!/^\d{1,5}$/.test(port) || !(net.isIP(host) || /^[A-Za-z0-9._-]{1,253}$/.test(host))) return null;
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Parses one RESP2 value at `offset`: the value and where the next starts, or null when more bytes are needed. */
export function parseResp(buffer: Buffer, offset: number, depth = 0): { value: Resp; next: number } | null {
  if (offset >= buffer.length) return null;
  if (depth > 4) throw new ProtocolError();
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buffer[offset]);
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const afterLine = lineEnd + 2;
  switch (type) {
    case "+":
      return { value: line, next: afterLine };
    case "-":
      return { value: new RespError(line), next: afterLine };
    case ":": {
      if (!/^-?\d{1,18}$/.test(line)) throw new ProtocolError();
      return { value: Number(line), next: afterLine };
    }
    case "$": {
      if (!/^-?\d{1,9}$/.test(line)) throw new ProtocolError();
      const length = Number(line);
      if (length === -1) return { value: null, next: afterLine };
      if (length < 0 || length > MAX_REPLY_BYTES) throw new ProtocolError();
      if (buffer.length < afterLine + length + 2) return null;
      return { value: buffer.toString("utf8", afterLine, afterLine + length), next: afterLine + length + 2 };
    }
    case "*": {
      if (!/^-?\d{1,9}$/.test(line)) throw new ProtocolError();
      const count = Number(line);
      if (count === -1) return { value: null, next: afterLine };
      if (count < 0 || count > MAX_ARRAY_LENGTH) throw new ProtocolError();
      const items: Resp[] = [];
      let next = afterLine;
      for (let index = 0; index < count; index++) {
        const item = parseResp(buffer, next, depth + 1);
        if (!item) return null;
        items.push(item.value);
        next = item.next;
      }
      return { value: items, next };
    }
    default:
      throw new ProtocolError();
  }
}

export function encodeCommand(args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) parts.push(`$${Buffer.byteLength(arg, "utf8")}\r\n${arg}\r\n`);
  return Buffer.from(parts.join(""), "utf8");
}

type Pending = { resolve: (value: Resp) => void; reject: (error: unknown) => void };

/** One connection; commands are sent one at a time. */
export class RespConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private failure: unknown = null;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_REPLY_BYTES) {
        this.fail(new ProtocolError());
        return;
      }
      this.drain();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new RespClientError("the server closed the connection")));
  }

  /** False once the connection failed or was closed. */
  get usable(): boolean {
    return this.failure === null;
  }

  private fail(error: unknown) {
    if (this.failure === null) this.failure = error;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(this.failure);
    this.socket.destroy();
  }

  private drain() {
    if (!this.pending) {
      if (this.buffer.length > 0) this.fail(new ProtocolError());
      return;
    }
    let parsed: ReturnType<typeof parseResp>;
    try {
      parsed = parseResp(this.buffer, 0);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (!parsed) return;
    this.buffer = this.buffer.subarray(parsed.next);
    const pending = this.pending;
    this.pending = null;
    pending.resolve(parsed.value);
    if (this.buffer.length > 0) this.fail(new ProtocolError());
  }

  command(args: string[]): Promise<Resp> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.socket.write(encodeCommand(args));
    });
  }

  close() {
    this.pending = null;
    this.failure ??= new RespClientError("closed");
    this.socket.destroy();
  }
}

/** Opens a connection to `address`, giving up at `deadline` (or after CONNECT_TIMEOUT_MS). */
export function openConnection(address: string, target: { tls: RespTls }, deadline: number): Promise<RespConnection> {
  const { host, port } = splitAddress(address);
  const timeout = Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline - Date.now()));
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket: net.Socket = target.tls.enabled
      ? tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: !target.tls.insecureSkipVerify,
          ...(target.tls.caPem ? { ca: [target.tls.caPem] } : {}),
          minVersion: "TLSv1.2",
        })
      : net.connect({ host, port });
    const timer = setTimeout(() => finish(new RespClientError("connection timed out")), timeout);
    function finish(error: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("error");
      if (error) {
        // A late error from the abandoned socket must not go unhandled.
        socket.on("error", () => {});
        socket.destroy();
        reject(error);
        return;
      }
      resolve(new RespConnection(socket));
    }
    socket.once(target.tls.enabled ? "secureConnect" : "connect", () => finish(null));
    socket.once("error", (error) => finish(error));
  });
}

/**
 * Runs `args` with the time left until `deadline`; a reply that does not
 * come in time closes the connection and fails with `timeoutMessage`.
 */
export async function sendCommand(
  connection: RespConnection,
  args: string[],
  deadline: number,
  messages: { expired: string; timeout: string } = { expired: "the test timed out", timeout: "the server did not answer in time" }
): Promise<Resp> {
  const left = deadline - Date.now();
  if (left <= 0) throw new RespClientError(messages.expired);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      connection.command(args),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          connection.close();
          reject(new RespClientError(messages.timeout));
        }, left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A fixed description of a socket-level failure (never the server's words). */
export function describeSocketError(error: unknown): string {
  if (error instanceof RespClientError || error instanceof ProtocolError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code)) {
    if (code === "ECONNREFUSED") return "connection refused";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host name not found";
    if (code === "ETIMEDOUT") return "connection timed out";
    if (code === "ECONNRESET" || code === "EPIPE") return "the server closed the connection";
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "the host cannot be reached";
    if (/CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME/.test(code)) return `TLS certificate not accepted (${code})`;
    if (/TLS|SSL/.test(code)) return `TLS handshake failed (${code})`;
    return `connection failed (${code})`;
  }
  return "connection failed";
}

/** Fixed descriptions of the Redis error codes a client may meet. */
export const KNOWN_REDIS_ERRORS: Record<string, string> = {
  NOAUTH: "the server needs a password",
  WRONGPASS: "the user name or password was not accepted",
  NOPERM: "the user is not allowed to run this command",
  READONLY: "the server is a read-only replica",
  LOADING: "the server is still loading its data; try again",
  MASTERDOWN: "the server has lost its master",
  CLUSTERDOWN: "the cluster is down",
  TRYAGAIN: "the cluster is resharding; try again",
  ASK: "the cluster is resharding; try again",
  MOVED: "the server is a cluster node: choose the cluster mode",
  CROSSSLOT: "the cluster refused the command",
  BUSY: "the server is busy running a script",
  OOM: "the server is out of memory",
  NOSCRIPT: "the server does not know the script",
};
