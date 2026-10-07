/**
 * What the Access lists page and GET /api/v1/access-lists/stats show a
 * caller: the lists, the hosts using each one (only hosts the caller can
 * see), the global Blocked sources list and what the lists stopped in the
 * last 24 hours (access-list-stats.ts).
 *
 * Instance-wide traffic numbers (the request total, the Blocked sources
 * count, and stopped requests from blocked sources on any host) need
 * analytics:read; everyone else gets the numbers of the hosts they can see.
 */
import { can, scopeTagsFor, type Access } from "./permissions";
import {
  getAccessListUsageMap,
  getBlockedSourcesList,
  listAccessLists,
  type AccessList,
  type AccessListUsage,
} from "./models/access-lists";
import { listProxyHosts } from "./models/proxy-hosts";
import { emptyAccessListStats, queryAccessListStats, type AccessListStats } from "./access-list-stats";
import { isRuleExpired } from "./access-list-rules";

export type AccessListOverview = {
  lists: AccessList[];
  /** Hosts using each list, by list id: only hosts the caller can see. */
  usage: Record<number, AccessListUsage[]>;
  /** Null before the list's first use. */
  blockedSources: AccessList | null;
  stats: AccessListStats;
};

export async function loadAccessListOverview(access: Access, options: { stats?: boolean } = {}): Promise<AccessListOverview> {
  const [lists, usageMap, blockedSources] = await Promise.all([listAccessLists(), getAccessListUsageMap(), getBlockedSourcesList()]);

  // Only the hosts the user can see are listed as using a list.
  const visibleHostIds = access.isAdmin
    ? null
    : new Set(
        can(access, "proxy_hosts:read")
          ? (await listProxyHosts(scopeTagsFor(access, "proxy_hosts"))).map((host) => host.id)
          : []
      );
  const usage: Record<number, AccessListUsage[]> = {};
  for (const [listId, hosts] of usageMap) {
    usage[listId] = visibleHostIds ? hosts.filter((host) => visibleHostIds.has(host.id)) : hosts;
  }

  const instanceWide = can(access, "analytics:read");
  const statsInput = {
    lists: lists.map((list) => ({
      id: list.id,
      basicAuth: list.entries.length > 0,
      hosts: (usage[list.id] ?? []).filter((host) => host.enabled).map((host) => ({ id: host.id, domains: host.domains })),
    })),
    blockedSources:
      instanceWide && blockedSources
        ? {
            addresses: blockedSources.rules.filter((rule) => rule.kind === "ip" && !isRuleExpired(rule)).flatMap((rule) => rule.values),
            countries: blockedSources.rules.filter((rule) => rule.kind === "country" && !isRuleExpired(rule)).flatMap((rule) => rule.values),
          }
        : null,
    includeRequests: instanceWide,
  };
  const stats = options.stats === false ? emptyAccessListStats(statsInput.lists) : await queryAccessListStats(statsInput);

  return { lists, usage, blockedSources, stats };
}
