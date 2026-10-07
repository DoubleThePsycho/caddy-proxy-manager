// SPDX-License-Identifier: Elastic-2.0
/**
 * Audit streaming sinks: validation, storage and the administrator actions on
 * them. Delivery to enabled sinks runs in worker.ts.
 *
 * Sinks are master-only configuration and deliberately not part of instance
 * sync: each node streams its own audit log.
 */
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { auditSinks } from "@/src/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { countAuditEventsAfter, firstAuditEventAfter, latestAuditEventId } from "./records";
import {
  DeliveryError,
  deliverEvents,
  describeDeliveryError,
  isAuditSinkType,
  testStreamEvent,
  type DeliverableSink,
} from "./delivery";
import {
  AUDIT_SINK_TYPE_LABELS,
  SYSLOG_DEFAULT_FACILITY,
  SYSLOG_DEFAULT_PORTS,
  SYSLOG_PROTOCOLS,
  type AuditSinkConfig,
  type AuditSinkTestResult,
  type AuditSinkType,
  type AuditSinkView,
  type SplunkHecSinkConfig,
  type SyslogProtocol,
  type SyslogSinkConfig,
  type WebhookSinkConfig,
} from "./types";
import { asc } from "@/src/lib/db/ops";

export type AuditSinkRow = typeof auditSinks.$inferSelect;

const MAX_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
const MIN_WEBHOOK_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 1024;
const MAX_CA_PEM_LENGTH = 64 * 1024;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/;
const SPLUNK_INDEX = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/;
/** Visible ASCII only, so the token cannot break the Authorization header. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

export const SINK_NOT_FOUND = "Audit sink not found";

// ── Validation ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown ${what} field "${key}"`);
  }
}

export function validateHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError(`${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_LENGTH) throw new ApiValidationError(`${label} is too long`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiValidationError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ApiValidationError(`${label} must use http or https`);
  }
  if (!parsed.hostname) throw new ApiValidationError(`${label} must include a host`);
  if (parsed.username || parsed.password) {
    throw new ApiValidationError(`${label} must not contain credentials; use the secret field`);
  }
  if (trimmed.includes("#")) throw new ApiValidationError(`${label} must not contain a fragment`);
  return parsed.toString();
}

export function validateHost(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("Host is required");
  let host = value.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    throw new ApiValidationError("Host must be a hostname or an IP address");
  }
  return host;
}

export function validatePort(value: unknown): number {
  const port = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiValidationError("Port must be a whole number between 1 and 65535");
  }
  return port;
}

function validateCaPem(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  if (typeof value !== "string" || value.length > MAX_CA_PEM_LENGTH || !value.includes("-----BEGIN CERTIFICATE-----")) {
    throw new ApiValidationError("CA certificate must be a PEM certificate");
  }
  try {
    new X509Certificate(value);
  } catch {
    throw new ApiValidationError("CA certificate must be a PEM certificate");
  }
  return value.trim();
}

export function validateSinkConfig(type: AuditSinkType, raw: unknown): AuditSinkConfig {
  if (!isRecord(raw)) throw new ApiValidationError("config must be an object");
  switch (type) {
    case "webhook": {
      rejectUnknownKeys(raw, ["url"], "webhook config");
      const config: WebhookSinkConfig = { url: validateHttpUrl(raw.url, "URL") };
      return config;
    }
    case "splunk_hec": {
      rejectUnknownKeys(raw, ["url", "index"], "Splunk HEC config");
      let index: string | null = null;
      if (raw.index !== undefined && raw.index !== null && raw.index !== "") {
        if (typeof raw.index !== "string" || !SPLUNK_INDEX.test(raw.index.trim())) {
          throw new ApiValidationError("Index must be a Splunk index name (letters, digits, _ and -)");
        }
        index = raw.index.trim();
      }
      const config: SplunkHecSinkConfig = { url: validateHttpUrl(raw.url, "URL"), index };
      return config;
    }
    case "syslog": {
      rejectUnknownKeys(raw, ["host", "port", "protocol", "facility", "caPem"], "syslog config");
      const protocol = raw.protocol ?? "udp";
      if (!(SYSLOG_PROTOCOLS as readonly unknown[]).includes(protocol)) {
        throw new ApiValidationError("Protocol must be udp, tcp or tls");
      }
      const facility = raw.facility ?? SYSLOG_DEFAULT_FACILITY;
      if (typeof facility !== "number" || !Number.isInteger(facility) || facility < 0 || facility > 23) {
        throw new ApiValidationError("Facility must be a whole number between 0 and 23");
      }
      if (protocol !== "tls" && typeof raw.caPem === "string" && raw.caPem.trim()) {
        throw new ApiValidationError("A CA certificate only applies to the tls protocol");
      }
      const caPem = validateCaPem(raw.caPem);
      const config: SyslogSinkConfig = {
        host: validateHost(raw.host),
        port: raw.port === undefined || raw.port === null || raw.port === ""
          ? SYSLOG_DEFAULT_PORTS[protocol as SyslogProtocol]
          : validatePort(raw.port),
        protocol: protocol as SyslogProtocol,
        facility,
        caPem,
      };
      return config;
    }
  }
}

/** undefined keeps the stored secret, null removes it. */
function parseSecretField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiValidationError("secret must be a string");
  return value;
}

