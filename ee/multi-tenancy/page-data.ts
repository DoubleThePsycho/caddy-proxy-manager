// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: what the Organisations page shows, read on the server.
 *
 * The list: every organisation with its counts against its limits, its
 * allowed upstreams, its requests in the billing month (the last full
 * calendar month, UTC) and since when it is disabled. The opened
 * organisation: its usage, its hosts with their protections, and its
 * members with their last sign-in.
 *
 * What the viewer may see follows their permissions, never only the page
 * guard (organizations:read): usage needs usage_reports:read, and the host
 * list needs proxy_hosts:read (narrowed to the role's tag scope). Hosts and
 * members are reduced to display fields here, so no host configuration,
 * password hash or token leaves the server.
 */
import { and, count, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { accessLists, apiTokens, auditEvents, customRoles, proxyHosts, sessions, twoFactors, users } from "@/src/lib/db/schema";
import { listProxyHosts, type ProxyHost } from "@/src/lib/models/proxy-hosts";
import { can, ORGANIZATION_ADMIN_ROLE, scopeTagsFor, type Access } from "@/src/lib/permissions";
import { isAnalyticsEnabled, queryUsageTotals } from "@/src/lib/clickhouse/client";
import type { ProtectionKind } from "@/components/ui/ProtectionPill";
import { listMembers, listOrganizations, type OrganizationView } from "./service";
import { buildUsageReport, parseUsagePeriod, type UsageRow } from "./usage";
import { hostMatchesDomains, seenHosts, storedHostName } from "./analytics";
import { first as dbFirst, likeText } from "@/src/lib/db/ops";

/** Hosts listed for the opened organisation; the rest are in Proxy hosts. */
export const ORGANIZATION_PAGE_HOST_LIMIT = 50;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type UsageMonth = {
  /** YYYY-MM, for the usage report and its CSV. */
  month: string;
  /** "September". */
  label: string;
};

export type OrganizationListItem = OrganizationView & {
  /** Requests in the billing month; null when the viewer may not read usage. */
  requests: number | null;
  /** When it was last disabled (from the audit log), for a disabled organisation. */
  disabledSince: string | null;
};

export type OrganizationHostItem = {
  id: number;
  name: string;
  /** The first domain, and how many more the host serves. */
  domain: string;
  moreDomains: number;
  upstream: string | null;
  moreUpstreams: number;
  enabled: boolean;
  protections: { kind: ProtectionKind; label: string }[];
  /** Requests in the billing month; null without analytics or the usage permission. */
  requests: number | null;
};

export type OrganizationMemberItem = {
  id: number;
  email: string;
  name: string | null;
  /** "org_admin", "user", "viewer" or "custom". */
  roleKind: "org_admin" | "user" | "viewer" | "custom";
  roleLabel: string;
  status: string;
  lastSignInAt: string | null;
  mfa: boolean;
  apiTokens: number;
  tokenLastUsedAt: string | null;
};

export type OrganizationUsage = Pick<UsageRow, "requests" | "bytes" | "wafBlocks" | "proxyHosts" | "enabledProxyHosts">;

export type OrganizationDetail = {
  id: number;
  /** The billing month's usage; null when the viewer may not read usage. */
  usage: OrganizationUsage | null;
  /** Requests in the current month so far; null when the viewer may not read usage. */
  currentRequests: number | null;
  /** null when the viewer may not read proxy hosts. */
  hosts: OrganizationHostItem[] | null;
  /** Hosts of the organisation the viewer may read (the list stops at ORGANIZATION_PAGE_HOST_LIMIT). */
  hostsTotal: number;
  members: OrganizationMemberItem[];
};

export type OrganizationsPageData = {
  organizations: OrganizationListItem[];
  /** Hosts and users that belong to no organisation. */
  provider: { proxyHosts: number; users: number };
  /** The last full month (billing) and the current one; null without usage_reports:read. */
  usage: { billing: UsageMonth; current: UsageMonth; analyticsAvailable: boolean } | null;
  selected: OrganizationDetail | null;
};

function monthOf(date: Date): UsageMonth {
  return {
    month: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
    label: MONTH_NAMES[date.getUTCMonth()],
  };
}

/** The billing month (the last full calendar month, UTC) and the current one. */
export function usageMonths(now: Date = new Date()): { billing: UsageMonth; current: UsageMonth } {
  return {
    billing: monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
    current: monthOf(now),
  };
}

async function providerCounts(): Promise<{ proxyHosts: number; users: number }> {
  return {
    proxyHosts: (await dbFirst(appDb.select({ value: count() }).from(proxyHosts).where(isNull(proxyHosts.organizationId)).limit(1)))?.value ?? 0,
    users: (await dbFirst(appDb.select({ value: count() }).from(users).where(isNull(users.organizationId)).limit(1)))?.value ?? 0,
  };
}

/** When each disabled organisation was last disabled, from its audit events. */
async function disabledSince(ids: readonly number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (ids.length === 0) return result;
  const rows = await appDb
    .select({ id: auditEvents.entityId, at: max(auditEvents.createdAt) })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, "organization"),
        inArray(auditEvents.entityId, [...ids]),
        likeText(auditEvents.summary, "Disabled organisation %")
      )
    )
    .groupBy(auditEvents.entityId);
  for (const row of rows) {
    if (row.id !== null && row.at) result.set(row.id, row.at);
  }
  return result;
}

