// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listMovableRows } from "@/ee/multi-tenancy/service";
import { FEATURE } from "@/ee/multi-tenancy/store";
import { loadOrganizationsPage } from "@/ee/multi-tenancy/page-data";
import { formatOrganizationView, readOrganizationView } from "@/ee/multi-tenancy/view";
import OrganizationsClient from "@/ee/multi-tenancy/ui/OrganizationsClient";
import { setOrganizationViewAction } from "./actions";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Organisations" };

/** ?organization=<id>: the organisation opened under the list. */
function selectedId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return parseRowId(value);
}

export default async function OrganizationsPage({ searchParams }: { searchParams?: Promise<{ organization?: string | string[] }> }) {
  const { access } = await requirePermission("organizations:read");
  const canWrite = can(access, "organizations:write");
  const params = (await searchParams) ?? {};
  const now = new Date();
  const [data, configurable, view] = await Promise.all([
    loadOrganizationsPage(access, selectedId(params.organization), now),
    isFeatureConfigurable(FEATURE),
    readOrganizationView(access),
  ]);
  return (
    <OrganizationsClient
      data={data}
      // Names and owners only: what the move dialog lists.
      movable={canWrite ? await listMovableRows() : { proxyHosts: [], certificates: [], accessLists: [], groups: [], users: [] }}
      configurable={configurable}
      editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
      canWrite={canWrite}
      allowed={{
        proxyHosts: can(access, "proxy_hosts:read"),
        users: can(access, "users:read"),
        createUsers: can(access, "users:write"),
      }}
      view={formatOrganizationView(view)}
      onSetView={setOrganizationViewAction}
      now={now.toISOString()}
    />
  );
}
