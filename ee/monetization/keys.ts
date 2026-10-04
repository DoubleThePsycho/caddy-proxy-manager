// SPDX-License-Identifier: Elastic-2.0
/**
 * Consumer API keys and portal tokens.
 *
 * A key looks like ik_<12 hex>_<43 base64url>: the first part (with "ik_") is
 * its public prefix, stored in clear and used to find the key; the database
 * keeps only the SHA-256 of the whole key, compared in constant time. Like
 * dashboard API tokens, a key is shown once when it is created.
 *
 * Portal tokens are 32 random bytes (base64url); only their SHA-256 is stored.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PATTERN = /^(ik_[a-f0-9]{12})_[A-Za-z0-9_-]{43}$/;
const PORTAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateConsumerKey(): { raw: string; prefix: string; hash: string } {
  const prefix = `ik_${randomBytes(6).toString("hex")}`;
  const raw = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { raw, prefix, hash: sha256Hex(raw) };
}

/** The public prefix of a well-formed key, or null. */
export function keyPrefix(raw: string): string | null {
  return KEY_PATTERN.exec(raw)?.[1] ?? null;
}

/** Constant-time comparison of a presented key with a stored SHA-256 (raw bytes, see keyDigest). */
export function keyMatchesDigest(raw: string, stored: Buffer): boolean {
  const presented = createHash("sha256").update(raw).digest();
  return stored.length === presented.length && timingSafeEqual(presented, stored);
}

/** The stored SHA-256 (hex) as bytes, decoded once when the gate loads. */
export function keyDigest(storedHash: string): Buffer {
  return Buffer.from(storedHash, "hex");
}

export function generatePortalToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

export function isPortalTokenShape(value: unknown): value is string {
  return typeof value === "string" && PORTAL_TOKEN_PATTERN.test(value);
}