function wafLabel(host: ProxyHost): string | null {
  if (!host.waf?.enabled) return null;
  const mode = host.waf.mode as string | undefined;
  if (mode === "On") return "WAF · Block";
  if (mode === "DetectionOnly") return "WAF · Detect";
  if (mode === "Off") return "WAF · Off";
  return "WAF";
}

/** The protections a host carries, as the pills of the host list show them. */
export function hostProtections(host: ProxyHost, accessListNames: ReadonlyMap<number, string>): { kind: ProtectionKind; label: string }[] {
  const pills: { kind: ProtectionKind; label: string }[] = [];
  const waf = wafLabel(host);
  if (waf) pills.push({ kind: "waf", label: waf });
  if (host.ingressiForwardAuth?.enabled) pills.push({ kind: "sso", label: "SSO" });
  if (host.forwardAuth?.enabled || host.authentik?.enabled) pills.push({ kind: "forward-auth", label: "Forward auth" });
  if (host.accessListId !== null) {
    const name = accessListNames.get(host.accessListId);
    pills.push({ kind: "access-list", label: name ? `Access list · ${name}` : "Access list" });
  }
  if (host.geoblock?.enabled) pills.push({ kind: "geo", label: "Geo blocking" });
  if (host.mtls?.enabled) pills.push({ kind: "mtls", label: "mTLS" });
  if (host.rateLimit?.enabled) pills.push({ kind: "rate-limit", label: "Rate limit" });
  return pills;
}

/** A display form of an upstream: "10.40.1.10:8080" stays as written, a URL loses nothing either. */
function upstreamOf(host: ProxyHost): string | null {
  const first = host.upstreams[0];
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

async function hostRequests(
  hosts: readonly ProxyHost[],
  period: { from: string; to: string }
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (!isAnalyticsEnabled() || hosts.length === 0) return result;
  const seen = await seenHosts();
  const from = Math.floor(Date.parse(period.from) / 1000);
  const to = Math.floor(Date.parse(period.to) / 1000);
  await Promise.all(
    hosts.map(async (host) => {
      const domains = host.domains.map((domain) => storedHostName(domain)).filter(Boolean);
      const stored = new Set(domains.filter((domain) => !domain.startsWith("*.")));
      for (const name of seen) if (hostMatchesDomains(name, domains)) stored.add(name);
      if (stored.size === 0) return;
      try {
        result.set(host.id, (await queryUsageTotals(from, to, [...stored])).requests);
      } catch {
        // Analytics unreachable: the host shows no count.
      }
    })
  );
  return result;
}

async function latestSignIns(userIds: readonly number[]): Promise<Map<number, string>> {
  const latest = new Map<number, string>();
  if (userIds.length === 0) return latest;
  const keep = (userId: number | null, at: string | null) => {
    if (userId === null || !at) return;
    const current = latest.get(userId);
    if (!current || at > current) latest.set(userId, at);
  };
  for (const row of await appDb
    .select({ userId: auditEvents.userId, at: max(auditEvents.createdAt) })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "login_success"), isNotNull(auditEvents.userId), inArray(auditEvents.userId, [...userIds])))
    .groupBy(auditEvents.userId)) {
    keep(row.userId, row.at);
  }
  for (const row of await appDb
    .select({ userId: sessions.userId, at: max(sessions.createdAt) })
    .from(sessions)
    .where(inArray(sessions.userId, [...userIds]))
    .groupBy(sessions.userId)) {
    keep(row.userId, row.at);
  }
  return latest;
}

function roleOf(role: string, customRoleId: number | null, roleNames: ReadonlyMap<number, string>): Pick<OrganizationMemberItem, "roleKind" | "roleLabel"> {
  if (customRoleId !== null) return { roleKind: "custom", roleLabel: roleNames.get(customRoleId) ?? "Custom role" };
  if (role === ORGANIZATION_ADMIN_ROLE) return { roleKind: "org_admin", roleLabel: "Organisation admin" };
  if (role === "user") return { roleKind: "user", roleLabel: "User" };
  return { roleKind: "viewer", roleLabel: "Viewer" };
}

