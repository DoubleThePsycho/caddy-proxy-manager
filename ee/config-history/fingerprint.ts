// SPDX-License-Identifier: Elastic-2.0
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { config } from "@/src/lib/config";
import { decryptSecret, isEncryptedSecret } from "@/src/lib/secret";
import {
  CONFIG_TABLE_NAMES,
  CONFIG_TABLES_ADDED_LATER,
  mapConfigSecrets,
  type ConfigContent,
} from "@/src/lib/config-content";

/** Columns that change without changing what Caddy serves; ignored by fingerprints and diffs. */
export const VOLATILE_COLUMNS: ReadonlySet<string> = new Set(["createdAt", "updatedAt"]);

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

/** JSON with object keys sorted at every level, so equal values serialize equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

let digestKey: { secret: string; key: Buffer } | null = null;

function secretDigestKey(): Buffer {
  if (!digestKey || digestKey.secret !== config.sessionSecret) {
    digestKey = {
      secret: config.sessionSecret,
      key: Buffer.from(hkdfSync("sha256", config.sessionSecret, Buffer.alloc(0), "ingressi:config-history:secret-digest:v1", 32)),
    };
  }
  return digestKey.key;
}

/**
 * A comparable stand-in for a secret: a keyed digest of its plaintext, so a
 * secret re-encrypted without changing compares equal, and the digest (folded
 * into the stored fingerprint) cannot be used to guess the secret without
 * SESSION_SECRET. A value no key decrypts is compared as stored.
 */
export function secretDigest(value: string): string {
  let plaintext = value;
  if (isEncryptedSecret(value)) {
    try {
      plaintext = decryptSecret(value, "configuration history");
    } catch {
      return `stored:${createHash("sha256").update(value).digest("hex")}`;
    }
  }
  return `secret:${createHmac("sha256", secretDigestKey()).update(plaintext).digest("hex")}`;
}

/**
 * SHA-256 of the canonical content without timestamps and with secrets
 * replaced by their digests: equal for configurations that serve the same.
 */
export function configFingerprint(content: ConfigContent): string {
  const normalized = mapConfigSecrets(content, (value) => secretDigest(value));
  const tables = Object.fromEntries(
    CONFIG_TABLE_NAMES.filter((name) => !CONFIG_TABLES_ADDED_LATER.has(name) || normalized.tables[name].length > 0).map((name) => [
      name,
      normalized.tables[name].map((row) =>
        Object.fromEntries(Object.entries(row).filter(([column]) => !VOLATILE_COLUMNS.has(column)))
      ),
    ])
  );
  return createHash("sha256")
    .update(canonicalJson({ version: normalized.version, tables, settings: normalized.settings }))
    .digest("hex");
}
