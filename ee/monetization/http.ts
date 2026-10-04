// SPDX-License-Identifier: Elastic-2.0
/**
 * Request parsing and validation shared by the monetization endpoints.
 * Messages are application-authored and never echo secrets.
 */
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { MAX_AMOUNT_MICROS } from "./money";
import { parseRowId } from "@/src/lib/row-ids";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** Route ids that are not positive integers name nothing. */
export function parseRouteId(raw: string, notFound: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(notFound, 404);
  return id;
}

export function readPageParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  return body;
}

export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown field "${key.slice(0, 64)}"`);
  }
}

export function parseName(value: unknown, field = "name", max = 100): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError(`${field} is required`);
  const name = value.trim();
  if (name.length > max) throw new ApiValidationError(`${field} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(name)) throw new ApiValidationError(`${field} must not contain control characters`);
  return name;
}

export function parseOptionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiValidationError(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new ApiValidationError(`${field} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(text)) throw new ApiValidationError(`${field} must not contain control characters`);
  return text;
}

export function parseInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiValidationError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** A non-negative amount in micro-units. */
export function parseAmount(value: unknown, field: string): number {
  return parseInteger(value, field, 0, MAX_AMOUNT_MICROS);
}

export function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
  return value;
}

export function parseIdList(value: unknown, field: string, max = 100): number[] {
  if (!Array.isArray(value)) throw new ApiValidationError(`${field} must be an array of ids`);
  if (value.length > max) throw new ApiValidationError(`${field} may list at most ${max} ids`);
  const ids = value.map((id) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new ApiValidationError(`${field} must be an array of ids`);
    }
    return id;
  });
  return [...new Set(ids)].sort((a, b) => a - b);
}