async function organizationMembers(organizationId: number): Promise<OrganizationMemberItem[]> {
  const members = await listMembers(organizationId);
  const ids = members.map((member) => member.id);
  const signIns = await latestSignIns(ids);
  // MFA counts as on with a verified second factor, as src/lib/mfa.ts reads it.
  const mfa = new Map(
    ids.length === 0
      ? []
      : (await appDb
          .select({ id: users.id, flag: users.twoFactorEnabled, verified: twoFactors.verified })
          .from(users)
          .leftJoin(twoFactors, eq(twoFactors.userId, users.id))
          .where(inArray(users.id, ids)))
          .map((row) => [row.id, Boolean(row.flag) && row.verified === true])
  );
  const roleIds = [...new Set(members.map((member) => member.customRoleId).filter((id): id is number => id !== null))];
  const roleNames = new Map(
    roleIds.length === 0
      ? []
      : (await appDb.select({ id: customRoles.id, name: customRoles.name }).from(customRoles).where(inArray(customRoles.id, roleIds))).map((row) => [row.id, row.name])
  );
  const tokens = new Map(
    ids.length === 0
      ? []
      : (await appDb
          .select({ userId: apiTokens.createdBy, total: count(), lastUsedAt: max(apiTokens.lastUsedAt) })
          .from(apiTokens)
          .where(inArray(apiTokens.createdBy, ids))
          .groupBy(apiTokens.createdBy))
          .map((row) => [row.userId, { total: row.total, lastUsedAt: row.lastUsedAt ?? null }])
  );
  return members.map((member) => ({
    id: member.id,
    email: member.email,
    name: member.name ?? null,
    ...roleOf(member.role, member.customRoleId ?? null, roleNames),
    status: member.status,
    lastSignInAt: signIns.get(member.id) ?? null,
    mfa: mfa.get(member.id) === true,
    apiTokens: tokens.get(member.id)?.total ?? 0,
    tokenLastUsedAt: tokens.get(member.id)?.lastUsedAt ?? null,
  }));
}

/**
 * Everything the Organisations page shows `access` (a provider-level reader
 * of organisations), with `selectedId` opened (the first organisation when
 * it is absent or unknown).
 */
export async function loadOrganizationsPage(access: Access, selectedId: number | null, now: Date = new Date()): Promise<OrganizationsPageData> {
  const organizations = await listOrganizations();
  const canReadUsage = can(access, "usage_reports:read");
  const months = usageMonths(now);
  const billingPeriod = parseUsagePeriod(new URLSearchParams({ month: months.billing.month }), now);
  const currentPeriod = parseUsagePeriod(new URLSearchParams({ month: months.current.month }), now);

  const [billing, current] = canReadUsage && organizations.length > 0
    ? await Promise.all([buildUsageReport(access, billingPeriod), buildUsageReport(access, currentPeriod)])
    : [null, null];
  const billingRows = new Map((billing?.rows ?? []).map((row) => [row.organizationId, row]));
  const currentRows = new Map((current?.rows ?? []).map((row) => [row.organizationId, row]));

  const since = await disabledSince(organizations.filter((organization) => !organization.enabled).map((organization) => organization.id));
  const list: OrganizationListItem[] = organizations.map((organization) => ({
    ...organization,
    requests: canReadUsage ? billingRows.get(organization.id)?.requests ?? 0 : null,
    disabledSince: organization.enabled ? null : since.get(organization.id) ?? null,
  }));

  const opened = organizations.find((organization) => organization.id === selectedId) ?? organizations[0] ?? null;
  let selected: OrganizationDetail | null = null;
  if (opened) {
    const usageRow = billingRows.get(opened.id);
    let hosts: OrganizationHostItem[] | null = null;
    let hostsTotal = opened.counts.proxyHosts;
    if (can(access, "proxy_hosts:read")) {
      const all = (await listProxyHosts(scopeTagsFor(access, "proxy_hosts"), opened.id)).sort((a, b) =>
        (a.domains[0] ?? a.name).localeCompare(b.domains[0] ?? b.name)
      );
      hostsTotal = all.length;
      const shown = all.slice(0, ORGANIZATION_PAGE_HOST_LIMIT);
      const listIds = [...new Set(shown.map((host) => host.accessListId).filter((id): id is number => id !== null))];
      const listNames = new Map(
        listIds.length === 0
          ? []
          : (await appDb.select({ id: accessLists.id, name: accessLists.name }).from(accessLists).where(inArray(accessLists.id, listIds))).map((row) => [row.id, row.name])
      );
      const requests = canReadUsage ? await hostRequests(shown, billingPeriod) : new Map<number, number>();
      hosts = shown.map((host) => ({
        id: host.id,
        name: host.name,
        domain: host.domains[0] ?? host.name,
        moreDomains: Math.max(0, host.domains.length - 1),
        upstream: upstreamOf(host),
        moreUpstreams: Math.max(0, host.upstreams.length - 1),
        enabled: host.enabled,
        protections: hostProtections(host, listNames),
        requests: canReadUsage && billing?.analyticsAvailable ? requests.get(host.id) ?? 0 : null,
      }));
    }
    selected = {
      id: opened.id,
      usage: usageRow
        ? {
            requests: usageRow.requests,
            bytes: usageRow.bytes,
            wafBlocks: usageRow.wafBlocks,
            proxyHosts: usageRow.proxyHosts,
            enabledProxyHosts: usageRow.enabledProxyHosts,
          }
        : null,
      currentRequests: canReadUsage ? currentRows.get(opened.id)?.requests ?? 0 : null,
      hosts,
      hostsTotal,
      members: await organizationMembers(opened.id),
    };
  }

  return {
    organizations: list,
    provider: await providerCounts(),
    usage: canReadUsage ? { ...months, analyticsAvailable: billing?.analyticsAvailable ?? isAnalyticsEnabled() } : null,
    selected,
  };
}
