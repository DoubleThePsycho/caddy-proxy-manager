/**
 * Row ids from requests: path and query parameters, form fields, JSON
 * bodies. Every id column is a 32-bit integer on PostgreSQL, which refuses a
 * parameter that is not one (NaN, 1.5, 2^31) with an error where SQLite just
 * finds no row, so input that cannot be an id is turned away before it
 * reaches a query, the same way on both databases.
 */
import { ApiClientError } from "./api-errors";

/** The largest id a row can have (a PostgreSQL integer). */
export const MAX_ROW_ID = 2_147_483_647;

/** Whether `value` can be a row id: an integer from 1 to MAX_ROW_ID. */
export function isRowId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ROW_ID;
}

/**
 * `raw` as a row id: a number isRowId accepts, or decimal digits only (no
 * sign, space, fraction or exponent) for one; null for anything else.
 */
export function parseRowId(raw: unknown): number | null {
  if (typeof raw === "number") return isRowId(raw) ? raw : null;
  if (typeof raw !== "string" || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return isRowId(id) ? id : null;
}

/**
 * The row id in a route's path parameter. Text that cannot be one names no
 * row: a 404 with `notFound`, the answer the route gives for an id it does
 * not find.
 */
export function routeRowId(raw: string, notFound = "Resource not found"): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(notFound, 404);
  return id;
}
