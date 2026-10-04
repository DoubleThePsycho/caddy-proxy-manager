// SPDX-License-Identifier: Elastic-2.0
/**
 * One connection to a directory server, with the transport rules directory
 * sign-in depends on:
 *
 *  - TLS is ldaps://, or ldap:// upgraded with StartTLS before anything else
 *    is sent. The server certificate is always verified (the system trust
 *    store, or the directory's CA certificate) and its name checked; TLS 1.2
 *    is the minimum. There is no switch to turn verification off.
 *  - A bind over a connection without TLS is refused unless the directory
 *    has the explicit "allow unencrypted" switch on.
 *  - The connection is never re-established: ldapts would otherwise open a
 *    new socket transparently after a drop, without StartTLS, and send the
 *    next bind in clear text. A second socket is refused instead, so the
 *    operation fails.
 *  - Every bind needs a non-empty password: a simple bind with an empty
 *    password is an "unauthenticated" bind that many servers accept.
 *  - Every operation has a timeout; searches are bounded by the caller.
 */
import net from "node:net";
import tls from "node:tls";
import { Client, ResultCodeError, type SearchOptions, type SearchResult } from "ldapts";

export type TransportConfig = {
  url: string;
  startTls: boolean;
  allowUnencrypted: boolean;
  caCertificate: string | null;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
};

/** The connection could not be set up or was refused by the transport rules; the message names no secret. */
export class DirectoryTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryTransportError";
  }
}

/** The TLS options for `hostname`: verification on, name checked, TLS 1.2 or later. */
export function tlsOptionsFor(hostname: string, caCertificate: string | null): tls.ConnectionOptions {
  return {
    host: hostname,
    // SNI takes host names only; an IP address is still checked against the certificate.
    ...(net.isIP(hostname) ? {} : { servername: hostname }),
    ...(caCertificate ? { ca: caCertificate } : {}),
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  };
}

function hostnameOf(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** A factory that hands out one socket and refuses every later call (a reconnect). */
function oneShot<F extends (...args: never[]) => unknown>(create: F, what: string): F {
  let used = false;
  return ((...args: Parameters<F>) => {
    if (used) throw new DirectoryTransportError(`The ${what} connection to the directory was lost and is not re-opened`);
    used = true;
    return create(...args);
  }) as F;
}

export class DirectoryConnection {
  private constructor(
    private readonly client: Client,
    private readonly encrypted: boolean,
    private readonly allowUnencrypted: boolean
  ) {}

  /** Opens the connection and, for ldap:// with StartTLS, upgrades it before returning. */
  static async open(config: TransportConfig): Promise<DirectoryConnection> {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new DirectoryTransportError("The directory URL is not valid");
    }
    const secure = url.protocol === "ldaps:";
    if (!secure && url.protocol !== "ldap:") throw new DirectoryTransportError("The directory URL must start with ldaps:// or ldap://");
    if (secure && config.startTls) throw new DirectoryTransportError("StartTLS is only used with ldap:// URLs");
    if (!secure && !config.startTls && !config.allowUnencrypted) {
      throw new DirectoryTransportError("Unencrypted connections are not allowed for this directory");
    }
    const tlsOptions = tlsOptionsFor(hostnameOf(url), config.caCertificate);
    const client = new Client({
      url: config.url,
      connectTimeout: config.connectTimeoutMs,
      timeout: config.operationTimeoutMs,
      // Only for ldaps://: with tlsOptions ldapts would speak TLS straight
      // away on an ldap:// URL too. StartTLS gets them below.
      ...(secure ? { tlsOptions } : {}),
      strictDN: true,
      createConnection: oneShot(
        ((port: number, host: string) => net.connect({ port, host })) as typeof net.connect,
        "plain"
      ),
      createSecureConnection: oneShot(
        ((...args: Parameters<typeof tls.connect>) => (tls.connect as (...a: unknown[]) => tls.TLSSocket)(...args)) as typeof tls.connect,
        "TLS"
      ),
    });
    const connection = new DirectoryConnection(client, secure || config.startTls, config.allowUnencrypted);
    if (!secure && config.startTls) {
      try {
        await client.startTLS({ ...tlsOptions });
      } catch (error) {
        await connection.close();
        throw error;
      }
    }
    return connection;
  }

  /** Simple bind. Refuses an empty password and, unless allowed, a connection without TLS. */
  async bind(dn: string, password: string): Promise<void> {
    if (typeof dn !== "string" || !dn.trim()) throw new DirectoryTransportError("Refusing to bind without a DN");
    if (typeof password !== "string" || !password.trim()) {
      throw new DirectoryTransportError("Refusing to bind with an empty password");
    }
    if (!this.encrypted && !this.allowUnencrypted) {
      throw new DirectoryTransportError("Refusing to send a password over an unencrypted connection");
    }
    await this.client.bind(dn, password);
  }

  search(base: string, options: SearchOptions): Promise<SearchResult> {
    return this.client.search(base, options);
  }

  searchPaginated(base: string, options: SearchOptions): AsyncGenerator<SearchResult> {
    return this.client.searchPaginated(base, options);
  }

  async close(): Promise<void> {
    try {
      await this.client.unbind();
    } catch {
      // Closing only.
    }
  }
}

const RESULT_CODES: Record<number, string> = {
  1: "operations error",
  2: "protocol error",
  3: "time limit exceeded",
  4: "size limit exceeded",
  7: "authentication method not supported",
  8: "stronger authentication required",
  10: "referral",
  11: "administrative limit exceeded",
  13: "confidentiality required",
  32: "no such object",
  34: "invalid DN syntax",
  48: "inappropriate authentication",
  49: "invalid credentials",
  50: "insufficient access rights",
  51: "busy",
  52: "unavailable",
  53: "unwilling to perform",
  80: "other",
};

/**
 * A short description of a directory error for administrators and the
 * server log: the LDAP result code or the network/TLS failure. Never holds a
 * password.
 */
export function describeDirectoryError(error: unknown): string {
  if (error instanceof DirectoryTransportError) return error.message;
  if (error instanceof ResultCodeError) {
    return `${RESULT_CODES[error.code] ?? "LDAP error"} (LDAP result ${error.code})`;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code)) {
    if (code === "ECONNREFUSED") return "connection refused";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host name not found";
    if (code === "ETIMEDOUT") return "connection timed out";
    if (code === "ECONNRESET") return "connection reset";
    if (/CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|HOSTNAME|ALTNAME/.test(code)) return `TLS certificate not accepted (${code})`;
    return `connection failed (${code})`;
  }
  if (error instanceof Error && /timed? ?out/i.test(error.message)) return "timed out";
  return "the directory request failed";
}
