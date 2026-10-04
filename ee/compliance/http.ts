// SPDX-License-Identifier: Elastic-2.0
/**
 * Request parsing shared by the compliance endpoints. Messages are
 * application-authored and never echo stored data.
 */
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/src/lib/api-auth";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { parseRowId } from "@/src/lib/row-ids";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function readJsonBody(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** Route ids that are not positive integers name nothing. */
export function parseRouteId(raw: string | undefined, notFound: string): number {
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

export function requireRecord(body: unknown, what = "Request body"): Record<string, unknown> {
  if (!isRecord(body)) throw new ApiValidationError(`${what} must be a JSON object`);
  return body;
}

export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], what = "the request"): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown field "${key.slice(0, 64)}" in ${what}`);
  }
}

/** A single-line, printable string of bounded length. */
export function parseLine(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError(`${field} is required`);
  const text = value.trim();
  if (text.length > max) throw new ApiValidationError(`${field} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(text)) throw new ApiValidationError(`${field} must not contain control characters`);
  return text;
}

/** Multi-line text: newlines and tabs allowed, other control characters refused; "" is allowed. */
export function parseMultiline(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ApiValidationError(`${field} must be a string`);
  const text = value.replace(/\r\n?/g, "\n");
  if (text.length > max) throw new ApiValidationError(`${field} must be at most ${max} characters`);
  if (/(?![\n\t])\p{Cc}/u.test(text)) throw new ApiValidationError(`${field} must not contain control characters`);
  return text.trim();
}

/**
 * An ISO 8601 date (YYYY-MM-DD, UTC) or date-time with a zone. A bare date as
 * an upper bound means the end of that day.
 */
export function parseInstant(value: unknown, field: string, endOfDay = false): Date {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 40) {
    throw new ApiValidationError(`${field} must be an ISO 8601 date or date-time`);
  }
  const trimmed = value.trim();
  const isDate = DATE_ONLY.test(trimmed);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const ms = Date.parse(isDate ? `${trimmed}T00:00:00.000Z` : trimmed);
  if (Number.isNaN(ms) || !(isDate || (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && hasZone))) {
    throw new ApiValidationError(`${field} must be an ISO 8601 date or a date-time with a time zone`);
  }
  return new Date(isDate && endOfDay ? ms + DAY_MS - 1 : ms);
}

export type Period = { from: Date; to: Date };

/**
 * A reporting period. `to` defaults to now and is capped at now; `from`
 * defaults to `defaultDays` before `to`. The period may span at most
 * `maxDays` days.
 */
export function parsePeriod(
  record: Record<string, unknown>,
  now: Date,
  options: { defaultDays: number; maxDays: number }
): Period {
  let to = record.to === undefined || record.to === null ? now : parseInstant(record.to, "to", true);
  if (to.getTime() > now.getTime()) to = now;
  const from = record.from === undefined || record.from === null
    ? new Date(to.getTime() - options.defaultDays * DAY_MS)
    : parseInstant(record.from, "from");
  if (from.getTime() >= to.getTime()) throw new ApiValidationError("from must be before to (and before now)");
  if (to.getTime() - from.getTime() > options.maxDays * DAY_MS) {
    throw new ApiValidationError(`The period may span at most ${options.maxDays} days`);
  }
  return { from, to };
}

/** Thrown when the AI provider could not produce a draft; answered with 502 and its safe message. */
export class AiDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiDraftError";
  }
}

/** apiErrorResponse, plus 502 when the AI provider failed (the message is application-authored). */
export function complianceErrorResponse(error: unknown): NextResponse {
  if (error instanceof AiDraftError) return NextResponse.json({ error: error.message }, { status: 502 });
  return apiErrorResponse(error);
}
