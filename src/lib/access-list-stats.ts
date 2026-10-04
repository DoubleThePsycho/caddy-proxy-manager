/**
 * What access lists stopped in the last 24 hours, from ClickHouse
 * (traffic_events):
 *
 *  - per list, blocked requests on the hosts that use it: an event belongs to
 *    the host whose domain matches its Host header (exact domains first,
 *    then the longest wildcard);
 *  - per list with basic-auth members, 401 answers on its hosts (failed
 *    sign-ins);
 *  - for the global Blocked sources list, blocked requests from the addresses
 *    and countries it names, on any host (AS number and continent entries
 *    cannot be told apart in traffic_events and are not counted);
 *  - totals for the summary: stopped now and in the 24 hours before, the
 *    requests they are a share of, and where the stopped requests came from
 *    and went to.
 *
 * A blocked request is one whose outcome is "geo" or "access" when
 * traffic_events has the per-request outcome column, otherwise is_blocked
 * (caddy-blocker blocks and the lists' own denials, log-parser.ts). Counting
 * by host cannot tell a list's denial from global geo blocking on the same
 * host; the outcome column, when present, splits geo from access.
 *
 * Every value is a bound query parameter. Never throws: without ClickHouse,
 * or when a query fails, `available` is false and the numbers are zero.
 */
import { getClient, isAnalyticsEnabled } from "./clickhouse/client";
import { PRIVATE_RANGES_VALUE, parseIpRange } from "./access-list-rules";
import { PRIVATE_RANGES_CIDRS } from "./caddy-utils";

export const STATS_WINDOW_SECONDS = 24 * 60 * 60;
/** Bounds on what goes into one query. */
const MAX_DOMAINS = 500;
const MAX_SOURCE_RANGES = 500;
const TOP = 6;

/** Host name of an event: lowercase, without a port. */
const HOST_EXPR = "replaceRegexpOne(lower(host), ':[0-9]+$', '')";
/** The client address as IPv6 text (IPv4 mapped), or "::" when it does not parse. */
const CLIENT_V6_EXPR = "ifNull(IPv6NumToString(toIPv6OrNull(client_ip)), '::')";

export type StatsHostInput = { id: number; domains: readonly string[] };
export type StatsListInput = { id: number; basicAuth: boolean; hosts: readonly StatsHostInput[] };
export type StatsBlockedSourcesInput = { addresses: readonly string[]; countries: readonly string[] };

export type HostStats = { stopped: number; failedSignIns: number };
export type ListStats = { stopped: number; failedSignIns: number; hosts: Record<number, HostStats> };

export type AccessListStats = {
  available: boolean;
  windowSeconds: number;
  /** Stopped in the last 24 hours by the lists given (and Blocked sources). */
  stopped: number;
  /** The same, in the 24 hours before. */
  previous: number;
  /** Requests in the last 24 hours the share is of; null when not asked for. */
  requests: number | null;
  failedSignIns: number;
  /** Split by outcome when traffic_events has the outcome column; null otherwise. */
  byOutcome: { geo: number; access: number } | null;
  lists: Record<number, ListStats>;
  blockedSources: { stopped: number } | null;
  /** Where stopped requests came from (country codes; "" when unknown). */
  countries: Array<{ code: string; count: number }>;
  /** Where they went (host names). */
  hosts: Array<{ host: string; count: number }>;
};

type QueryFn = <T>(query: string, params: Record<string, unknown>) => Promise<T[]>;

export type StatsDependencies = {
  enabled: () => boolean;
  query: QueryFn;
};

const defaultDependencies: StatsDependencies = {
  enabled: isAnalyticsEnabled,
  query: async <T,>(query: string, params: Record<string, unknown>) => {
    const result = await getClient().query({ query, query_params: params, format: "JSONEachRow" });
    return result.json<T>();
  },
};

export function emptyAccessListStats(lists: readonly StatsListInput[], available = false): AccessListStats {
  return {
    available,
    windowSeconds: STATS_WINDOW_SECONDS,
    stopped: 0,
    previous: 0,
    requests: null,
    failedSignIns: 0,
    byOutcome: null,
    lists: Object.fromEntries(
      lists.map((list) => [
        list.id,
        {
          stopped: 0,
          failedSignIns: 0,
          hosts: Object.fromEntries(list.hosts.map((host) => [host.id, { stopped: 0, failedSignIns: 0 }])),
        },
      ])
    ),
    blockedSources: null,
    countries: [],
    hosts: [],
  };
}

type DomainOwner = { hostId: number; listId: number };

