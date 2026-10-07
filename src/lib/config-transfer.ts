/**
 * Manual configuration export and import.
 *
 * An export file holds the configuration (config-content.ts) as readable
 * JSON, except for its secrets: certificate and CA private keys, access-list
 * password hashes and the encrypted strings inside settings (DNS provider
 * credentials) are decrypted with this instance's key and encrypted again
 * with a passphrase the user chooses (scrypt, AES-256-GCM, each value bound
 * to its place in the file). The file therefore moves to any installation,
 * whatever its SESSION_SECRET, and is useless without the passphrase.
 *
 * Format (version 1):
 *   { format: "ingressi-configuration", version: 1, exportedAt, appVersion,
 *     kdf: { name: "scrypt", N, r, p, salt }, cipher: "aes-256-gcm",
 *     check: <sealed constant, verifies the passphrase>,
 *     users: { <user id>: <email> } for the users forward-auth grants name,
 *     content: { version: 1, tables, settings } with secrets as "pp:v1:..." }
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from "node:crypto";
import { inArray } from "drizzle-orm";
import { appDb } from "./db";
import { users } from "./db/schema";
import { ApiConflictError, ApiValidationError } from "./api-errors";
import { APP_VERSION } from "./app-version";
import { logAuditEvent } from "./audit";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secret";
import {
  CONFIG_TABLE_NAMES,
  CONFIG_TABLES,
  ConfigContentError,
  countConfigContent,
  encryptPlaintextSettingCredentials,
  mapConfigSecrets,
  parseConfigContent,
  readConfigContent,
  secretPlaceLabel,
  type ConfigContent,
  type ConfigCounts,
  type DbTransaction,
} from "./config-content";
import { assertConfigurationEditable, replaceConfiguration } from "./config-replace";
import { parseRowId } from "./row-ids";

export const CONFIG_EXPORT_FORMAT = "ingressi-configuration";
export const CONFIG_EXPORT_VERSION = 1;
export const MIN_EXPORT_PASSPHRASE_LENGTH = 12;
const MAX_PASSPHRASE_LENGTH = 1024;
/** Largest import file accepted, in bytes. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const SEALED_PREFIX = "pp:v1:";
const CHECK_PLAINTEXT = "ingressi-configuration-export";
const CHECK_PLACE = JSON.stringify(["check"]);
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
/** OWASP's recommended scrypt cost (128 MiB). */
const EXPORT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
const MIN_KDF_N = 2 ** 14;
const MAX_KDF_N = 2 ** 18;

export type ConfigExportKdf = { name: "scrypt"; N: number; r: number; p: number; salt: string };

export type ConfigExportFile = {
  format: typeof CONFIG_EXPORT_FORMAT;
  version: typeof CONFIG_EXPORT_VERSION;
  exportedAt: string;
  appVersion: string;
  kdf: ConfigExportKdf;
  cipher: "aes-256-gcm";
  check: string;
  users: Record<string, string>;
  content: ConfigContent;
};

