import {
  queryWafCount,
  queryWafCountWithSearch,
  queryWafEventStatsWithSearch,
  queryTopWafRules,
  queryTopWafRulesWithHosts,
  queryWafCountries,
  queryWafRuleMessages,
  queryWafEvents,
  queryWafEventByTxId,
  queryWafPeriodSummary,
  queryWafDailyCounts,
  queryWafHostCounts,
  type WafEvent,
  type WafEventStats,
  type WafPeriodSummary,
  type TopWafRule,
  type TopWafRuleWithHosts,
} from "../clickhouse/client";

export type { WafEvent, WafEventStats, WafPeriodSummary, TopWafRule, TopWafRuleWithHosts };

const EMPTY_WAF_STATS: WafEventStats = {
  total: 0,
  blocked: 0,
  critical: 0,
  uniqueHosts: 0,
  ruleIdsTriggered: 0,
};

function isClickHouseConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "ECONNREFUSED" || code === "FailedToOpenSocket") return true;

  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  if (cause && cause !== error && isClickHouseConnectionError(cause)) return true;

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ECONNREFUSED") || message.includes("FailedToOpenSocket") || message.includes("Was there a typo in the url or port?");
}

async function withWafAnalyticsFallback<T>(operation: string, fallback: T, query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (isClickHouseConnectionError(error)) {
      console.warn(`[waf-events] ClickHouse unavailable during ${operation}; returning empty WAF analytics.`);
      return fallback;
    }
    throw error;
  }
}

export async function countWafEvents(search?: string, from?: number, to?: number): Promise<number> {
  return withWafAnalyticsFallback("countWafEvents", 0, () => queryWafCountWithSearch(search, from, to));
}

export async function getWafEventStats(search?: string, from?: number, to?: number): Promise<WafEventStats> {
  return withWafAnalyticsFallback("getWafEventStats", EMPTY_WAF_STATS, () => queryWafEventStatsWithSearch(search, from, to));
}

/** `hosts` limits the count to those hosts (as stored); empty means every host. */
export async function countWafEventsInRange(from: number, to: number, hosts: string[] = []): Promise<number> {
  return withWafAnalyticsFallback("countWafEventsInRange", 0, () => queryWafCount(from, to, hosts));
}

export async function getTopWafRules(from: number, to: number, limit = 10): Promise<TopWafRule[]> {
  return withWafAnalyticsFallback("getTopWafRules", [], () => queryTopWafRules(from, to, limit));
}

export async function getTopWafRulesWithHosts(from: number, to: number, limit = 10, hosts: string[] = []): Promise<TopWafRuleWithHosts[]> {
  return withWafAnalyticsFallback("getTopWafRulesWithHosts", [], () => queryTopWafRulesWithHosts(from, to, limit, hosts));
}

export async function getWafEventCountries(from: number, to: number, hosts: string[] = []): Promise<{ countryCode: string; count: number }[]> {
  return withWafAnalyticsFallback("getWafEventCountries", [], () => queryWafCountries(from, to, hosts));
}

export async function getWafRuleMessages(ruleIds: number[]): Promise<Record<number, string | null>> {
  return withWafAnalyticsFallback("getWafRuleMessages", {}, () => queryWafRuleMessages(ruleIds));
}

export async function listWafEvents(limit = 50, offset = 0, search?: string, from?: number, to?: number): Promise<WafEvent[]> {
  return withWafAnalyticsFallback("listWafEvents", [], () => queryWafEvents(limit, offset, search, from, to));
}

/** Coraza transaction ids are short random strings; anything else is no event id. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isWafEventId(value: string): boolean {
  return EVENT_ID_PATTERN.test(value);
}

/** The WAF event with this id (Coraza's transaction id), or null. */
export async function getWafEventByEventId(eventId: string): Promise<WafEvent | null> {
  if (!isWafEventId(eventId)) return null;
  return withWafAnalyticsFallback("getWafEventByEventId", null, () => queryWafEventByTxId(eventId));
}

export async function getWafPeriodSummary(from: number, to: number): Promise<WafPeriodSummary> {
  return withWafAnalyticsFallback(
    "getWafPeriodSummary",
    { total: 0, blocked: 0, uniqueClientIps: 0, rules: 0, hosts: 0 },
    () => queryWafPeriodSummary(from, to)
  );
}

export async function getWafDailyCounts(from: number, to: number): Promise<{ day: string; count: number; blocked: number }[]> {
  return withWafAnalyticsFallback("getWafDailyCounts", [], () => queryWafDailyCounts(from, to));
}

export async function getWafHostCounts(from: number, to: number): Promise<{ host: string; count: number; blocked: number }[]> {
  return withWafAnalyticsFallback("getWafHostCounts", [], () => queryWafHostCounts(from, to));
}