/** Which host (and list) an event's host name belongs to: an exact domain, else the longest matching wildcard. */
export function buildHostResolver(lists: readonly StatsListInput[]): (hostName: string) => DomainOwner | null {
  const exact = new Map<string, DomainOwner>();
  const wildcards: Array<{ suffix: string; owner: DomainOwner }> = [];
  for (const list of lists) {
    for (const host of list.hosts) {
      for (const raw of host.domains) {
        const domain = raw.trim().toLowerCase();
        if (!domain) continue;
        const owner = { hostId: host.id, listId: list.id };
        if (domain.startsWith("*.")) wildcards.push({ suffix: domain.slice(1), owner });
        else if (!exact.has(domain)) exact.set(domain, owner);
      }
    }
  }
  wildcards.sort((a, b) => b.suffix.length - a.suffix.length);
  return (hostName) => {
    const name = hostName.toLowerCase();
    const owner = exact.get(name);
    if (owner) return owner;
    return wildcards.find((wildcard) => name.endsWith(wildcard.suffix) && name.length > wildcard.suffix.length)?.owner ?? null;
  };
}

/** SQL condition matching events on the given domains (exact, or *.suffix), with its parameters. */
export function hostCondition(
  domains: readonly string[],
  prefix = "d"
): { sql: string; params: Record<string, unknown> } | null {
  const params: Record<string, unknown> = {};
  const exact: string[] = [];
  const wildcard: string[] = [];
  const unique = Array.from(new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))).slice(0, MAX_DOMAINS);
  unique.forEach((domain, index) => {
    if (domain.startsWith("*.")) {
      params[`${prefix}w${index}`] = domain.slice(1);
      wildcard.push(`endsWith(${HOST_EXPR}, {${prefix}w${index}:String})`);
    } else {
      params[`${prefix}e${index}`] = domain;
      exact.push(`{${prefix}e${index}:String}`);
    }
  });
  const parts = [exact.length > 0 ? `${HOST_EXPR} IN (${exact.join(", ")})` : null, ...wildcard].filter(Boolean);
  return parts.length > 0 ? { sql: `(${parts.join(" OR ")})`, params } : null;
}

/** An address or CIDR range as an IPv6 CIDR (IPv4 mapped into ::ffff:0:0/96), for isIPAddressInRange. */
export function toIpv6Cidr(value: string): string | null {
  const range = parseIpRange(value);
  if (!range) return null;
  if (range.version === 6) return range.text.includes("/") ? range.text : `${range.text}/128`;
  const [address] = range.text.split("/");
  return `::ffff:${address}/${96 + range.prefix}`;
}

/** SQL condition matching events from the Blocked sources addresses and countries, with its parameters. */
export function sourceCondition(sources: StatsBlockedSourcesInput): { sql: string; params: Record<string, unknown> } | null {
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  const ranges = Array.from(
    new Set(
      sources.addresses
        .flatMap((value) => (value === PRIVATE_RANGES_VALUE ? PRIVATE_RANGES_CIDRS : [value]))
        .map(toIpv6Cidr)
        .filter((value): value is string => value !== null)
    )
  ).slice(0, MAX_SOURCE_RANGES);
  ranges.forEach((range, index) => {
    params[`sr${index}`] = range;
    parts.push(`isIPAddressInRange(${CLIENT_V6_EXPR}, {sr${index}:String})`);
  });
  const countries = Array.from(new Set(sources.countries.filter((code) => /^[A-Z]{2}$/.test(code))));
  if (countries.length > 0) {
    const names = countries.map((code, index) => {
      params[`sc${index}`] = code;
      return `{sc${index}:String}`;
    });
    parts.push(`ifNull(country_code, '') IN (${names.join(", ")})`);
  }
  return parts.length > 0 ? { sql: `(${parts.join(" OR ")})`, params } : null;
}

const outcomeColumnCache: { checkedAt: number; present: boolean } = { checkedAt: 0, present: false };
const OUTCOME_CACHE_MS = 5 * 60_000;

async function hasOutcomeColumn(deps: StatsDependencies): Promise<boolean> {
  if (Date.now() - outcomeColumnCache.checkedAt < OUTCOME_CACHE_MS) return outcomeColumnCache.present;
  const rows = await deps.query<{ present: string | number }>(
    "SELECT count() AS present FROM system.columns WHERE database = currentDatabase() AND table = 'traffic_events' AND name = 'outcome'",
    {}
  );
  outcomeColumnCache.present = Number(rows[0]?.present ?? 0) > 0;
  outcomeColumnCache.checkedAt = Date.now();
  return outcomeColumnCache.present;
}

