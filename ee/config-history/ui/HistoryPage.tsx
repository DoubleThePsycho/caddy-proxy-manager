// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { MIN_EXPORT_PASSPHRASE_LENGTH } from "@/src/lib/config-transfer";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listSnapshots } from "@/ee/config-history/snapshots";
import { getHistorySettings, MAX_RETENTION, MIN_RETENTION } from "@/ee/config-history/settings";
import { FEATURE } from "@/ee/config-history/service";
import { getVersion, listVersions, type VersionView } from "@/ee/config-history/versions";
import { listBackupDestinations } from "@/ee/backups/destinations";
import { listBackupRuns } from "@/ee/backups/runner";
import { FEATURE as BACKUPS_FEATURE } from "@/ee/backups/types";
import HistoryClient, { type HistoryTab } from "./HistoryClient";
import { parseCompareParam } from "./history-format";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Change history" };

const PER_PAGE = 25;
const RUNS_SHOWN = 20;

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
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const initialTab: HistoryTab = params.tab === "backups" && allowed.backups ? "backups" : "versions";

  // Destination views carry no secrets (hasSecretAccessKey / hasPassphrase only); versions and diffs mask secrets.
  const [list, settings, configurable, mode, destinations, runs, backupsConfigurable] = await Promise.all([
    listVersions({ limit: PER_PAGE, offset: (page - 1) * PER_PAGE }),
    getHistorySettings(),
    isFeatureConfigurable(FEATURE),
    getInstanceMode(),
    allowed.backups ? listBackupDestinations() : Promise.resolve([]),
    allowed.backups
      ? listBackupRuns({ page: 1, perPage: RUNS_SHOWN })
      : Promise.resolve({ runs: [], total: 0, page: 1, perPage: RUNS_SHOWN }),
    isFeatureConfigurable(BACKUPS_FEATURE),
  ]);

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
      initialTab={initialTab}
      now={Date.now()}
      versions={list}
      page={page}
      perPage={PER_PAGE}
      extraVersion={extraVersion}
      initialVersionId={initialVersionId}
      initialCompare={parseCompareParam(params.compare)}
      focusRollback={params.rollback === "1"}
      oldest={oldest ? { id: oldest.id, createdAt: oldest.createdAt } : null}
      backups={{
        destinations,
        runs,
        configurable: backupsConfigurable,
        editionLabel: EDITION_LABELS[FEATURE_INFO[BACKUPS_FEATURE].edition],
      }}
      settings={settings}
      configurable={configurable}
      isSlave={mode === "slave"}
      editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
      limits={{ minRetention: MIN_RETENTION, maxRetention: MAX_RETENTION, minPassphraseLength: MIN_EXPORT_PASSPHRASE_LENGTH }}
      allowed={allowed}
    />
  );
}
