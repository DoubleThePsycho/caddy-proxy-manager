// SPDX-License-Identifier: Elastic-2.0
/**
 * Backup destinations: validation, storage and the administrator actions on
 * them. Scheduled backups run in runner.ts and scheduler.ts.
 *
 * Destinations are master-only configuration and not part of instance sync.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { backupDestinations, backupRuns } from "@/src/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { assertConfigurationEditable } from "@/src/lib/config-replace";
import { MIN_EXPORT_PASSPHRASE_LENGTH } from "@/src/lib/config-transfer";
import { isDestinationRunning, runningDestinationIds } from "./locks";
import { S3Client, S3Error, type S3ClientOptions } from "./s3";
import { nextRunAfter, parseSchedule, parseTimeZone, readStoredSchedule } from "./schedule";
import {
  DEFAULT_REGION,
  DEFAULT_RETENTION,
  MAX_RETENTION,
  MIN_RETENTION,
  type BackupDestinationView,
  type BackupSchedule,
} from "./types";
import { asc } from "@/src/lib/db/ops";

export type BackupDestinationRow = typeof backupDestinations.$inferSelect;

export const DESTINATION_NOT_FOUND = "Backup destination not found";

const MAX_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
const MAX_PREFIX_LENGTH = 256;
const MAX_SECRET_LENGTH = 1024;
const MAX_PASSPHRASE_LENGTH = 1024;
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/;
const DNS_BUCKET = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
/** S3's "safe characters" for object key names, per path segment. */
const PREFIX_SEGMENT = /^[A-Za-z0-9!_.*'()-]+$/;
/** Printable ASCII without "/" and ",", which would break the SigV4 credential scope. */
const ACCESS_KEY_ID = /^[\x21-\x2b\x2d\x2e\x30-\x7e]{1,256}$/;

const CREATE_FIELDS = [
  "name",
  "enabled",
  "endpoint",
  "region",
  "bucket",
  "prefix",
  "pathStyle",
  "accessKeyId",
  "secretAccessKey",
  "passphrase",
  "schedule",
  "timeZone",
  "retention",
];

// ── Validation ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!CREATE_FIELDS.includes(key)) throw new ApiValidationError(`Unknown field "${key}"`);
  }
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("name is required");
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) throw new ApiValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`);
  if (/\p{Cc}/u.test(name)) throw new ApiValidationError("name must not contain control characters");
  return name;
}

function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
  return value;
}

/** The S3 API origin: http or https, a host, nothing else. Messages never echo the URL. */
export function parseEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("endpoint is required");
  const text = value.trim();
  if (text.length > MAX_URL_LENGTH) throw new ApiValidationError("endpoint is too long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiValidationError("endpoint must be a URL such as https://s3.eu-central-1.amazonaws.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApiValidationError("endpoint must use http or https");
  if (!url.hostname) throw new ApiValidationError("endpoint must include a host");
  if (url.username || url.password) throw new ApiValidationError("endpoint must not contain credentials");
  if ((url.pathname && url.pathname !== "/") || url.search || text.includes("#")) {
    throw new ApiValidationError("endpoint must not have a path, query or fragment; put the bucket and prefix in their own fields");
  }
  return url.origin;
}

function isIpOrSingleLabel(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname;
  return hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || !hostname.includes(".");
}

function parseRegion(value: unknown): string {
  if (value === undefined || value === null || value === "") return DEFAULT_REGION;
  const region = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!REGION.test(region)) throw new ApiValidationError("region must be a region name such as eu-central-1, auto or fsn1");
  return region;
}

function parseBucket(value: unknown, pathStyle: boolean, endpoint: string): string {
  const bucket = typeof value === "string" ? value.trim() : "";
  if (!bucket) throw new ApiValidationError("bucket is required");
  if (!BUCKET.test(bucket) || bucket.includes("..")) {
    throw new ApiValidationError("bucket must be 3-63 characters: letters, digits, dots, hyphens and underscores");
  }
  if (!pathStyle) {
    if (!DNS_BUCKET.test(bucket)) {
      throw new ApiValidationError("This bucket name is not a valid host name; turn on path-style addressing");
    }
    if (isIpOrSingleLabel(endpoint)) {
      throw new ApiValidationError("An endpoint that is an IP address or a single-label host needs path-style addressing");
    }
  }
  return bucket;
}

/** "" or segments joined by "/", without leading or trailing slashes. */
export function parsePrefix(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ApiValidationError("prefix must be a string");
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) return "";
  if (prefix.length > MAX_PREFIX_LENGTH) throw new ApiValidationError(`prefix must be at most ${MAX_PREFIX_LENGTH} characters`);
  for (const segment of prefix.split("/")) {
    if (!segment || segment === "." || segment === ".." || !PREFIX_SEGMENT.test(segment)) {
      throw new ApiValidationError(
        "prefix must be folder names separated by /, using letters, digits and ! _ . * ' ( ) - (no empty, . or .. folders)"
      );
    }
  }
  return prefix;
}

function parseAccessKeyId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new ApiValidationError("accessKeyId is required");
  if (!ACCESS_KEY_ID.test(id)) throw new ApiValidationError("accessKeyId must be printable ASCII without spaces, / or ,");
  return id;
}

/** undefined (or "") keeps the stored value. */
function parseSecretAccessKey(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new ApiValidationError("secretAccessKey must be a string");
  const secret = value.trim();
  if (!secret) return undefined;
  if (secret.length > MAX_SECRET_LENGTH || /\p{Cc}/u.test(secret)) {
    throw new ApiValidationError(`secretAccessKey must be at most ${MAX_SECRET_LENGTH} characters without control characters`);
  }
  return secret;
}

/** undefined (or "") keeps the stored value. Like the export passphrase: at least 12 characters, kept as typed. */
function parsePassphrase(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new ApiValidationError("passphrase must be a string");
  if (value.length > MAX_PASSPHRASE_LENGTH) throw new ApiValidationError(`passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters`);
  if ([...value].length < MIN_EXPORT_PASSPHRASE_LENGTH) {
    throw new ApiValidationError(`passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters`);
  }
  return value;
}

function parseRetention(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_RETENTION || value > MAX_RETENTION) {
    throw new ApiValidationError(`retention must be a whole number from ${MIN_RETENTION} to ${MAX_RETENTION}`);
  }
  return value;
}

export type ParsedDestination = {
  name: string;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  /** undefined keeps the stored value (updates only). */
  secretAccessKey: string | undefined;
  passphrase: string | undefined;
  schedule: BackupSchedule;
  timeZone: string;
  retention: number;
};

export function parseDestinationCreate(body: unknown): ParsedDestination & { secretAccessKey: string; passphrase: string } {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  rejectUnknownKeys(body);
  const endpoint = parseEndpoint(body.endpoint);
  const pathStyle = parseBoolean(body.pathStyle, "pathStyle", false);
  const secretAccessKey = parseSecretAccessKey(body.secretAccessKey);
  if (!secretAccessKey) throw new ApiValidationError("secretAccessKey is required");
  const passphrase = parsePassphrase(body.passphrase);
  if (!passphrase) throw new ApiValidationError("passphrase is required");
  return {
    name: parseName(body.name),
    enabled: parseBoolean(body.enabled, "enabled", true),
    endpoint,
    region: parseRegion(body.region),
    bucket: parseBucket(body.bucket, pathStyle, endpoint),
    prefix: parsePrefix(body.prefix),
    pathStyle,
    accessKeyId: parseAccessKeyId(body.accessKeyId),
    secretAccessKey,
    passphrase,
    schedule: parseSchedule(body.schedule),
    timeZone: parseTimeZone(body.timeZone),
    retention: parseRetention(body.retention, DEFAULT_RETENTION),
  };
}

/** Fields left out keep their values; secrets left out or empty keep the stored ones. */
export function parseDestinationUpdate(body: unknown, existing: BackupDestinationRow): ParsedDestination {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  rejectUnknownKeys(body);
  const endpoint = body.endpoint === undefined ? existing.endpoint : parseEndpoint(body.endpoint);
  const pathStyle = parseBoolean(body.pathStyle, "pathStyle", existing.pathStyle);
  const secretAccessKey = parseSecretAccessKey(body.secretAccessKey);
  if (endpoint !== existing.endpoint && secretAccessKey === undefined) {
    // A stored credential is never used with an endpoint it was not entered for.
    throw new ApiValidationError("Enter the secret access key again when changing the endpoint");
  }
  return {
    name: body.name === undefined ? existing.name : parseName(body.name),
    enabled: parseBoolean(body.enabled, "enabled", existing.enabled),
    endpoint,
    region: body.region === undefined ? existing.region : parseRegion(body.region),
    bucket: parseBucket(body.bucket === undefined ? existing.bucket : body.bucket, pathStyle, endpoint),
    prefix: body.prefix === undefined ? existing.keyPrefix : parsePrefix(body.prefix),
    pathStyle,
    accessKeyId: body.accessKeyId === undefined ? existing.accessKeyId : parseAccessKeyId(body.accessKeyId),
    secretAccessKey,
    passphrase: parsePassphrase(body.passphrase),
    schedule: body.schedule === undefined ? readStoredSchedule(existing.schedule) : parseSchedule(body.schedule),
    timeZone: body.timeZone === undefined ? existing.timeZone : parseTimeZone(body.timeZone),
    retention: parseRetention(body.retention, existing.retention),
  };
}

/**
 * Whether an update only turns the destination off: `enabled: false`, with
 * any other field repeating its stored value and no new secret.
 */
export function isDisableOnlyUpdate(body: unknown, existing: BackupDestinationRow): boolean {
  if (!isRecord(body) || body.enabled !== false) return false;
  const stored: Record<string, unknown> = {
    name: existing.name,
    endpoint: existing.endpoint,
    region: existing.region,
    bucket: existing.bucket,
    prefix: existing.keyPrefix,
    pathStyle: existing.pathStyle,
    accessKeyId: existing.accessKeyId,
    timeZone: existing.timeZone,
    retention: existing.retention,
  };
  return Object.entries(body).every(([key, value]) => {
    if (key === "enabled") return true;
    if (key === "secretAccessKey" || key === "passphrase") return value === undefined || value === "";
    if (key === "schedule") return JSON.stringify(value) === JSON.stringify(readStoredSchedule(existing.schedule));
    if (!(key in stored)) return false;
    return typeof value === "string" ? value.trim() === stored[key] : value === stored[key];
  });
}

// ── Storage ──────────────────────────────────────────────────────────

/** The view of a destination; `running` when a backup to it is in progress (locks.ts). */
export function toDestinationView(row: BackupDestinationRow, running: boolean): BackupDestinationView {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.keyPrefix,
    pathStyle: row.pathStyle,
    accessKeyId: row.accessKeyId,
    hasSecretAccessKey: Boolean(row.secretAccessKey),
    hasPassphrase: Boolean(row.passphrase),
    schedule: readStoredSchedule(row.schedule),
    timeZone: row.timeZone,
    retention: row.retention,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus === "success" || row.lastStatus === "failed" ? row.lastStatus : null,
    lastError: row.lastError,
    lastSuccessAt: row.lastSuccessAt,
    consecutiveFailures: row.consecutiveFailures,
    running,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getDestinationRow(id: number): Promise<BackupDestinationRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const [row] = await appDb.select().from(backupDestinations).where(eq(backupDestinations.id, id));
  return row ?? null;
}

export async function requireDestinationRow(id: number): Promise<BackupDestinationRow> {
  const row = await getDestinationRow(id);
  if (!row) throw new ApiClientError(DESTINATION_NOT_FOUND, 404);
  return row;
}

export async function listBackupDestinations(): Promise<BackupDestinationView[]> {
  const rows = await appDb.select().from(backupDestinations).orderBy(asc(backupDestinations.name), asc(backupDestinations.id));
  const running = await runningDestinationIds(rows.map((row) => row.id));
  return rows.map((row) => toDestinationView(row, running.has(row.id)));
}

export async function getBackupDestination(id: number): Promise<BackupDestinationView> {
  const row = await requireDestinationRow(id);
  return toDestinationView(row, await isDestinationRunning(row.id));
}

/** Key prefix of the backup files, with a trailing "/" unless it is the bucket root. */
export function objectPrefix(row: Pick<BackupDestinationRow, "keyPrefix">): string {
  return row.keyPrefix ? `${row.keyPrefix}/` : "";
}

/** An S3 client for the destination, with its secret decrypted. */
export function clientFor(row: BackupDestinationRow, options: S3ClientOptions = {}): S3Client {
  let secretAccessKey: string;
  try {
    secretAccessKey = decryptSecret(row.secretAccessKey, `backup destination ${row.id} secret access key`);
  } catch {
    throw new S3Error("The stored secret access key cannot be decrypted with SESSION_SECRET; enter it again");
  }
  return new S3Client(
    { endpoint: row.endpoint, region: row.region, bucket: row.bucket, pathStyle: row.pathStyle },
    { accessKeyId: row.accessKeyId, secretAccessKey },
    options
  );
}

export function storedPassphrase(row: BackupDestinationRow): string {
  try {
    return decryptSecret(row.passphrase, `backup destination ${row.id} passphrase`);
  } catch {
    throw new S3Error("The stored passphrase cannot be decrypted with SESSION_SECRET; enter it again");
  }
}

function describeTarget(input: Pick<ParsedDestination, "endpoint" | "bucket" | "prefix">): string {
  return `${input.endpoint} bucket ${input.bucket}${input.prefix ? `/${input.prefix}` : ""}`;
}

function auditData(input: ParsedDestination) {
  return {
    name: input.name,
    enabled: input.enabled,
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix,
    pathStyle: input.pathStyle,
    accessKeyId: input.accessKeyId,
    schedule: input.schedule,
    timeZone: input.timeZone,
    retention: input.retention,
  };
}

// ── Administrator actions ────────────────────────────────────────────

export async function createBackupDestination(body: unknown, actorUserId: number, now: Date = new Date()): Promise<BackupDestinationView> {
  const input = parseDestinationCreate(body);
  // A slave's configuration comes from the master: back up the master.
  await assertConfigurationEditable();
  const stamp = nowIso();
  const [row] = await appDb
    .insert(backupDestinations)
    .values({
      name: input.name,
      enabled: input.enabled,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      keyPrefix: input.prefix,
      pathStyle: input.pathStyle,
      accessKeyId: input.accessKeyId,
      secretAccessKey: encryptSecret(input.secretAccessKey),
      passphrase: encryptSecret(input.passphrase),
      schedule: JSON.stringify(input.schedule),
      timeZone: input.timeZone,
      retention: input.retention,
      nextRunAt: input.enabled ? nextRunAfter(input.schedule, input.timeZone, now).toISOString() : null,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning();
  await logAuditEvent({
    userId: actorUserId,
    action: "backup_destination_created",
    entityType: "backup_destination",
    entityId: row.id,
    summary: `Created backup destination "${input.name}" (${describeTarget(input)})`,
    data: auditData(input),
  });
  return toDestinationView(row, false);
}

export async function updateBackupDestination(
  id: number,
  body: unknown,
  actorUserId: number,
  now: Date = new Date()
): Promise<BackupDestinationView> {
  const existing = await requireDestinationRow(id);
  if (isDisableOnlyUpdate(body, existing)) {
    // Turning it off: nothing stored is validated again.
    const [row] = await appDb
      .update(backupDestinations)
      .set({ enabled: false, nextRunAt: null, updatedAt: nowIso() })
      .where(eq(backupDestinations.id, id))
      .returning();
    await logAuditEvent({
      userId: actorUserId,
      action: "backup_destination_updated",
      entityType: "backup_destination",
      entityId: id,
      summary: `Updated backup destination "${existing.name}": disabled`,
      data: { name: existing.name, enabled: false },
    });
    return toDestinationView(row, await isDestinationRunning(id));
  }
  const input = parseDestinationUpdate(body, existing);

  const scheduleChanged = JSON.stringify(input.schedule) !== existing.schedule || input.timeZone !== existing.timeZone;
  const targetChanged =
    input.endpoint !== existing.endpoint ||
    input.region !== existing.region ||
    input.bucket !== existing.bucket ||
    input.prefix !== existing.keyPrefix ||
    input.pathStyle !== existing.pathStyle ||
    input.accessKeyId !== existing.accessKeyId ||
    input.secretAccessKey !== undefined ||
    input.passphrase !== undefined;
  // A changed schedule or target, or a destination turned back on, starts
  // from its schedule again (no backoff from earlier failures).
  const reschedule = input.enabled && (!existing.enabled || scheduleChanged || targetChanged || !existing.nextRunAt);

  const [row] = await appDb
    .update(backupDestinations)
    .set({
      name: input.name,
      enabled: input.enabled,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      keyPrefix: input.prefix,
      pathStyle: input.pathStyle,
      accessKeyId: input.accessKeyId,
      ...(input.secretAccessKey !== undefined ? { secretAccessKey: encryptSecret(input.secretAccessKey) } : {}),
      ...(input.passphrase !== undefined ? { passphrase: encryptSecret(input.passphrase) } : {}),
      schedule: JSON.stringify(input.schedule),
      timeZone: input.timeZone,
      retention: input.retention,
      ...(!input.enabled
        ? { nextRunAt: null }
        : reschedule
          ? { nextRunAt: nextRunAfter(input.schedule, input.timeZone, now).toISOString(), consecutiveFailures: 0 }
          : {}),
      updatedAt: nowIso(),
    })
    .where(eq(backupDestinations.id, id))
    .returning();

  const changes: string[] = [];
  if (input.enabled !== existing.enabled) changes.push(input.enabled ? "enabled" : "disabled");
  if (scheduleChanged) changes.push("schedule");
  if (input.retention !== existing.retention) changes.push(`retention ${existing.retention} → ${input.retention}`);
  if (targetChanged) changes.push("storage settings");
  if (input.name !== existing.name) changes.push("name");
  await logAuditEvent({
    userId: actorUserId,
    action: "backup_destination_updated",
    entityType: "backup_destination",
    entityId: id,
    summary: `Updated backup destination "${input.name}"${changes.length ? `: ${changes.join(", ")}` : ""}`,
    data: {
      ...auditData(input),
      secretAccessKeyChanged: input.secretAccessKey !== undefined,
      passphraseChanged: input.passphrase !== undefined,
    },
  });
  return toDestinationView(row, await isDestinationRunning(id));
}

/**
 * Deletes a destination. Its run history goes with it; the backup files in
 * the bucket are left alone.
 */
export async function deleteBackupDestination(id: number, actorUserId: number): Promise<void> {
  const existing = await requireDestinationRow(id);
  // Foreign-key cascades are not enforced: delete the runs explicitly.
  await appDb.delete(backupRuns).where(eq(backupRuns.destinationId, id));
  await appDb.delete(backupDestinations).where(eq(backupDestinations.id, id));
  await logAuditEvent({
    userId: actorUserId,
    action: "backup_destination_deleted",
    entityType: "backup_destination",
    entityId: id,
    summary: `Deleted backup destination "${existing.name}" (the files in the bucket were kept)`,
    data: { name: existing.name, endpoint: existing.endpoint, bucket: existing.bucket, prefix: existing.keyPrefix },
  });
}
