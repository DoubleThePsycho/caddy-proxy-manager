// SPDX-License-Identifier: Elastic-2.0
/**
 * The facts an incident notification draft starts from, aggregated from
 * ClickHouse (when analytics is configured) and the dashboard's database:
 * counts, host names, request paths without query strings, WAF rule ids and
 * messages, countries, alert titles and change summaries. Never log lines,
 * client addresses or request contents.
 */
import { and, count, eq, gte, inArray, lte, notInArray } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { alertEvents, auditEvents, proxyHosts, users } from "@/src/lib/db/schema";
import { HOST_EXPR, PATH_EXPR, num, str, timeFilter, type QueryParams } from "@/ee/ai/clickhouse";
import { NON_CHANGE_AUDIT_ACTIONS } from "@/ee/ai/digest-data";
import { SIGN_IN_ACTIONS } from "./audit-areas";
import { auditActor, defaultAnalytics, parseStringArray, type AnalyticsDependencies } from "./reports/shared";
import type { IncidentFacts } from "./types";
import { asc, desc, first } from "@/src/lib/db/ops";

const TOP = 10;
const MAX_ALERTS = 20;
const MAX_CHANGES = 20;
const MAX_HOST_DOMAINS = 200;

export type FactsInput = {
  from: Date;
  to: Date;
  detectedAt: Date;
  proxyHostIds: number[];
  alertEventId: number | null;
};

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** A condition matching the request hosts of the given domains (exact or wildcard), with its parameters. */
export function hostCondition(domains: string[]): { sql: string; params: QueryParams } {
  if (domains.length === 0) return { sql: "", params: {} };
  const params: QueryParams = {};
  const exact: string[] = [];
  const wildcard: string[] = [];
  domains.slice(0, MAX_HOST_DOMAINS).forEach((domain, index) => {
    const lower = domain.toLowerCase();
    if (lower.startsWith("*.")) {
      params[`hw_${index}`] = lower.slice(1);
      wildcard.push(`endsWith(${HOST_EXPR}, {hw_${index}:String})`);
    } else {
      params[`he_${index}`] = lower;
      exact.push(`{he_${index}:String}`);
    }
  });
  const parts = [exact.length ? `${HOST_EXPR} IN (${exact.join(", ")})` : null, ...wildcard].filter(Boolean);
  return { sql: ` AND (${parts.join(" OR ")})`, params };
}

