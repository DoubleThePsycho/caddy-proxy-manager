/**
 * Reading analytics query parameters from a request's query string, for the
 * /api/v1/analytics routes. Validation happens in the parsers they feed.
 */
import { ApiValidationError } from '../api-errors';
import { parseRowId } from "../row-ids";

/** The query-string fields the analytics parsers read, as given. */
export function analyticsParams(params: URLSearchParams) {
  const get = (name: string) => params.get(name) ?? undefined;
  return {
    range: get('range'),
    from: get('from'),
    to: get('to'),
    filters: get('filters'),
    metric: get('metric'),
    groupBy: get('groupBy'),
    topHosts: get('topHosts'),
    limit: get('limit'),
    offset: get('offset'),
    dimensions: get('dimensions'),
    kind: get('kind'),
    ids: get('ids'),
  };
}

/** A comma-separated list of positive integer ids, at most `max` of them. */
export function parseIdList(value: string | undefined, name: string, max = 500): number[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const ids = value.split(',').map((part) => part.trim()).filter(Boolean).map(Number);
  if (ids.length > max || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ApiValidationError(`${name} must be a comma-separated list of at most ${max} ids`);
  }
  return [...new Set(ids)];
}

/** A route's numeric `[id]` segment. */
export function parseRouteId(value: string, what: string): number {
  const id = parseRowId(value);
  if (id === null) throw new ApiValidationError(`${what} id must be a positive integer`);
  return id;
}
