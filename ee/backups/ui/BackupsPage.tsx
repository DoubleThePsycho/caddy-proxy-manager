// SPDX-License-Identifier: Elastic-2.0
import { PageHeader } from "@/components/ui/PageHeader";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { MIN_EXPORT_PASSPHRASE_LENGTH } from "@/src/lib/config-transfer";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/src/lib/pagination";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listBackupDestinations } from "@/ee/backups/destinations";
import { listBackupRuns } from "@/ee/backups/runner";
import { FEATURE } from "@/ee/backups/types";
import BackupsTab from "./BackupsTab";

export const metadata = { title: "Backups" };

/** Scheduled backups: destinations, their runs and restores. */
export default async function BackupsPage({ searchParams }: { searchParams?: Promise<{ page?: string }> } = {}) {
  // Backups are their own permission area, as on the REST API.
  const { access } = await requirePermission("backups:read");
  const header = (
    <PageHeader
      className="mb-0"
      breadcrumb={["Govern", can(access, "config_history:read") ? { label: "Change history", href: "/history" } : "Change history", "Backups"]}
      title="Backups"
    />
  );

  const requested = parsePageParam((await searchParams)?.page);
  const [destinations, configurable, mode, first] = await Promise.all([
    listBackupDestinations(),
    isFeatureConfigurable(FEATURE),
    getInstanceMode(),
    listBackupRuns({ page: requested, perPage: DEFAULT_PAGE_SIZE }),
  ]);
  // A page past the end shows the last one.
  const lastPage = Math.max(1, Math.ceil(first.total / DEFAULT_PAGE_SIZE));
  const runs = requested > lastPage ? await listBackupRuns({ page: lastPage, perPage: DEFAULT_PAGE_SIZE }) : first;

  return (
    <div className="flex flex-col gap-5">
      {header}
      <BackupsTab
        destinations={destinations}
        runs={runs}
        configurable={configurable}
        isSlave={mode === "slave"}
        editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
        minPassphraseLength={MIN_EXPORT_PASSPHRASE_LENGTH}
        paginateRuns
      />
    </div>
  );
}