async function collectAnalytics(
  deps: AnalyticsDependencies,
  input: FactsInput,
  domains: string[],
  facts: IncidentFacts
): Promise<void> {
  const q = deps.query;
  const hosts = hostCondition(domains);
  const base = { p_from: seconds(input.from), p_to: seconds(input.to), ...hosts.params };
  const where = `${timeFilter()}${hosts.sql}`;
  const [trafficRows, wafRows, peakRows, ruleRows, hostRows, pathRows, countryRows] = await Promise.all([
    q<{ requests: string; clients: string; s2: string; s3: string; s4: string; s5: string; geo: string }>(
      `SELECT count() AS requests, uniq(client_ip) AS clients,
              countIf(status >= 200 AND status < 300) AS s2, countIf(status >= 300 AND status < 400) AS s3,
              countIf(status >= 400 AND status < 500) AS s4, countIf(status >= 500) AS s5, countIf(is_blocked) AS geo
       FROM traffic_events WHERE ${where}`,
      base
    ),
    q<{ events: string; blocked: string; detected: string; first_ts: string; last_ts: string }>(
      `SELECT count() AS events, countIf(blocked) AS blocked, countIf(NOT blocked) AS detected,
              toUInt32(min(ts)) AS first_ts, toUInt32(max(ts)) AS last_ts
       FROM waf_events WHERE ${where}`,
      base
    ),
    q<{ hour: string; events: string }>(
      `SELECT toUInt32(toStartOfHour(ts)) AS hour, count() AS events FROM waf_events WHERE ${where}
       GROUP BY hour ORDER BY events DESC, hour ASC LIMIT 1`,
      base
    ),
    q<{ rule_id: string | number; message: string | null; events: string }>(
      `SELECT rule_id, any(rule_message) AS message, count() AS events FROM waf_events
       WHERE ${where} AND rule_id IS NOT NULL GROUP BY rule_id ORDER BY events DESC LIMIT {p_limit:UInt32}`,
      { ...base, p_limit: TOP }
    ),
    q<{ h: string; events: string }>(
      `SELECT ${HOST_EXPR} AS h, count() AS events FROM waf_events WHERE ${where}
       GROUP BY h ORDER BY events DESC LIMIT {p_limit:UInt32}`,
      { ...base, p_limit: TOP }
    ),
    q<{ h: string; p: string; events: string }>(
      `SELECT ${HOST_EXPR} AS h, ${PATH_EXPR} AS p, count() AS events FROM waf_events WHERE ${where}
       GROUP BY h, p ORDER BY events DESC LIMIT {p_limit:UInt32}`,
      { ...base, p_limit: TOP }
    ),
    q<{ country: string; events: string }>(
      `SELECT ifNull(country_code, '') AS country, count() AS events FROM waf_events WHERE ${where}
       GROUP BY country HAVING country != '' ORDER BY events DESC LIMIT {p_limit:UInt32}`,
      { ...base, p_limit: TOP }
    ),
  ]);
  const traffic = trafficRows[0];
  facts.traffic = {
    requests: num(traffic?.requests),
    uniqueClients: num(traffic?.clients),
    statusClasses: { "2xx": num(traffic?.s2), "3xx": num(traffic?.s3), "4xx": num(traffic?.s4), "5xx": num(traffic?.s5) },
    geoBlocked: num(traffic?.geo),
  };
  const waf = wafRows[0];
  const events = num(waf?.events);
  const peak = peakRows[0];
  facts.waf = {
    events,
    blocked: num(waf?.blocked),
    detectedOnly: num(waf?.detected),
    firstEventAt: events > 0 && num(waf?.first_ts) > 0 ? new Date(num(waf?.first_ts) * 1000).toISOString() : null,
    lastEventAt: events > 0 && num(waf?.last_ts) > 0 ? new Date(num(waf?.last_ts) * 1000).toISOString() : null,
    peakHour: peak && num(peak.events) > 0 ? { at: new Date(num(peak.hour) * 1000).toISOString(), events: num(peak.events) } : null,
    topRules: ruleRows.map((row) => ({ ruleId: num(row.rule_id), message: row.message ? str(row.message) : null, events: num(row.events) })),
    topHosts: hostRows.map((row) => ({ host: str(row.h, 253), events: num(row.events) })).filter((row) => row.host),
    topPaths: pathRows.map((row) => ({ host: str(row.h, 253), path: str(row.p) || "/", events: num(row.events) })),
    topCountries: countryRows.map((row) => ({ country: str(row.country, 8), events: num(row.events) })).filter((row) => row.country),
  };
}

