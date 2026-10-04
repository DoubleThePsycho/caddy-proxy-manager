/**
 * Analytics filters: `[{ dim, op: "is" | "is_not", value }]`. The dimension
 * comes from the allow-list in dimensions.ts and picks a constant SQL
 * expression; the value is validated for its dimension and bound as a query
 * parameter, never written into the SQL.
 *
 * Several "is" filters on one dimension match any of their values; "is_not"
 * filters exclude each value; filters on different dimensions all apply.
 */
import { ApiValidationError } from '../api-errors';
import { DIMENSION_SPECS, isDimension, type Dimension } from './dimensions';

export const FILTER_OPS = ['is', 'is_not'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export type AnalyticsFilter = { dim: Dimension; op: FilterOp; value: string };

export const MAX_FILTERS = 20;

/** A WHERE fragment and the parameters it binds. */
export type SqlFragment = { sql: string; params: Record<string, unknown> };

function parseOp(value: unknown): FilterOp {
  if (value === undefined || value === null || value === 'is') return 'is';
  if (value === 'is_not' || value === 'is not' || value === 'not') return 'is_not';
  throw new ApiValidationError('Filter op must be "is" or "is_not"');
}

/**
 * Validates filters given as an array or as its JSON text (a query string
 * parameter). Throws ApiValidationError for anything off the allow-list.
 */
export function parseFilters(input: unknown): AnalyticsFilter[] {
  if (input === undefined || input === null || input === '') return [];
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ApiValidationError('filters must be a JSON array');
    }
  }
  if (!Array.isArray(raw)) throw new ApiValidationError('filters must be an array');
  if (raw.length > MAX_FILTERS) throw new ApiValidationError(`At most ${MAX_FILTERS} filters`);
  const seen = new Set<string>();
  const filters: AnalyticsFilter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiValidationError('Each filter must be an object');
    const { dim, op, value } = item as Record<string, unknown>;
    if (!isDimension(dim)) throw new ApiValidationError(`Unknown filter dimension: ${String(dim).slice(0, 40)}`);
    if (typeof value !== 'string' && typeof value !== 'number') throw new ApiValidationError('Filter value must be a string');
    const text = String(value);
    if (text.length === 0) throw new ApiValidationError('Filter value must not be empty');
    const filter: AnalyticsFilter = { dim, op: parseOp(op), value: text };
    // Validates the value now, so a bad filter is a 400 before any query runs.
    DIMENSION_SPECS[dim].compare(text);
    const key = `${filter.dim}\u0000${filter.op}\u0000${filter.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filters.push(filter);
  }
  return filters;
}

/**
 * The WHERE fragment of `filters` (or "1" when there are none). Parameter
 * names are `${prefix}0`, `${prefix}1`, ...
 */
export function buildFilterSql(filters: readonly AnalyticsFilter[], prefix = 'f'): SqlFragment {
  const params: Record<string, unknown> = {};
  const include = new Map<Dimension, string[]>();
  const exclude: string[] = [];
  filters.forEach((filter, index) => {
    const name = `${prefix}${index}`;
    const { sql, type, value } = DIMENSION_SPECS[filter.dim].compare(filter.value);
    params[name] = value;
    if (filter.op === 'is') {
      const list = include.get(filter.dim) ?? [];
      list.push(`(${sql}) = {${name}:${type}}`);
      include.set(filter.dim, list);
    } else {
      exclude.push(`(${sql}) != {${name}:${type}}`);
    }
  });
  const clauses = [...[...include.values()].map((list) => `(${list.join(' OR ')})`), ...exclude];
  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1', params };
}
