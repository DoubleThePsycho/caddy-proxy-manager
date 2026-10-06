/**
 * Analytics data layer (server only). Pages call these after their
 * permission check (analytics:read); the REST API under
 * app/api/v1/analytics does the same. Client components import types only.
 *
 * - query.ts: one metric over a range, grouped, with the previous period and headline numbers
 * - top.ts: top values of each dimension
 * - requests.ts: the request log
 * - hosts.ts / service.ts: per-proxy-host summaries
 * - security.ts: security events
 * - signals.ts: the overview's "Needs attention"
 * - ../models/analytics-views.ts: saved views
 *
 * dimensions.ts and filters.ts hold the allow-lists; outcome.ts how a
 * request's outcome is derived; documentation/analytics.md describes it all.
 */
export { parseAnalyticsQuery, queryAnalytics, OUTCOME_LABELS, dimensionLabels } from './query';
export type { AnalyticsQuery, AnalyticsQueryResult, Headline, Series } from './query';
export { queryTopDimensions, parseDimensions, parseTopLimit } from './top';
export type { TopDimension, TopResult, TopRow } from './top';
export { queryRequestLog, parsePaging } from './requests';
export type { RequestLogEntry, RequestLogResult } from './requests';
export { queryHostSummaries, queryHostDetail } from './hosts';
export type { HostDetailResult, HostSummariesResult, HostSummary } from './hosts';
export {
  querySecurityEvents,
  querySecurityHosts,
  querySecurityRules,
  querySecuritySeries,
  querySecuritySources,
  parseEventKinds,
  parseSecurityEventFilters,
} from './security';
export type {
  SecurityEvent,
  SecurityEventKind,
  SecurityEventsResult,
  SecurityHost,
  SecurityHostsResult,
  SecurityPeak,
  SecurityPeakTop,
  SecurityRule,
  SecurityRulesResult,
  SecuritySeriesResult,
  SecuritySource,
  SecuritySourcesResult,
} from './security';
export { getTrafficSignals } from './signals';
export type { BlockedConcentration, ErrorBurst, MitigationSpike, TrafficSignals } from './signals';
export { hostDetailFor, hostSummariesFor, trafficSignalsFor, visibleProxyHostDomains } from './service';
export { parseFilters } from './filters';
export type { AnalyticsFilter, FilterOp } from './filters';
export { resolveRange, previousPeriod, RANGE_PRESETS } from './range';
export type { RangePreset, ResolvedRange } from './range';
export { DIMENSIONS, METRICS, GROUPINGS } from './dimensions';
export type { Dimension, Grouping, Metric } from './dimensions';
export { OUTCOMES, MITIGATED_OUTCOMES } from './outcome';
export type { Outcome } from './outcome';
export type { AnalyticsStatus } from './run';
