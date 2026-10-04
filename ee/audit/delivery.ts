// SPDX-License-Identifier: Elastic-2.0
/**
 * Delivery of audit events to streaming sinks: request and message formats,
 * and the HTTP, UDP, TCP and TLS transports.
 *
 * Errors thrown here are DeliveryError instances whose messages are safe to
 * store and show to administrators: they name a status code or an error code,
 * never a response body or a secret.
 */
import { createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { hostname as osHostname } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { APP_VERSION } from "@/src/lib/app-version";
import { BRAND_NAME } from "@/src/lib/brand";
import type { AuditRecord } from "./records";
import type { AuditSinkType, SplunkHecSinkConfig, SyslogSinkConfig, WebhookSinkConfig } from "./types";

export const DELIVERY_TIMEOUT_MS = 10_000;
export const SPLUNK_SOURCETYPE = "ingressi:audit";
const APP_NAME = BRAND_NAME.toLowerCase().replace(/[^a-z0-9._-]/g, "") || "audit";
/** SD-ID of the structured data element; 32473 is the documentation enterprise number (RFC 5612). */
export const SYSLOG_SD_ID = `${APP_NAME}@32473`;
/** Severity "notice" (5): normal but significant. */
const SYSLOG_SEVERITY = 5;
const USER_AGENT = `${BRAND_NAME}-Audit/${APP_VERSION}`;

/** The JSON shape of an event delivered to a sink. */
export type AuditStreamEvent = {
  id: number;
  createdAt: string;
  userId: number | null;
  userEmail: string | null;
  userName: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string | null;
  /** The stored data text (usually JSON), exactly as hashed. */
  data: string | null;
  prevHash: string | null;
  hash: string | null;
  source: string;
  host: string;
  /** Present on events sent with "Send test event". */
  test?: true;
};

export type DeliverableSink =
  | { type: "webhook"; config: WebhookSinkConfig; secret: string | null }
  | { type: "splunk_hec"; config: SplunkHecSinkConfig; secret: string | null }
  | { type: "syslog"; config: SyslogSinkConfig; secret: null };

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

export function localHostname(): string {
  return osHostname() || "localhost";
}

export function toStreamEvent(record: AuditRecord, host: string = localHostname()): AuditStreamEvent {
  return {
    id: record.id,
    createdAt: record.createdAt,
    userId: record.userId,
    userEmail: record.userEmail,
    userName: record.userName,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    summary: record.summary,
    data: record.data,
    prevHash: record.prevHash,
    hash: record.hash,
    source: APP_NAME,
    host,
  };
}

export function testStreamEvent(sinkId: number, now: Date = new Date(), host: string = localHostname()): AuditStreamEvent {
  return {
    id: 0,
    createdAt: now.toISOString(),
    userId: null,
    userEmail: null,
    userName: null,
    action: "audit_sink_test",
    entityType: "audit_sink",
    entityId: sinkId,
    summary: `Test event from ${BRAND_NAME}`,
    data: null,
    prevHash: null,
    hash: null,
    source: APP_NAME,
    host,
    test: true,
  };
}

// ── Webhook ──────────────────────────────────────────────────────────

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function buildWebhookRequest(events: AuditStreamEvent[], secret: string | null, now: Date = new Date()) {
  const body = JSON.stringify({ events });
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-ingressi-timestamp": timestamp,
  };
  if (secret) headers["x-ingressi-signature"] = signWebhookBody(secret, timestamp, body);
  return { body, headers };
}

// ── Splunk HTTP Event Collector ─────────────────────────────────────

export function splunkEventEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/services/collector/event")) url.pathname = path;
  else if (path.endsWith("/services/collector")) url.pathname = `${path}/event`;
  else url.pathname = `${path}/services/collector/event`;
  return url.toString();
}

export function buildSplunkPayload(events: AuditStreamEvent[], config: SplunkHecSinkConfig): string {
  return events
    .map((event) =>
      JSON.stringify({
        time: Date.parse(event.createdAt) / 1000,
        host: event.host,
        source: event.source,
        sourcetype: SPLUNK_SOURCETYPE,
        ...(config.index ? { index: config.index } : {}),
        event,
      })
    )
    .join("\n");
}

// ── Syslog (RFC 5424) ────────────────────────────────────────────────

function printableAscii(value: string, maxLength: number): string {
  const cleaned = value.replace(/[^\x21-\x7e]/g, "").slice(0, maxLength);
  return cleaned || "-";
}