/** Collects the facts for an incident. Never throws for ClickHouse problems; they become notes. */
export async function collectIncidentFacts(input: FactsInput, deps: AnalyticsDependencies = defaultAnalytics): Promise<IncidentFacts> {
  const hosts = input.proxyHostIds.length
    ? (await appDb
        .select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains })
        .from(proxyHosts)
        .where(inArray(proxyHosts.id, input.proxyHostIds))
        .orderBy(asc(proxyHosts.name), asc(proxyHosts.id)))
        .map((host) => ({ id: host.id, name: str(host.name, 120), domains: parseStringArray(host.domains).map((domain) => str(domain, 253)) }))
    : [];
  const facts: IncidentFacts = {
    period: { from: input.from.toISOString(), to: input.to.toISOString() },
    becameAwareAt: input.detectedAt.toISOString(),
    scope: { allHosts: hosts.length === 0, proxyHosts: hosts },
    analytics: { status: "disabled", note: null },
    traffic: null,
    waf: null,
    sourceAlert: null,
    alerts: { total: 0, recent: [] },
    configChanges: { total: 0, recent: [] },
    notes: [],
  };

  if (!deps.analyticsEnabled()) {
    facts.analytics = { status: "disabled", note: "ClickHouse analytics is not configured, so traffic and WAF figures are not included." };
  } else {
    const domains = hosts.flatMap((host) => host.domains);
    try {
      await collectAnalytics(deps, input, domains, facts);
      facts.analytics = { status: "ok", note: null };
    } catch {
      facts.traffic = null;
      facts.waf = null;
      facts.analytics = { status: "error", note: "ClickHouse could not be queried, so traffic and WAF figures are not included." };
    }
    if (input.from.getTime() < Date.now() - 90 * 24 * 60 * 60 * 1000) {
      facts.notes.push("Analytics keeps 90 days by default; older parts of the period may have no traffic or WAF data.");
    }
  }

  if (input.alertEventId !== null) {
    const event = await first(appDb.select().from(alertEvents).where(eq(alertEvents.id, input.alertEventId)).limit(1));
    if (event) {
      facts.sourceAlert = {
        id: event.id,
        at: event.createdAt,
        ruleName: str(event.ruleName, 100),
        ruleType: str(event.ruleType, 40),
        severity: str(event.severity, 16),
        status: str(event.status, 16),
        title: str(event.title, 300),
        message: str(event.message, 1000),
      };
    } else {
      facts.notes.push(`Alert event #${input.alertEventId} no longer exists (alert history is kept for 90 days).`);
    }
  }

  const inPeriod = and(gte(alertEvents.createdAt, facts.period.from), lte(alertEvents.createdAt, facts.period.to));
  const [alertRows, alertTotal] = [
    await appDb
      .select({ id: alertEvents.id, at: alertEvents.createdAt, ruleType: alertEvents.ruleType, severity: alertEvents.severity, status: alertEvents.status, title: alertEvents.title })
      .from(alertEvents)
      .where(inPeriod)
      .orderBy(desc(alertEvents.createdAt), desc(alertEvents.id))
      .limit(MAX_ALERTS),
    (await first(appDb.select({ value: count() }).from(alertEvents).where(inPeriod).limit(1)))?.value ?? 0,
  ];
  facts.alerts = {
    total: alertTotal,
    recent: alertRows.map((row) => ({ id: row.id, at: row.at, ruleType: str(row.ruleType, 40), severity: str(row.severity, 16), status: str(row.status, 16), title: str(row.title, 300) })),
  };

  const changeWhere = and(
    gte(auditEvents.createdAt, facts.period.from),
    lte(auditEvents.createdAt, facts.period.to),
    notInArray(auditEvents.action, [...new Set([...NON_CHANGE_AUDIT_ACTIONS, ...SIGN_IN_ACTIONS])])
  );
  const changeRows = await appDb
    .select({
      createdAt: auditEvents.createdAt,
      summary: auditEvents.summary,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      userId: auditEvents.userId,
      userName: users.name,
      userEmail: users.email,
      username: users.username,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.userId))
    .where(changeWhere)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(MAX_CHANGES);
  facts.configChanges = {
    total: (await first(appDb.select({ value: count() }).from(auditEvents).where(changeWhere).limit(1)))?.value ?? 0,
    recent: changeRows.map((row) => ({
      at: row.createdAt,
      actor: str(auditActor(row), 200),
      summary: str(row.summary || `${row.action} ${row.entityType}`, 300),
    })),
  };
  return facts;
}

/** The facts the AI model sees: without who made each change. */
export function factsForModel(facts: IncidentFacts): Record<string, unknown> {
  return {
    ...facts,
    configChanges: { total: facts.configChanges.total, recent: facts.configChanges.recent.map(({ at, summary }) => ({ at, summary })) },
  };
}
