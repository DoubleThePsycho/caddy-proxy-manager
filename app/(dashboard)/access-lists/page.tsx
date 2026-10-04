import AccessListsClient from "./AccessListsClient";
import { blockedSourcesPlaceholder } from "@/src/lib/models/access-lists";
import { loadAccessListOverview } from "@/src/lib/access-list-overview";
import { getTrustedProxiesSettings } from "@/src/lib/settings";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { dashboardOrganizationFilter } from "@/ee/multi-tenancy/view";

export default async function AccessListsPage() {
  const { access } = await requirePermission("access_lists:read");
  // An organisation user sees their organisation only; a provider-level user the organisation they picked (ee/multi-tenancy).
  const organizationId = await dashboardOrganizationFilter(access);
  const [overview, trustedProxies] = await Promise.all([
    loadAccessListOverview(access, organizationId),
    getTrustedProxiesSettings(),
  ]);

  return (
    <AccessListsClient
      lists={overview.lists}
      usage={overview.usage}
      blockedSources={overview.blockedSourcesVisible ? overview.blockedSources ?? blockedSourcesPlaceholder() : null}
      stats={overview.stats}
      canWrite={can(access, "access_lists:write")}
      trustedProxiesConfigured={(trustedProxies?.ranges ?? []).some((range) => range.trim().length > 0)}
    />
  );
}
