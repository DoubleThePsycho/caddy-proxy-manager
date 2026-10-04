// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { tenantOf } from "@/src/lib/permissions";
import { appDb } from "@/src/lib/db";
import { buildUsageReport, parseUsagePeriod } from "@/ee/multi-tenancy/usage";
import { listOrganizationRows } from "@/ee/multi-tenancy/store";
import UsageClient from "@/ee/multi-tenancy/ui/UsageClient";

export const metadata = { title: "Usage" };

export default async function UsagePage() {
  const { access } = await requirePermission("usage_reports:read");
  // Organisation users get their own organisation's report only.
  const report = await buildUsageReport(access, parseUsagePeriod(new URLSearchParams()));
  const providerLevel = tenantOf(access) === null;
  return (
    <UsageClient
      initialReport={report}
      organizations={providerLevel ? (await listOrganizationRows(appDb)).map((organization) => ({ id: organization.id, name: organization.name })) : []}
      providerLevel={providerLevel}
    />
  );
}
