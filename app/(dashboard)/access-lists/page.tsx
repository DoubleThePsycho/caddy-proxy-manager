import AccessListsClient from "./AccessListsClient";
import BlockedSourcesClient from "./BlockedSourcesClient";
import { blockedSourcesPlaceholder } from "@/src/lib/models/access-lists";
import { loadAccessListOverview } from "@/src/lib/access-list-overview";
import { getTrustedProxiesSettings } from "@/src/lib/settings";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";

export const metadata = { title: "Access lists" };

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

/** The lists of hosts, or with ?tab=blocked-sources the global Blocked sources list. */
export default async function AccessListsPage({ searchParams }: PageProps = {}) {
  const { access } = await requirePermission("access_lists:read");
  const params = (await searchParams) ?? {};
  const blockedTab = params.tab === "blocked-sources";
  const overview = await loadAccessListOverview(access);
  const canWrite = can(access, "access_lists:write");

  if (blockedTab) {
    const trustedProxies = await getTrustedProxiesSettings();
    return (
      <BlockedSourcesClient
        list={overview.blockedSources ?? blockedSourcesPlaceholder()}
        stopped={overview.stats.available ? overview.stats.blockedSources?.stopped ?? null : null}
        listCount={overview.lists.length}
        canWrite={canWrite}
        trustedProxiesConfigured={(trustedProxies?.ranges ?? []).some((range) => range.trim().length > 0)}
      />
    );
  }

  return (
    <AccessListsClient
      lists={overview.lists}
      usage={overview.usage}
      stats={overview.stats}
      blockedCount={overview.blockedSources?.rules.length ?? 0}
      canWrite={canWrite}
    />
  );
}
