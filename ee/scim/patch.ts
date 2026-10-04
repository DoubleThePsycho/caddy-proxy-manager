// SPDX-License-Identifier: Elastic-2.0
/**
 * PATCH requests (RFC 7644 section 3.5.2) as Microsoft Entra ID and Okta send
 * them: operation names in any case ("Replace", "add"), operations with a
 * path, and path-less operations whose value is an object of attributes
 * (Okta's `{"op":"replace","value":{"active":false}}`, Entra's
 * `{"op":"Replace","value":{"displayName":"x"}}`), where keys may be paths
 * themselves ("name.givenName").
 */
import { parsePath, type ParsedPath } from "./filter";
import { ScimError, SCHEMA_PATCH } from "./protocol";

export type PatchOp = "add" | "replace" | "remove";

export type PatchOperation = { op: PatchOp; path: ParsedPath | null; value: unknown };

const MAX_OPERATIONS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The operations of a PATCH body, validated. */
export function readPatchOperations(body: unknown): PatchOperation[] {
  if (!isRecord(body)) throw new ScimError(400, "The request body must be a JSON object", "invalidSyntax");
  if (Array.isArray(body.schemas) && body.schemas.length > 0 && !body.schemas.includes(SCHEMA_PATCH)) {
    throw new ScimError(400, `schemas must contain ${SCHEMA_PATCH}`, "invalidSyntax");
  }
  const raw = body.Operations ?? body.operations;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ScimError(400, "Operations must be a non-empty array", "invalidSyntax");
  }
  if (raw.length > MAX_OPERATIONS) throw new ScimError(400, `At most ${MAX_OPERATIONS} operations per request`, "tooMany");
  return raw.map((entry) => {
    if (!isRecord(entry)) throw new ScimError(400, "Each operation must be an object", "invalidSyntax");
    const op = typeof entry.op === "string" ? entry.op.toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw new ScimError(400, 'op must be "add", "replace" or "remove"', "invalidSyntax");
    }
    const path = entry.path === undefined || entry.path === null || entry.path === "" ? null : parsePath(entry.path);
    if (path === null && op === "remove") {
      throw new ScimError(400, "A remove operation needs a path", "noTarget");
    }
    if (path === null && !isRecord(entry.value)) {
      throw new ScimError(400, "An operation without a path needs an object value", "invalidValue");
    }
    if (op !== "remove" && entry.value === undefined) {
      throw new ScimError(400, `An ${op} operation needs a value`, "invalidValue");
    }
    return { op, path, value: entry.value };
  });
}

/**
 * A path-less operation as one operation per attribute of its value. Keys of
 * extension schemas ("urn:...") come back as such, for callers to ignore.
 */
export function expandPathless(operation: PatchOperation): PatchOperation[] {
  if (operation.path !== null) return [operation];
  const value = operation.value as Record<string, unknown>;
  return Object.entries(value).map(([key, item]) => ({ op: operation.op, path: parsePath(key), value: item }));
}

/** SCIM booleans; Entra ID sends "True"/"False" strings in some requests. */
export function readScimBoolean(value: unknown, attribute: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  throw new ScimError(400, `${attribute} must be true or false`, "invalidValue");
}

/** A string attribute value; null/"" (where allowed) clear it. */
export function readScimString(
  value: unknown,
  attribute: string,
  options: { max?: number; required?: boolean } = {}
): string | null {
  const max = options.max ?? 256;
  if (value === null || value === undefined || value === "") {
    if (options.required) throw new ScimError(400, `${attribute} is required`, "invalidValue");
    return null;
  }
  if (typeof value !== "string") throw new ScimError(400, `${attribute} must be a string`, "invalidValue");
  if (options.required && !value.trim()) throw new ScimError(400, `${attribute} is required`, "invalidValue");
  if (value.length > max) throw new ScimError(400, `${attribute} must be at most ${max} characters`, "invalidValue");
  if (/\p{Cc}/u.test(value)) throw new ScimError(400, `${attribute} must not contain control characters`, "invalidValue");
  return value;
}