/** For tests: forget whether the outcome column was found. */
export function resetAccessListStatsCache(): void {
  outcomeColumnCache.checkedAt = 0;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The stats of `lists` (the hosts each is used by, as the caller may see
 * them), of the Blocked sources list when given, and, with `includeRequests`,
 * the request total the stopped share is of.
 */
export async function queryAccessListStats(
  input: {
    lists: readonly StatsListInput[];
    blockedSources: StatsBlockedSourcesInput | null;
    includeRequests: boolean;
    now?: Date;
  },
  deps: StatsDependencies = defaultDependencies
): Promise<AccessListStats> {
  const stats = emptyAccessListStats(input.lists);
  if (!deps.enabled()) return stats;
  try {
    const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const time = { p_from: now - 2 * STATS_WINDOW_SECONDS, p_mid: now - STATS_WINDOW_SECONDS, p_to: now };
    const outcome = await hasOutcomeColumn(deps);
    const blocked = outcome ? "outcome IN ('geo', 'access')" : "is_blocked";

    const allDomains = input.lists.flatMap((list) => list.hosts.flatMap((host) => [...host.domains]));
    const authDomains = input.lists.filter((list) => list.basicAuth).flatMap((list) => list.hosts.flatMap((host) => [...host.domains]));
    const hosts = hostCondition(allDomains, "h");
    const auth = hostCondition(authDomains, "a");
    const sources = input.blockedSources ? sourceCondition(input.blockedSources) : null;
    const scope = [hosts?.sql, sources?.sql].filter(Boolean).join(" OR ");
    const params = { ...time, ...(hosts?.params ?? {}), ...(auth?.params ?? {}), ...(sources?.params ?? {}) };
    const stoppedNow = scope ? `ts >= toDateTime({p_mid:UInt32}) AND ${blocked} AND (${scope})` : "0";
    const recent = "ts >= toDateTime({p_mid:UInt32})";

    const [summary] = await deps.query<Record<string, string | number>>(
      `SELECT
         ${input.includeRequests ? `countIf(${recent})` : "0"} AS requests,
         countIf(${stoppedNow}) AS stopped,
         ${scope ? `countIf(ts < toDateTime({p_mid:UInt32}) AND ${blocked} AND (${scope}))` : "0"} AS previous,
         ${auth ? `countIf(${recent} AND status = 401 AND ${auth.sql})` : "0"} AS failed_sign_ins,
         ${sources ? `countIf(${recent} AND ${blocked} AND ${sources.sql})` : "0"} AS blocked_sources,
         ${outcome && scope ? `countIf(${stoppedNow} AND outcome = 'geo')` : "0"} AS geo,
         ${outcome && scope ? `countIf(${stoppedNow} AND outcome = 'access')` : "0"} AS access
       FROM traffic_events
       WHERE ts >= toDateTime({p_from:UInt32}) AND ts <= toDateTime({p_to:UInt32})`,
      params
    );
    stats.available = true;
    stats.requests = input.includeRequests ? num(summary?.requests) : null;
    stats.stopped = num(summary?.stopped);
    stats.previous = num(summary?.previous);
    stats.failedSignIns = num(summary?.failed_sign_ins);
    stats.blockedSources = input.blockedSources ? { stopped: num(summary?.blocked_sources) } : null;
    stats.byOutcome = outcome ? { geo: num(summary?.geo), access: num(summary?.access) } : null;

    if (hosts) {
      const resolve = buildHostResolver(input.lists);
      const rows = await deps.query<{ h: string; stopped: string | number; unauthorized: string | number }>(
        `SELECT ${HOST_EXPR} AS h, countIf(${blocked}) AS stopped, countIf(status = 401) AS unauthorized
         FROM traffic_events
         WHERE ts >= toDateTime({p_mid:UInt32}) AND ts <= toDateTime({p_to:UInt32}) AND ${hosts.sql}
         GROUP BY h`,
        { ...time, ...hosts.params }
      );
      const basicAuth = new Set(input.lists.filter((list) => list.basicAuth).map((list) => list.id));
      for (const row of rows) {
        const owner = resolve(String(row.h));
        if (!owner) continue;
        const list = stats.lists[owner.listId];
        const host = list?.hosts[owner.hostId];
        if (!list || !host) continue;
        const stopped = num(row.stopped);
        const failed = basicAuth.has(owner.listId) ? num(row.unauthorized) : 0;
        host.stopped += stopped;
        host.failedSignIns += failed;
        list.stopped += stopped;
        list.failedSignIns += failed;
      }
    }

    if (scope) {
      const [countries, topHosts] = await Promise.all([
        deps.query<{ code: string; count: string | number }>(
          `SELECT ifNull(country_code, '') AS code, count() AS count
           FROM traffic_events
           WHERE ts <= toDateTime({p_to:UInt32}) AND ${stoppedNow}
           GROUP BY code ORDER BY count DESC LIMIT {p_top:UInt32}`,
          { ...params, p_top: TOP }
        ),
        deps.query<{ host: string; count: string | number }>(
          `SELECT ${HOST_EXPR} AS host, count() AS count
           FROM traffic_events
           WHERE ts <= toDateTime({p_to:UInt32}) AND ${stoppedNow}
           GROUP BY host ORDER BY count DESC LIMIT {p_top:UInt32}`,
          { ...params, p_top: TOP }
        ),
      ]);
      stats.countries = countries.map((row) => ({ code: String(row.code ?? "").slice(0, 8), count: num(row.count) }));
      stats.hosts = topHosts.map((row) => ({ host: String(row.host ?? "").slice(0, 253), count: num(row.count) }));
    }
    return stats;
  } catch (error) {
    console.warn("[access-lists] Could not read what access lists stopped:", error instanceof Error ? error.name : typeof error);
    return emptyAccessListStats(input.lists);
  }
}
