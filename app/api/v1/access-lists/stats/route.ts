import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";
import { loadAccessListOverview } from "@/src/lib/access-list-overview";
import { classifyAccessList } from "@/src/lib/access-list-rules";

/**
 * Where each access list is used and what it stopped in the last 24 hours
 * (src/lib/access-list-stats.ts). Hosts are the ones the caller can see;
 * instance-wide numbers need analytics:read at the provider level.
 */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "access_lists:read");
    const organizationId = readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId"));
    const overview = await loadAccessListOverview(access, organizationId);
    const { stats } = overview;
    return NextResponse.json(
      {
        available: stats.available,
        windowSeconds: stats.windowSeconds,
        stopped: stats.stopped,
        previous: stats.previous,
        requests: stats.requests,
        failedSignIns: stats.failedSignIns,
        byOutcome: stats.byOutcome,
        lists: overview.lists.map((list) => {
          const listStats = stats.lists[list.id];
          return {
            id: list.id,
            name: list.name,
            type: classifyAccessList({ ...list, memberCount: list.entries.length }).type,
            rules: list.rules.length,
            members: list.entries.length,
            stopped: listStats?.stopped ?? 0,
            failedSignIns: listStats?.failedSignIns ?? 0,
            hosts: (overview.usage[list.id] ?? []).map((host) => ({
              ...host,
              stopped: listStats?.hosts[host.id]?.stopped ?? 0,
              failedSignIns: listStats?.hosts[host.id]?.failedSignIns ?? 0,
            })),
          };
        }),
        blockedSources: overview.blockedSourcesVisible
          ? {
              id: overview.blockedSources?.id ?? null,
              entries: overview.blockedSources?.rules.length ?? 0,
              stopped: stats.blockedSources?.stopped ?? null,
            }
          : null,
        countries: stats.countries,
        hosts: stats.hosts,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
