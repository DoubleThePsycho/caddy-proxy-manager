/**
 * Top values of each dimension for a query's range and filters: each row's
 * request count, its share of all matching requests and the share of its
 * requests that were mitigated.
 */
import { ApiValidationError } from '../api-errors';
import { getWafRuleMessages } from '../models/waf-events';
import { DIMENSIONS, DIMENSION_SPECS, MITIGATED_SQL, type Dimension } from './dimensions';
import { buildFilterSql, type AnalyticsFilter } from './filters';
import type { ResolvedRange } from './range';
import { num, ratio, selectRows, withAnalytics, type AnalyticsStatus, type QueryParams } from './run';
import { scopeSql, type HostScope } from './scope';

export const DEFAULT_TOP_LIMIT = 6;
export const MAX_TOP_LIMIT = 100;

export type TopRow = {
  value: string;
  count: number;
  /** Share of all requests matching the filters. */
  share: number;
  mitigated: number;
  /** Share of this row's requests that were mitigated. */
  mitigatedShare: number;
  /** ASN rows: the network's organisation. WAF rule rows: the rule's message. */
  label?: string | null;
  /** Source IP rows: where the address is. */
  country?: string;
  asn?: number;
  asOrg?: string;
};

export type TopDimension = {
  dimension: Dimension;
  label: string;
  rows: TopRow[];
  /** Number of distinct values (approximate for large sets). */
  distinct: number;
  /** Status rows only: requests per status class. */
  classes?: { class: string; count: number; share: number }[];
};

export type TopResult = {
  status: AnalyticsStatus;
  total: number;
  dimensions: TopDimension[];
};

export function parseTopLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_TOP_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TOP_LIMIT) throw new ApiValidationError(`limit must be between 1 and ${MAX_TOP_LIMIT}`);
  return n;
}

/** A dimension list from a comma-separated parameter; every dimension when empty. */
export function parseDimensions(value: unknown): Dimension[] {
  if (value === undefined || value === null || value === '') return [...DIMENSIONS];
  const list = (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);
  for (const dim of list) {
    if (!(DIMENSIONS as readonly string[]).includes(dim)) throw new ApiValidationError(`Unknown dimension: ${dim.slice(0, 40)}`);
  }
  return [...new Set(list)] as Dimension[];
}

/** Top `limit` values of each of `dimensions`, for the hosts in `scope`. */
export async function queryTopDimensions(
  input: { range: ResolvedRange; filters: AnalyticsFilter[]; dimensions: Dimension[]; limit: number },
  scope: HostScope = null
): Promise<TopResult> {
  const empty: Omit<TopResult, 'status'> = {
    total: 0,
    dimensions: input.dimensions.map((dimension) => ({ dimension, label: DIMENSION_SPECS[dimension].label, rows: [], distinct: 0 })),
  };
  return withAnalytics('top dimensions', empty, async () => {
    const scoped = scopeSql(scope);
    const filtered = buildFilterSql(input.filters);
    const params: QueryParams = {
      ...scoped.params,
      ...filtered.params,
      p_from: input.range.start,
      p_to: input.range.end,
      p_limit: input.limit,
    };
    const where = `ts >= toDateTime({p_from:UInt32}) AND ts < toDateTime({p_to:UInt32}) AND ${scoped.sql} AND ${filtered.sql}`;

    const distinctColumns = input.dimensions.map((dim, i) => `uniq(${DIMENSION_SPECS[dim].groupSql}) AS d${i}`).join(', ');
    const [totals] = await selectRows<Record<string, unknown>>(
      `SELECT count() AS total${distinctColumns ? `, ${distinctColumns}` : ''} FROM traffic_events WHERE ${where}`,
      params
    );
    const total = num(totals?.total);

    const dimensions = await Promise.all(
      input.dimensions.map(async (dimension, i): Promise<TopDimension> => {
        const spec = DIMENSION_SPECS[dimension];
        const extra =
          dimension === 'ip'
            ? ", any(coalesce(country_code, '')) AS ip_country, any(asn) AS ip_asn, any(as_org) AS ip_as_org"
            : dimension === 'asn'
              ? ', any(as_org) AS asn_org'
              : '';
        // A rule id of 0 means "not blocked by the WAF"; it is not a rule.
        const only = dimension === 'waf_rule' ? ' AND waf_rule_id != 0' : '';
        const rows = await selectRows<Record<string, unknown>>(
          `SELECT ${spec.groupSql} AS value, count() AS c, countIf(${MITIGATED_SQL}) AS m${extra}
           FROM traffic_events WHERE ${where}${only}
           GROUP BY value ORDER BY c DESC, value LIMIT {p_limit:UInt32}`,
          params
        );
        const out: TopDimension = {
          dimension,
          label: spec.label,
          distinct: num(totals?.[`d${i}`]),
          rows: rows.map((row) => {
            const count = num(row.c);
            const mitigated = num(row.m);
            const base: TopRow = {
              value: String(row.value ?? ''),
              count,
              share: ratio(count, total),
              mitigated,
              mitigatedShare: ratio(mitigated, count),
            };
            if (dimension === 'ip') {
              base.country = String(row.ip_country ?? '');
              base.asn = num(row.ip_asn);
              base.asOrg = String(row.ip_as_org ?? '');
            }
            if (dimension === 'asn') base.label = String(row.asn_org ?? '') || null;
            return base;
          }),
        };
        if (dimension === 'waf_rule' && out.rows.length > 0) {
          const messages = await getWafRuleMessages(out.rows.map((row) => Number(row.value)).filter((id) => Number.isInteger(id) && id > 0));
          for (const row of out.rows) row.label = messages[Number(row.value)] ?? null;
        }
        if (dimension === 'status') {
          const classes = await selectRows<{ c: unknown; n: unknown }>(
            `SELECT intDiv(status, 100) AS c, count() AS n FROM traffic_events WHERE ${where} GROUP BY c ORDER BY c`,
            params
          );
          out.classes = classes.map((row) => ({
            class: num(row.c) >= 1 && num(row.c) <= 5 ? `${num(row.c)}xx` : 'other',
            count: num(row.n),
            share: ratio(num(row.n), total),
          }));
        }
        return out;
      })
    );
    return { total, dimensions };
  });
}