function deriveKey(passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 2 * 128 * kdf.N * kdf.r * kdf.p };
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize("NFC"), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function seal(key: Buffer, plaintext: string, place: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(place, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${SEALED_PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

/** The plaintext, or null when the value is malformed or does not open with `key` at `place`. */
function open(key: Buffer, sealed: string, place: string): string | null {
  const parts = sealed.slice(SEALED_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
    if (iv.length !== IV_LENGTH || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(place, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function validatePassphrase(passphrase: unknown, forExport: boolean): string {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new ApiValidationError("A passphrase is required");
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new ApiValidationError(`The passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters`);
  }
  if (forExport && [...passphrase].length < MIN_EXPORT_PASSPHRASE_LENGTH) {
    throw new ApiValidationError(`The passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters`);
  }
  return passphrase;
}

/** Columns that only record who created or owns a row; meaningless on another installation. */
function withoutAttribution(content: ConfigContent): ConfigContent {
  const tables = { ...content.tables };
  for (const name of CONFIG_TABLE_NAMES) {
    const columns = CONFIG_TABLES[name].attributionColumns;
    if (columns.length === 0) continue;
    tables[name] = content.tables[name].map((row) => {
      const next = { ...row };
      for (const column of columns) {
        if (column in next) next[column] = null;
      }
      return next;
    });
  }
  return { ...content, tables };
}

function grantUserIds(content: ConfigContent): number[] {
  const ids = new Set<number>();
  for (const grant of content.tables.forwardAuthAccess) {
    if (typeof grant.userId === "number") ids.add(grant.userId);
  }
  return [...ids];
}

export function configExportFilename(date: Date = new Date()): string {
  return `ingressi-configuration-${date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}.json`;
}

/**
 * Builds an export file of the current configuration, its secrets encrypted
 * with `passphrase`, without recording anything. Refused on a sync slave,
 * whose settings come from the master, and when a stored secret no key here
 * decrypts. Scheduled backups (ee/backups) upload exactly this file.
 */
export async function buildConfigurationExport(
  passphrase: unknown
): Promise<{ filename: string; file: ConfigExportFile; counts: ConfigCounts }> {
  const phrase = validatePassphrase(passphrase, true);
  await assertConfigurationEditable();

  // The configuration and the users its grants name, from one snapshot.
  const { stored, userEmails } = await appDb.transaction(async (tx) => {
    const stored = await readConfigContent(tx);
    const referencedUsers = grantUserIds(stored);
    const userEmails =
      referencedUsers.length > 0
        ? await tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, referencedUsers)).orderBy(users.id)
        : [];
    return { stored, userEmails };
  }, { readOnly: true });
  const content = withoutAttribution(encryptPlaintextSettingCredentials(stored));

  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(phrase, salt, EXPORT_KDF);
  let undecryptable = 0;
  const sealed = mapConfigSecrets(content, (value, place) => {
    let plaintext = value;
    if (isEncryptedSecret(value)) {
      try {
        plaintext = decryptSecret(value, "configuration export");
      } catch {
        undecryptable += 1;
        return "";
      }
    }
    return seal(key, plaintext, secretPlaceLabel(place));
  });
  if (undecryptable > 0) {
    throw new ApiConflictError(
      `${undecryptable} stored secret(s) cannot be decrypted with SESSION_SECRET or SESSION_SECRET_PREVIOUS. ` +
        "Re-enter them, or set SESSION_SECRET_PREVIOUS to the secret they were stored with, then export again."
    );
  }

  const exportedAt = new Date();
  const file: ConfigExportFile = {
    format: CONFIG_EXPORT_FORMAT,
    version: CONFIG_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    appVersion: APP_VERSION,
    kdf: { name: "scrypt", ...EXPORT_KDF, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    check: seal(key, CHECK_PLAINTEXT, CHECK_PLACE),
    users: Object.fromEntries(userEmails.map((user) => [String(user.id), user.email])),
    content: sealed,
  };

  return { filename: configExportFilename(exportedAt), file, counts: countConfigContent(content) };
}

/** buildConfigurationExport for an administrator's download, recorded in the audit log. */
export async function exportConfiguration(passphrase: unknown, userId: number): Promise<{ filename: string; file: ConfigExportFile }> {
  const { filename, file, counts } = await buildConfigurationExport(passphrase);
  await logAuditEvent({
    userId,
    action: "config_exported",
    entityType: "configuration",
    summary: "Exported the configuration",
    data: { counts },
  });
  return { filename, file };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FILE_KEYS = ["format", "version", "exportedAt", "appVersion", "kdf", "cipher", "check", "users", "content"];

function invalidFile(reason: string): ApiValidationError {
  return new ApiValidationError(`This is not a valid ${CONFIG_EXPORT_FORMAT} file: ${reason}`);
}

function parseKdf(raw: unknown): { N: number; r: number; p: number; salt: Buffer } {
  if (!isRecord(raw) || raw.name !== "scrypt") throw invalidFile("kdf must be scrypt");
  for (const key of Object.keys(raw)) {
    if (!["name", "N", "r", "p", "salt"].includes(key)) throw invalidFile(`kdf has an unknown field "${key}"`);
  }
  const { N, r, p, salt } = raw;
  if (typeof N !== "number" || !Number.isInteger(N) || N < MIN_KDF_N || N > MAX_KDF_N || (N & (N - 1)) !== 0) {
    throw invalidFile("kdf.N is out of range");
  }
  if (r !== 8 || p !== 1) throw invalidFile("kdf.r must be 8 and kdf.p must be 1");
  if (typeof salt !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(salt)) throw invalidFile("kdf.salt must be base64");
  const saltBytes = Buffer.from(salt, "base64");
  if (saltBytes.length < SALT_LENGTH || saltBytes.length > 64) throw invalidFile("kdf.salt has the wrong length");
  return { N, r, p, salt: saltBytes };
}

function parseUsers(raw: unknown): Map<number, string> {
  if (!isRecord(raw)) throw invalidFile("users must be an object");
  const result = new Map<number, string>();
  for (const [id, email] of Object.entries(raw)) {
    const userId = parseRowId(id);
    if (userId === null || typeof email !== "string" || email.length === 0 || email.length > 320) {
      throw invalidFile("users must map user ids to email addresses");
    }
    result.set(userId, email);
  }
  return result;
}

/**
 * Validates an export file, checks the passphrase and returns its
 * configuration with every secret encrypted with this instance's key (hashes
 * stay hashes). Throws a 400 ApiValidationError for anything wrong with the
 * file or the passphrase; nothing is written.
 */
export async function decodeConfigurationExport(raw: unknown, passphrase: unknown): Promise<ConfigContent> {
  const phrase = validatePassphrase(passphrase, false);
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) {
      throw new ApiValidationError(`The file is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB`);
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidFile("it is not JSON");
    }
  }
  if (!isRecord(parsed)) throw invalidFile("it must be a JSON object");
  if (parsed.format !== CONFIG_EXPORT_FORMAT) throw invalidFile(`format must be "${CONFIG_EXPORT_FORMAT}"`);
  if (parsed.version !== CONFIG_EXPORT_VERSION) {
    throw new ApiValidationError(
      `This file has export format version ${JSON.stringify(parsed.version)}; this release reads version ${CONFIG_EXPORT_VERSION}`
    );
  }
  for (const key of Object.keys(parsed)) {
    if (!FILE_KEYS.includes(key)) throw invalidFile(`it has an unknown field "${key}"`);
  }
  if (typeof parsed.exportedAt !== "string" || typeof parsed.appVersion !== "string") {
    throw invalidFile("exportedAt and appVersion must be strings");
  }
  if (parsed.cipher !== "aes-256-gcm") throw invalidFile("cipher must be aes-256-gcm");
  if (typeof parsed.check !== "string" || !parsed.check.startsWith(SEALED_PREFIX)) throw invalidFile("check is missing");
  const kdf = parseKdf(parsed.kdf);
  const fileUsers = parseUsers(parsed.users);

  let content: ConfigContent;
  try {
    content = parseConfigContent(parsed.content);
  } catch (error) {
    if (error instanceof ConfigContentError) throw invalidFile(error.message);
    throw error;
  }

  const key = await deriveKey(phrase, kdf.salt, kdf);
  if (open(key, parsed.check, CHECK_PLACE) !== CHECK_PLAINTEXT) {
    throw new ApiValidationError("Wrong passphrase: the file cannot be decrypted with it. Nothing was changed.");
  }

  const decrypted = mapConfigSecrets(
    content,
    (value, place) => {
      const label = secretPlaceLabel(place);
      if (isEncryptedSecret(value)) {
        throw invalidFile(`the secret at ${label} is encrypted with an instance key instead of the passphrase`);
      }
      let plaintext = value;
      if (value.startsWith(SEALED_PREFIX)) {
        const opened = open(key, value, label);
        if (opened === null) throw invalidFile(`the secret at ${label} does not decrypt; the file is damaged`);
        plaintext = opened;
      }
      if (place.kind === "column" && place.protection === "hash") return plaintext;
      return encryptSecret(plaintext);
    },
    (value) => value.startsWith(SEALED_PREFIX) || isEncryptedSecret(value)
  );

  return await mapGrantUsers(withoutAttribution(decrypted), fileUsers);
}

/**
 * Forward-auth grants name users by id, which differ between installations:
 * each one is mapped to the local user with the email address the file gives
 * for it, and dropped when there is none.
 */
async function mapGrantUsers(content: ConfigContent, fileUsers: Map<number, string>): Promise<ConfigContent> {
  if (!content.tables.forwardAuthAccess.some((grant) => grant.userId != null)) return content;
  const localUsers = await appDb.select({ id: users.id, email: users.email }).from(users);
  const byEmail = new Map(localUsers.map((user) => [user.email.toLowerCase(), user.id]));
  const grants = content.tables.forwardAuthAccess.flatMap((grant) => {
    if (grant.userId == null) return [grant];
    const email = fileUsers.get(grant.userId as number);
    const localId = email ? byEmail.get(email.toLowerCase()) : undefined;
    return localId === undefined ? [] : [{ ...grant, userId: localId }];
  });
  return { ...content, tables: { ...content.tables, forwardAuthAccess: grants } };
}

export type ImportConfigurationResult = { counts: ConfigCounts; warning: string | null };

/**
 * Replaces the configuration with the one in an export file. Validation and
 * the passphrase check happen before anything is written; `beforeWrite` runs
 * in the same transaction as the replacement (configuration history uses it
 * to save the configuration being replaced). Refused on a sync slave.
 */
export async function importConfiguration(input: {
  file: unknown;
  passphrase: unknown;
  userId: number;
  beforeWrite?: (tx: DbTransaction, current: ConfigContent) => Promise<void>;
}): Promise<ImportConfigurationResult> {
  await assertConfigurationEditable();
  const content = await decodeConfigurationExport(input.file, input.passphrase);
  const { warning } = await replaceConfiguration(content, { mode: "import", beforeWrite: input.beforeWrite });
  const counts = countConfigContent(content);
  await logAuditEvent({
    userId: input.userId,
    action: "config_imported",
    entityType: "configuration",
    summary: "Imported a configuration file",
    data: { counts },
  });
  return { counts, warning };
}
