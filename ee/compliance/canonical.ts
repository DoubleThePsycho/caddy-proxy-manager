// SPDX-License-Identifier: Elastic-2.0
/**
 * Canonical JSON for report hashing: RFC 8785 (JSON Canonicalization Scheme).
 * Object keys are sorted by UTF-16 code units, there is no whitespace, and
 * strings and numbers are serialized as ECMAScript's JSON.stringify does,
 * which is what RFC 8785 specifies. Anyone can recompute a report's hash with
 * a JCS library: remove the "integrity" member, canonicalize, SHA-256.
 */
import { createHash } from "node:crypto";

export const CANONICALIZATION = "RFC 8785 (JSON Canonicalization Scheme) of the report without its integrity member";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain NaN or Infinity");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Canonical JSON cannot contain a ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
