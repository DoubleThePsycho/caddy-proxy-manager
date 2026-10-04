// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: usage reports, for billing. Per organisation and period:
 * proxy hosts and users (now, from the database), and requests, bytes served
 * and WAF blocks in the period (from ClickHouse, over the organisation's host
 * names, see analytics.ts). Provider-level readers get every organisation and
 * the provider level's own row; an organisation's users only their own
 * organisation. Reading never needs a license.
 *
 * Traffic counts are only as complete as ClickHouse: nothing before its
 * retention, and nothing when analytics are off (analyticsAvailable false).
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { proxyHosts, users } from "@/src/lib/db/schema";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { isAnalyticsEnabled, queryUsageTotals } from "@/src/lib/clickhouse/client";
import { tenantOf, type Access } from "@/src/lib/permissions";
import { listOrganizationRows, readOrganization } from "./store";
import { organizationHosts, seenHosts } from "./analytics";
import type { OrganizationFilter } from "./scope";
import { first } from "@/src/lib/db/ops";

export type UsagePeriod = { from: string; to: string };

export type UsageRow = {
  /** null: the provider level's own hosts and users. */
  organizationId: number | null;
  organizationName: string;
  organizationSlug: string | null;
  enabled: boolean;
  from: string;
  to: string;
  proxyHosts: number;
  enabledProxyHosts: number;
  users: number;
  requests: number;
  bytes: number;
  wafBlocks: number;
};

export type UsageReport = {
  period: UsagePeriod;
  analyticsAvailable: boolean;
  rows: UsageRow[];
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PERIOD_DAYS = 400;

function parseInstant(value: string, label: string, endOfDay: boolean): Date {
  const trimmed = value.trim();
  if (trimmed.length > 40) throw new ApiValidationError(`${label} must be an ISO 8601 date or date-time`);
  const isDate = DATE_ONLY.test(trimmed);
  const ms = Date.parse(isDate ? `${trimmed}T00:00:00.000Z` : trimmed);
  if (Number.isNaN(ms) || !(isDate || /^\d{4}-\d{2}-\d{2}T/.test(trimmed))) {
    throw new ApiValidationError(`${label} must be an ISO 8601 date or date-time`);
  }
  return new Date(isDate && endOfDay ? ms + DAY_MS - 1000 : ms);
}

/**
 * The period of a report: ?month=YYYY-MM, or ?from= and ?to= (dates or
 * date-times, a bare `to` date includes that day), defaulting to the current
 * calendar month (UTC) up to now.
 */
export function parseUsagePeriod(params: URLSearchParams, now: Date = new Date()): UsagePeriod {
  const month = params.get("month");
  if (month) {
    if (!MONTH.test(month.trim())) throw new ApiValidationError("month must be YYYY-MM");
    const [year, monthNumber] = month.trim().split("-").map(Number);
    const from = new Date(Date.UTC(year, monthNumber - 1, 1));
    const to = new Date(Math.min(Date.UTC(year, monthNumber, 1) - 1000, now.getTime()));
    if (to < from) throw new ApiValidationError("month must not be in the future");
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  const from = fromRaw ? parseInstant(fromRaw, "from", false) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = toRaw ? parseInstant(toRaw, "to", true) : now;
  if (from > to) throw new ApiValidationError("from must not be after to");
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new ApiValidationError(`A usage period can be at most ${MAX_PERIOD_DAYS} days`);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

async function countHosts(organizationId: number | null): Promise<{ total: number; enabled: number }> {
  const owner = organizationId === null ? isNull(proxyHosts.organizationId) : eq(proxyHosts.organizationId, organizationId);
  const total = (await first(appDb.select({ value: count() }).from(proxyHosts).where(owner).limit(1)))?.value ?? 0;
  const enabled = (await first(appDb.select({ value: count() }).from(proxyHosts).where(and(owner, eq(proxyHosts.enabled, true))).limit(1)))?.value ?? 0;
  return { total, enabled };
}

async function countUsers(organizationId: number | null): Promise<number> {
  const owner = organizationId === null ? isNull(users.organizationId) : eq(users.organizationId, organizationId);
  return (await first(appDb.select({ value: count() }).from(users).where(owner).limit(1)))?.value ?? 0;
}

/**
 * The usage report `access` may read. `organizationId` narrows a
 * provider-level report to one organisation (null: the provider level's row);
 * an organisation user always gets their own organisation, and naming another
 * one answers 404.
 */
export async function buildUsageReport(
  access: Access,
  period: UsagePeriod,
  organizationId: OrganizationFilter = undefined
): Promise<UsageReport> {
  const tenant = tenantOf(access);
  if (tenant !== null && organizationId !== undefined && organizationId !== tenant) {
    throw new ApiClientError("Organisation not found", 404);
  }
  const wanted: OrganizationFilter = tenant ?? organizationId;
  const organizations = await listOrganizationRows(appDb);
  if (typeof wanted === "number" && !await readOrganization(appDb, wanted)) throw new ApiClientError("Organisation not found", 404);

  const targets: { id: number | null; name: string; slug: string | null; enabled: boolean }[] = [];
  if (wanted === undefined || wanted === null) targets.push({ id: null, name: "Provider", slug: null, enabled: true });
  for (const organization of organizations) {
    if (wanted === undefined || wanted === organization.id) {
      targets.push({ id: organization.id, name: organization.name, slug: organization.slug, enabled: organization.enabled });
    }
  }

  const analyticsAvailable = isAnalyticsEnabled();
  const seen = analyticsAvailable ? await seenHosts() : [];
  const from = Math.floor(Date.parse(period.from) / 1000);
  const to = Math.floor(Date.parse(period.to) / 1000);
  const rows: UsageRow[] = [];
  for (const target of targets) {
    const hosts = await countHosts(target.id);
    const totals = analyticsAvailable
      ? await queryUsageTotals(from, to, await organizationHosts(target.id, seen)).catch(() => ({ requests: 0, bytes: 0, wafBlocks: 0 }))
      : { requests: 0, bytes: 0, wafBlocks: 0 };
    rows.push({
      organizationId: target.id,
      organizationName: target.name,
      organizationSlug: target.slug,
      enabled: target.enabled,
      from: period.from,
      to: period.to,
      proxyHosts: hosts.total,
      enabledProxyHosts: hosts.enabled,
      users: await countUsers(target.id),
      ...totals,
    });
  }
  return { period, analyticsAvailable, rows };
}

const CSV_COLUMNS = [
  "organizationId",
  "organizationSlug",
  "organizationName",
  "from",
  "to",
  "proxyHosts",
  "enabledProxyHosts",
  "users",
  "requests",
  "bytes",
  "wafBlocks",
] as const satisfies readonly (keyof UsageRow)[];

/** One CSV field; text a spreadsheet would run as a formula gets a leading apostrophe. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The report as CSV, one row per organisation (and the provider level). */
export function usageReportCsv(report: UsageReport): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of report.rows) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column] as string | number | null)).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
