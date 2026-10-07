// SPDX-License-Identifier: Elastic-2.0
import { redirect } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { MIN_EXPORT_PASSPHRASE_LENGTH } from "@/src/lib/config-transfer";
import { listSnapshots } from "@/ee/config-history/snapshots";
import { getHistorySettings, MAX_RETENTION, MIN_RETENTION } from "@/ee/config-history/settings";
import { getVersion, listVersions, type VersionView } from "@/ee/config-history/versions";
import { listBackupDestinations } from "@/ee/backups/destinations";
import HistoryClient from "./HistoryClient";
import { parseCompareParam } from "./history-format";
import { parseRowId } from "@/src/lib/row-ids";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/src/lib/pagination";

export const metadata = { title: "Change history" };

const PER_PAGE = DEFAULT_PAGE_SIZE;

type SearchParams = { page?: string; tab?: string; version?: string; compare?: string; rollback?: string };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { access } = await requirePermission("config_history:read");
  const allowed = {
    backups: can(access, "backups:read"),
    export: can(access, "config:export"),
    import: can(access, "config:import"),
    write: can(access, "config_history:write"),
    restore: can(access, "config_history:restore"),
  };
  const params = await searchParams;
  // The Backups tab is a page of its own now.
  if (params.tab === "backups" && allowed.backups) redirect("/backups");
  const requestedPage = parsePageParam(params.page);

  // Destination views carry no secrets (hasSecretAccessKey / hasPassphrase only); versions and diffs mask secrets.
  const [firstList, settings, mode, destinations] = await Promise.all([
    listVersions({ limit: PER_PAGE, offset: (requestedPage - 1) * PER_PAGE }),
    getHistorySettings(),
    getInstanceMode(),
    allowed.backups ? listBackupDestinations() : Promise.resolve([]),
  ]);

  // A page past the last one shows the last.
  const pageCount = Math.max(1, Math.ceil(firstList.total / PER_PAGE));
  const page = Math.min(requestedPage, pageCount);
  const list = page === requestedPage ? firstList : await listVersions({ limit: PER_PAGE, offset: (page - 1) * PER_PAGE });

  // The oldest version kept, for the retention line.
  const oldest = list.total > 0 ? (await listSnapshots({ limit: 1, offset: list.total - 1 })).snapshots[0] ?? null : null;

  // ?version=<id>: a version that is not on this page is loaded on its own; unknown ids are ignored.
  const requested = parseRowId(params.version);
  let extraVersion: VersionView | null = null;
  let initialVersionId: number | null = null;
  if (requested !== null) {
    if (list.versions.some((version) => version.id === requested)) {
      initialVersionId = requested;
    } else {
      try {
        extraVersion = await getVersion(requested);
        initialVersionId = requested;
      } catch {
        initialVersionId = null;
      }
    }
  }

  return (
    <HistoryClient
      now={Date.now()}
      versions={list}
      page={page}
      perPage={PER_PAGE}
      extraVersion={extraVersion}
      initialVersionId={initialVersionId}
      initialCompare={parseCompareParam(params.compare)}
      focusRollback={params.rollback === "1"}
      oldest={oldest ? { id: oldest.id, createdAt: oldest.createdAt } : null}
      backups={{ destinations }}
      settings={settings}
      isSlave={mode === "slave"}
      limits={{ minRetention: MIN_RETENTION, maxRetention: MAX_RETENTION, minPassphraseLength: MIN_EXPORT_PASSPHRASE_LENGTH }}
      allowed={allowed}
    />
  );
}
