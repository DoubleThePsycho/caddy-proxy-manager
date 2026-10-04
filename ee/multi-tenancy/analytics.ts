// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: analytics of one organisation. ClickHouse stores each
 * request's Host header, not the proxy host it reached, so an organisation's
 * analytics (and usage report) cover the host names its proxy hosts serve: a
 * stored host counts when it equals one of the organisation's domains or one
 * of its wildcards covers it (one label, as Caddy matches), port and case
 * ignored. Domains are unique across organisations (domains.ts), so no stored
 * host counts for two of them.
 *
 * Attribution follows the hosts as they are now: traffic of a domain that
 * moved to another organisation, or whose host was deleted, counts for its
 * current owner (or nobody).
 */
import { eq, isNull } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { proxyHosts } from "@/src/lib/db/schema";
import { isDomainCoveredByWildcard } from "@/src/lib/cert-domain-match";
import { queryDistinctHostsAll } from "@/src/lib/clickhouse/client";
import type { Access } from "@/src/lib/permissions";
import { dashboardOrganizationFilter } from "./view";
import type { OrganizationFilter } from "./scope";

/** The domains of the proxy hosts of `organizationId` (null: the provider level). */
export async function organizationDomains(organizationId: number | null): Promise<string[]> {
  const rows = await appDb
    .select({ domains: proxyHosts.domains })
    .from(proxyHosts)
    .where(organizationId === null ? isNull(proxyHosts.organizationId) : eq(proxyHosts.organizationId, organizationId));
  const names = new Set<string>();
  for (const row of rows) {
    try {
      for (const domain of JSON.parse(row.domains) as unknown[]) {
        const name = String(domain ?? "").trim().toLowerCase().replace(/\.$/, "");
        if (name) names.add(name);
      }
    } catch {
      // A malformed row serves nothing.
    }
  }
  return [...names];
}

/** A stored Host header as a bare lowercase name (no port, no trailing dot). */
export function storedHostName(host: string): string {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    return end > 0 ? name.slice(0, end + 1) : name;
  }
  name = name.replace(/:\d{1,5}$/, "");
  return name.replace(/\.$/, "");
}

/** True when the stored host `host` is served by one of `domains`. */
export function hostMatchesDomains(host: string, domains: readonly string[]): boolean {
  const name = storedHostName(host);
  if (!name) return false;
  return domains.includes(name) || isDomainCoveredByWildcard(name, domains.filter((domain) => domain.startsWith("*.")));
}

/** Every stored host name seen in ClickHouse; none when it is unavailable. */
export async function seenHosts(): Promise<string[]> {
  try {
    return await queryDistinctHostsAll();
  } catch {
    return [];
  }
}

/**
 * The stored host names that belong to `organizationId` (null: the provider
 * level): those seen that its domains serve, plus its exact domains.
 */
export async function organizationHosts(organizationId: number | null, seen: readonly string[]): Promise<string[]> {
  const domains = await organizationDomains(organizationId);
  const hosts = new Set(domains.filter((domain) => !domain.startsWith("*.")));
  for (const host of seen) {
    if (hostMatchesDomains(host, domains)) hosts.add(host);
  }
  return [...hosts];
}

/**
 * The hosts analytics may cover for `access`: null for every host (a
 * provider-level user with no organisation view), otherwise the stored host
 * names of the organisation (or of the provider level).
 */
export async function analyticsHostScope(access: Access, filter?: OrganizationFilter): Promise<string[] | null> {
  const organizationId = filter === undefined ? await dashboardOrganizationFilter(access) : filter;
  if (organizationId === undefined) return null;
  return await organizationHosts(organizationId, await seenHosts());
}
