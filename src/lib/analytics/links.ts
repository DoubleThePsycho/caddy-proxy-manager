/**
 * Links into the analytics and security events pages with a range and
 * filters, for the overview's "Needs attention" actions, its KPI tiles and
 * its chart:
 *
 *   /analytics?range=24h&filters=[{"dim":"host","op":"is","value":"mail.example.com"}]
 *   /security?range=custom&from=1790992800&to=1790994600&kind=waf&filters=[...]#events
 *
 * `range` is a preset (1h, 24h, 7d, 30d) or "custom" with `from` and `to`
 * in Unix seconds; `filters` is the URL-encoded JSON array the analytics
 * API takes ({dim, op: "is" | "is_not", value}); `kind` picks one source of
 * security events. Client-safe: types only from the server modules.
 */
import type { Dimension } from './dimensions';
import type { FilterOp } from './filters';
import type { Outcome } from './outcome';

export type AnalyticsLinkRange = '1h' | '24h' | '7d' | '30d';

export type AnalyticsLinkFilter = { dim: Dimension; op?: FilterOp; value: string | number };

/** The security events of one source: every mitigated outcome. */
export type SecurityEventKind = Exclude<Outcome, 'served'>;

type LinkRange = { range?: AnalyticsLinkRange } | { from: number; to: number };

function query(range: LinkRange, filters: readonly AnalyticsLinkFilter[], extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if ('from' in range) {
    params.set('range', 'custom');
    params.set('from', String(Math.floor(range.from)));
    params.set('to', String(Math.ceil(range.to)));
  } else {
    params.set('range', range.range ?? '24h');
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const kept = filters
    .filter((filter) => String(filter.value) !== '')
    .map((filter) => ({ dim: filter.dim, op: filter.op ?? 'is', value: String(filter.value) }));
  if (kept.length > 0) params.set('filters', JSON.stringify(kept));
  return params.toString();
}

/** The analytics page showing `filters` over `range` (the last 24 hours when not given). */
export function analyticsHref(filters: readonly AnalyticsLinkFilter[] = [], range: LinkRange | AnalyticsLinkRange = '24h'): string {
  return `/analytics?${query(typeof range === 'string' ? { range } : range, filters)}`;
}

/** The security events list, of one kind when given, with `filters` over `range`. */
export function securityHref(
  options: { range?: LinkRange | AnalyticsLinkRange; kind?: SecurityEventKind; filters?: readonly AnalyticsLinkFilter[] } = {}
): string {
  const range = options.range ?? '24h';
  const extra: Record<string, string> = options.kind ? { kind: options.kind } : {};
  return `/security?${query(typeof range === 'string' ? { range } : range, options.filters ?? [], extra)}#events`;
}