function validateSecret(type: AuditSinkType, secret: string | null): void {
  if (type === "syslog") {
    if (secret) throw new ApiValidationError("Syslog sinks have no secret");
    return;
  }
  if (!secret) {
    throw new ApiValidationError(type === "webhook" ? "A signing secret is required" : "An HEC token is required");
  }
  if (secret.length > MAX_SECRET_LENGTH || !HEADER_SAFE.test(secret)) {
    throw new ApiValidationError("The secret must be visible ASCII characters without spaces");
  }
  if (type === "webhook" && secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new ApiValidationError(`The signing secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`);
  }
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("Name is required");
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) throw new ApiValidationError(`Name must be at most ${MAX_NAME_LENGTH} characters`);
  return name;
}

function parseEnabled(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiValidationError("enabled must be true or false");
  return value;
}

export type ParsedSinkCreate = {
  name: string;
  type: AuditSinkType;
  enabled: boolean;
  config: AuditSinkConfig;
  secret: string | null;
  backfill: boolean;
};

export function parseSinkCreate(body: unknown): ParsedSinkCreate {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  rejectUnknownKeys(body, ["name", "type", "enabled", "config", "secret", "backfill"], "sink");
  if (!isAuditSinkType(body.type)) throw new ApiValidationError("type must be webhook, syslog or splunk_hec");
  const type = body.type;
  if (body.backfill !== undefined && typeof body.backfill !== "boolean") {
    throw new ApiValidationError("backfill must be true or false");
  }
  const secret = parseSecretField(body.secret) ?? null;
  validateSecret(type, secret);
  return {
    name: parseName(body.name),
    type,
    enabled: parseEnabled(body.enabled, true),
    config: validateSinkConfig(type, body.config),
    secret,
    backfill: body.backfill === true,
  };
}

export type ParsedSinkUpdate = {
  name: string;
  enabled: boolean;
  config: AuditSinkConfig;
  /** undefined keeps the stored secret. */
  secret: string | null | undefined;
};

/** Fields left out keep their values; config is merged into the stored one. */
export function parseSinkUpdate(body: unknown, existing: AuditSinkRow): ParsedSinkUpdate {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  rejectUnknownKeys(body, ["name", "type", "enabled", "config", "secret"], "sink");
  const type = existing.type as AuditSinkType;
  if (body.type !== undefined && body.type !== type) {
    throw new ApiValidationError("The type of a sink cannot be changed; create a new sink instead");
  }
  if (body.config !== undefined && !isRecord(body.config)) throw new ApiValidationError("config must be an object");
  const config = validateSinkConfig(type, { ...storedConfig(existing), ...((body.config as Record<string, unknown>) ?? {}) });
  const secret = parseSecretField(body.secret);
  if (secret !== undefined) validateSecret(type, secret);
  else if (type !== "syslog" && !existing.secret) validateSecret(type, null);
  return {
    name: body.name === undefined ? existing.name : parseName(body.name),
    enabled: parseEnabled(body.enabled, existing.enabled),
    config,
    secret,
  };
}

// ── Storage ──────────────────────────────────────────────────────────