function sdValue(value: string): string {
  return value.replace(/[\\"\]]/g, (ch) => `\\${ch}`);
}

/** JSON with every non-ASCII character escaped, so MSG is plain ASCII. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/**
 * One RFC 5424 message: the event's key fields as structured data and the
 * whole event as JSON in MSG.
 */
export function formatSyslogMessage(event: AuditStreamEvent, config: Pick<SyslogSinkConfig, "facility">): string {
  const pri = config.facility * 8 + SYSLOG_SEVERITY;
  const params: Array<[string, string | number | null]> = [
    ["id", event.id],
    ["action", event.action],
    ["entityType", event.entityType],
    ["entityId", event.entityId],
    ["userId", event.userId],
    ["hash", event.hash],
  ];
  const sd = params
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}="${sdValue(String(value))}"`)
    .join(" ");
  return [
    `<${pri}>1`,
    event.createdAt,
    printableAscii(event.host, 255),
    printableAscii(event.source, 48),
    printableAscii(String(process.pid), 128),
    "audit",
    `[${SYSLOG_SD_ID} ${sd}]`,
    asciiJson(event),
  ].join(" ");
}

/** RFC 6587 / RFC 5425 octet-counting frame. */
export function frameOctetCounting(message: string): string {
  return `${Buffer.byteLength(message, "utf8")} ${message}`;
}

/** UDP datagrams beyond this are dropped by many receivers and networks. */
const MAX_UDP_MESSAGE_BYTES = 8192;

function udpMessage(event: AuditStreamEvent, config: SyslogSinkConfig): string {
  const message = formatSyslogMessage(event, config);
  if (Buffer.byteLength(message, "utf8") <= MAX_UDP_MESSAGE_BYTES) return message;
  return formatSyslogMessage({ ...event, data: "[truncated: too large for a UDP datagram]" }, config);
}

// ── Transports ───────────────────────────────────────────────────────

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A message naming the failure without echoing anything the peer sent. */
export function describeDeliveryError(error: unknown): string {
  if (error instanceof DeliveryError) return error.message;
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const { name, code } = candidate as { name?: unknown; code?: unknown };
    if (name === "TimeoutError" || name === "AbortError") return `Timed out after ${DELIVERY_TIMEOUT_MS / 1000} s`;
    if (typeof code === "string" && SAFE_CODE.test(code)) return `Connection failed (${code})`;
  }
  return "Delivery failed";
}

async function postHttp(url: string, headers: Record<string, string>, body: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DeliveryError(describeDeliveryError(error));
  }
  // The body is never read or stored.
  await response.body?.cancel().catch(() => undefined);
  if (response.status < 200 || response.status > 299) {
    throw new DeliveryError(`HTTP ${response.status} from the receiver`);
  }
}

async function sendUdp(config: SyslogSinkConfig, messages: string[]): Promise<void> {
  let address: string;
  let family: number;
  try {
    ({ address, family } = await lookup(config.host));
  } catch (error) {
    throw new DeliveryError(describeDeliveryError(error));
  }
  const socket = createSocket(family === 6 ? "udp6" : "udp4");
  try {
    for (const message of messages) {
      await new Promise<void>((resolve, reject) => {
        socket.send(Buffer.from(message, "utf8"), config.port, address, (error) => (error ? reject(error) : resolve()));
      });
    }
  } catch (error) {
    throw new DeliveryError(describeDeliveryError(error));
  } finally {
    socket.close();
  }
}

async function sendStream(config: SyslogSinkConfig, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket: Socket =
      config.protocol === "tls"
        ? tlsConnect({
            host: config.host,
            port: config.port,
            servername: isIP(config.host) ? undefined : config.host,
            ca: config.caPem ?? undefined,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
          })
        : netConnect({ host: config.host, port: config.port });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(new DeliveryError(describeDeliveryError(error)));
      } else {
        // The payload is with the kernel; close our side and give the peer
        // a moment to close cleanly.
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref();
        resolve();
      }
    };
    const timer = setTimeout(
      () => finish(new DeliveryError(`Timed out after ${DELIVERY_TIMEOUT_MS / 1000} s`)),
      DELIVERY_TIMEOUT_MS
    );
    socket.on("error", (error) => finish(error));
    // Writes are queued until the connection (and TLS handshake) is up; the
    // callback runs once the data is handed to the operating system.
    socket.write(payload, "utf8", (error) => finish(error ?? undefined));
  });
}

/** Delivers a batch, resolving once the receiver accepted it; throws DeliveryError otherwise. */
export async function deliverEvents(sink: DeliverableSink, events: AuditStreamEvent[]): Promise<void> {
  if (events.length === 0) return;
  switch (sink.type) {
    case "webhook": {
      const { body, headers } = buildWebhookRequest(events, sink.secret);
      await postHttp(sink.config.url, headers, body);
      return;
    }
    case "splunk_hec": {
      if (!sink.secret) throw new DeliveryError("No HEC token is stored");
      await postHttp(
        splunkEventEndpoint(sink.config.url),
        { authorization: `Splunk ${sink.secret}`, "content-type": "application/json", "user-agent": USER_AGENT },
        buildSplunkPayload(events, sink.config)
      );
      return;
    }
    case "syslog": {
      if (sink.config.protocol === "udp") {
        await sendUdp(sink.config, events.map((event) => udpMessage(event, sink.config)));
      } else {
        await sendStream(sink.config, events.map((event) => frameOctetCounting(formatSyslogMessage(event, sink.config))).join(""));
      }
      return;
    }
  }
}

export function isAuditSinkType(value: unknown): value is AuditSinkType {
  return value === "webhook" || value === "syslog" || value === "splunk_hec";
}