function storedConfig(row: AuditSinkRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.config);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function toView(row: AuditSinkRow): Promise<AuditSinkView> {
  const pendingEvents = await countAuditEventsAfter(row.lastDeliveredId);
  const oldestPending = pendingEvents > 0 ? await firstAuditEventAfter(row.lastDeliveredId) : null;
  return {
    id: row.id,
    name: row.name,
    type: row.type as AuditSinkType,
    enabled: row.enabled,
    config: storedConfig(row) as AuditSinkConfig,
    hasSecret: Boolean(row.secret),
    lastDeliveredId: row.lastDeliveredId,
    pendingEvents,
    oldestPendingAt: oldestPending?.createdAt ?? null,
    lastDeliveryAt: row.lastDeliveryAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    consecutiveFailures: row.consecutiveFailures,
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getAuditSinkRow(id: number): Promise<AuditSinkRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const [row] = await appDb.select().from(auditSinks).where(eq(auditSinks.id, id));
  return row ?? null;
}

async function requireSinkRow(id: number): Promise<AuditSinkRow> {
  const row = await getAuditSinkRow(id);
  if (!row) throw new ApiClientError(SINK_NOT_FOUND, 404);
  return row;
}

export async function listAuditSinks(): Promise<AuditSinkView[]> {
  const rows = await appDb.select().from(auditSinks).orderBy(asc(auditSinks.name), asc(auditSinks.id));
  return Promise.all(rows.map(toView));
}

export async function getAuditSink(id: number): Promise<AuditSinkView> {
  return toView(await requireSinkRow(id));
}

/** The sink as the delivery code needs it, with its secret decrypted. */
export function toDeliverableSink(row: AuditSinkRow): DeliverableSink {
  const config = storedConfig(row);
  let secret: string | null = null;
  if (row.secret) {
    try {
      secret = decryptSecret(row.secret, `audit sink ${row.id} secret`);
    } catch {
      throw new DeliveryError("The stored secret cannot be decrypted with SESSION_SECRET; enter it again");
    }
  }
  switch (row.type as AuditSinkType) {
    case "webhook":
      return { type: "webhook", config: config as WebhookSinkConfig, secret };
    case "splunk_hec":
      return { type: "splunk_hec", config: config as SplunkHecSinkConfig, secret };
    default:
      return { type: "syslog", config: config as SyslogSinkConfig, secret: null };
  }
}

function describeTarget(type: AuditSinkType, config: AuditSinkConfig): string {
  if (type === "syslog") {
    const syslog = config as SyslogSinkConfig;
    return `${syslog.protocol}://${syslog.host.includes(":") ? `[${syslog.host}]` : syslog.host}:${syslog.port}`;
  }
  return new URL((config as WebhookSinkConfig).url).origin;
}

// ── Administrator actions ────────────────────────────────────────────

export async function createAuditSink(body: unknown, actorUserId: number): Promise<AuditSinkView> {
  const input = parseSinkCreate(body);
  const now = nowIso();
  // New sinks start after the newest event unless a backfill was asked for.
  const cursor = input.backfill ? 0 : await latestAuditEventId();
  const [row] = await appDb
    .insert(auditSinks)
    .values({
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      config: JSON.stringify(input.config),
      secret: input.secret ? encryptSecret(input.secret) : null,
      lastDeliveredId: cursor,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await logAuditEvent({
    userId: actorUserId,
    action: "audit_sink_created",
    entityType: "audit_sink",
    entityId: row.id,
    summary: `Created ${AUDIT_SINK_TYPE_LABELS[input.type]} audit sink "${input.name}" (${describeTarget(input.type, input.config)})`,
    data: { name: input.name, type: input.type, enabled: input.enabled, backfill: input.backfill },
  });
  return toView(row);
}

export async function updateAuditSink(id: number, body: unknown, actorUserId: number): Promise<AuditSinkView> {
  const existing = await requireSinkRow(id);
  const input = parseSinkUpdate(body, existing);
  const type = existing.type as AuditSinkType;
  const configChanged = JSON.stringify(input.config) !== existing.config || input.secret !== undefined;
  const [row] = await appDb
    .update(auditSinks)
    .set({
      name: input.name,
      enabled: input.enabled,
      config: JSON.stringify(input.config),
      ...(input.secret !== undefined ? { secret: input.secret ? encryptSecret(input.secret) : null } : {}),
      // A changed destination or a re-enabled sink is retried right away.
      ...(configChanged || (input.enabled && !existing.enabled) ? { nextAttemptAt: null, consecutiveFailures: 0 } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(auditSinks.id, id))
    .returning();
  await logAuditEvent({
    userId: actorUserId,
    action: "audit_sink_updated",
    entityType: "audit_sink",
    entityId: id,
    summary: `Updated ${AUDIT_SINK_TYPE_LABELS[type]} audit sink "${input.name}"`,
    data: {
      name: input.name,
      type,
      enabled: input.enabled,
      configChanged: JSON.stringify(input.config) !== existing.config,
      secretChanged: input.secret !== undefined,
    },
  });
  return toView(row);
}

export async function deleteAuditSink(id: number, actorUserId: number): Promise<void> {
  const existing = await requireSinkRow(id);
  await appDb.delete(auditSinks).where(eq(auditSinks.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "audit_sink_deleted",
    entityType: "audit_sink",
    entityId: id,
    summary: `Deleted ${AUDIT_SINK_TYPE_LABELS[existing.type as AuditSinkType] ?? existing.type} audit sink "${existing.name}"`,
    data: { name: existing.name, type: existing.type },
  });
}

/** Sends one synthetic event; leaves the delivery cursor and status alone. */
export async function testAuditSink(id: number, actorUserId: number): Promise<AuditSinkTestResult> {
  const existing = await requireSinkRow(id);
  const started = Date.now();
  let error: string | null = null;
  try {
    await deliverEvents(toDeliverableSink(existing), [testStreamEvent(id)]);
  } catch (failure) {
    error = describeDeliveryError(failure);
  }
  const result: AuditSinkTestResult = { ok: error === null, error, durationMs: Date.now() - started };
  await logAuditEvent({
    userId: actorUserId,
    action: "audit_sink_tested",
    entityType: "audit_sink",
    entityId: id,
    summary: `Sent a test event to audit sink "${existing.name}": ${result.ok ? "delivered" : `failed (${error})`}`,
    data: { ok: result.ok, error },
  });
  return result;
}
