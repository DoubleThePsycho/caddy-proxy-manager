// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownUp, History, Plus } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusDot } from "@/components/ui/StatusDot";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { HistorySettings } from "@/ee/config-history/settings";
import type { SnapshotView } from "@/ee/config-history/snapshots";
import type { RestoreResult } from "@/ee/config-history/service";
import type { RollbackPreview, VersionList, VersionView } from "@/ee/config-history/versions";
import { describeSchedule, type BackupDestinationView } from "@/ee/backups/types";
import { HistorySettingsDialog } from "./HistorySettingsDialog";
import { RollbackPanel } from "./RollbackPanel";
import { TransferDialog } from "@/src/components/config-transfer/TransferDialog";
import { VersionDetail } from "./VersionDetail";
import { VersionTimeline } from "./VersionTimeline";
import { compareParam, describeReload, type CompareTarget } from "./history-format";
import { jsonInit, requestJson } from "@/src/lib/request-json";

/** The backup destinations, for the line that links to the Backups page. */
export type BackupsProps = {
  destinations: BackupDestinationView[];
};

export type HistoryAllowed = { backups: boolean; export: boolean; import: boolean; write: boolean; restore: boolean };

type Props = {
  /** Server time of the render (ms), for the day labels of the timeline. */
  now: number;
  versions: VersionList;
  page: number;
  perPage: number;
  /** A version asked for in the URL that is not on this page. */
  extraVersion?: VersionView | null;
  initialVersionId?: number | null;
  initialCompare?: CompareTarget;
  /** ?rollback=1: scroll to the rollback panel. */
  focusRollback?: boolean;
  /** The oldest version kept. */
  oldest?: { id: number; createdAt: string } | null;
  backups: BackupsProps;
  settings: HistorySettings;
  isSlave: boolean;
  limits: { minRetention: number; maxRetention: number; minPassphraseLength: number };
  /** What the user's role allows besides reading history (custom roles); everything when omitted. */
  allowed?: HistoryAllowed;
};

type Flash = { tone: "ok" | "bad" | "warn"; text: string } | null;

const ALL_ALLOWED: HistoryAllowed = { backups: true, export: true, import: true, write: true, restore: true };

export default function HistoryClient({
  now,
  versions: list,
  page,
  perPage,
  extraVersion = null,
  initialVersionId = null,
  initialCompare = "previous",
  focusRollback = false,
  oldest = null,
  backups,
  settings,
  isSlave,
  limits,
  allowed = ALL_ALLOWED,
}: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const [pending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<number | null>(initialVersionId);
  const [compare, setCompare] = useState<CompareTarget>(initialCompare);
  const [flash, setFlash] = useState<Flash>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<VersionView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const rollbackRef = useRef<HTMLDivElement>(null);

  const versions = list.versions;
  const all = useMemo(
    () => (extraVersion && !versions.some((version) => version.id === extraVersion.id) ? [...versions, extraVersion] : versions),
    [versions, extraVersion]
  );
  const selected =
    all.find((version) => version.id === selectedId) ??
    (list.liveId !== null ? versions.find((version) => version.id === list.liveId) : undefined) ??
    versions[0] ??
    null;

  // The URL holds the page, version and comparison; updating it needs no server round trip.
  function syncUrl(next: { version?: number | null; compare?: CompareTarget }) {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    const version = next.version === undefined ? selectedId : next.version;
    if (version !== null) params.set("version", String(version));
    const target = next.compare ?? compare;
    if (target !== "previous") params.set("compare", compareParam(target));
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/history?${query}` : "/history");
  }

  function selectVersion(version: VersionView) {
    const target = version.live && compare === "live" ? "previous" : compare;
    setSelectedId(version.id);
    setCompare(target);
    syncUrl({ version: version.id, compare: target });
  }

  function changeCompare(target: CompareTarget) {
    setCompare(target);
    syncUrl({ compare: target });
  }

  useEffect(() => {
    if (!focusRollback || !rollbackRef.current) return;
    rollbackRef.current.scrollIntoView({ block: "start" });
    rollbackRef.current.focus({ preventScroll: true });
  }, [focusRollback]);

  function refresh(message: Flash, nextSelected: number | null) {
    setFlash(message);
    setSelectedId(nextSelected);
    setReloadKey((value) => value + 1);
    syncUrl({ version: nextSelected });
    router.refresh();
  }

  function saveVersion() {
    setSaveError(null);
    startTransition(async () => {
      try {
        const snapshot = await requestJson<SnapshotView>(
          "/api/v1/config-history",
          jsonInit("POST", note.trim() ? { summary: note.trim() } : {})
        );
        setNote("");
        setSaveOpen(false);
        refresh({ tone: "ok", text: `Saved version #${snapshot.id}.` }, snapshot.id);
      } catch (caught) {
        setSaveError((caught as Error).message);
      }
    });
  }

  function deleteVersion() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteError(null);
    startTransition(async () => {
      try {
        await requestJson(`/api/v1/config-history/${target.id}`, { method: "DELETE" });
        setDeleteTarget(null);
        refresh({ tone: "ok", text: `Deleted version #${target.id}. The live configuration did not change.` }, null);
      } catch (caught) {
        setDeleteError((caught as Error).message);
      }
    });
  }

  function rolledBack(result: RestoreResult, preview: RollbackPreview) {
    refresh(
      {
        tone: result.warning ? "warn" : "ok",
        text:
          `Rolled back to #${result.restoredSnapshotId} and reloaded Caddy on ${describeReload(preview.reload)}. ` +
          `The configuration it replaced is saved as #${result.beforeSnapshotId}; roll back to it to undo this.` +
          (result.warning ? ` ${result.warning}.` : ""),
      },
      null
    );
  }

  const enabledDestinations = backups.destinations.filter((destination) => destination.enabled);
  const failingDestinations = enabledDestinations.filter((destination) => destination.lastStatus === "failed");
  const onlyDestination = enabledDestinations.length === 1 ? enabledDestinations[0] : null;
  let backupSummary: ReactNode = null;
  const backupsLink = "underline-offset-4 hover:text-foreground hover:underline";
  if (allowed.backups && enabledDestinations.length === 0) {
    backupSummary = (
      <Link href="/backups" className={backupsLink}>
        No scheduled backups
      </Link>
    );
  } else if (allowed.backups && onlyDestination) {
    backupSummary = (
      <Link href="/backups" className={backupsLink}>
        Backups to {onlyDestination.name}, {describeSchedule(onlyDestination.schedule, onlyDestination.timeZone).toLowerCase()}
        {onlyDestination.lastRunAt &&
          (onlyDestination.lastStatus === "failed" ? (
            <span className="text-bad">, last failed {fmt.relative(onlyDestination.lastRunAt, now).toLowerCase()}</span>
          ) : (
            <>, last ran {fmt.relative(onlyDestination.lastRunAt, now).toLowerCase()}</>
          ))}
      </Link>
    );
  } else if (allowed.backups) {
    backupSummary = (
      <Link href="/backups" className={backupsLink}>
        Backups to <span className="num">{enabledDestinations.length}</span> destinations
        {failingDestinations.length > 0 && (
          <span className="text-bad">
            , <span className="num">{failingDestinations.length}</span> failing
          </span>
        )}
      </Link>
    );
  }

  const strip = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px] text-muted-foreground">
      <StatusDot tone={settings.enabled ? "ok" : "off"} label={settings.enabled ? "Recording on" : "Recording off"} />
      {!settings.enabled && <span>No new versions are recorded</span>}
      <span>
        Keeps the newest <span className="num">{settings.retention.toLocaleString("en-US")}</span>
        {oldest && (
          <>
            ; oldest kept <span className="num">#{oldest.id}</span>, {fmt.date(oldest.createdAt)}
          </>
        )}
      </span>
      {backupSummary}
      <Button variant="link" size="sm" className="h-auto px-0 sm:ml-auto" onClick={() => setSettingsOpen(true)}>
        History settings
      </Button>
    </div>
  );

  const versionsContent = (
    <div className="flex flex-col gap-5">
      {selected === null ? (
        <section aria-label="Versions" className="rounded-2xl border border-line bg-panel">
          <EmptyState
            icon={History}
            title="No versions yet"
            description={
              settings.enabled
                ? "The next change Caddy accepts is saved as the first version."
                : "Turn recording on to keep a version after every change."
            }
            action={
              allowed.write && !isSlave ? (
                <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
                  History settings
                </Button>
              ) : undefined
            }
          />
        </section>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <VersionTimeline
            versions={versions}
            total={list.total}
            page={page}
            perPage={perPage}
            selectedId={selected.id}
            onSelect={selectVersion}
            now={now}
          />
          <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-5">
            <VersionDetail
              version={selected}
              others={all}
              compare={compare}
              onCompare={changeCompare}
              canDelete={allowed.write}
              onDelete={() => {
                setDeleteError(null);
                setDeleteTarget(selected);
              }}
              reloadKey={reloadKey}
            />
            <RollbackPanel
              ref={rollbackRef}
              version={selected}
              canRestore={allowed.restore}
              onShowLiveDiff={() => changeCompare("live")}
              onRolledBack={rolledBack}
              reloadKey={reloadKey}
            />
          </div>
        </div>
      )}
    </div>
  );

  const slaveNotice = isSlave && (
    <Banner tone="info">
      This instance is a sync slave: its configuration comes from the master, so it records no history and cannot roll back, export,
      import or back up. Use the master instead.
    </Banner>
  );
  const flashBanner = flash && (
    <Banner tone={flash.tone} live onDismiss={() => setFlash(null)} dismissLabel="Dismiss message">
      {flash.text}
    </Banner>
  );

  const header = (
    <PageHeader
      className="mb-0"
      breadcrumb={["Govern", "Change history"]}
      title="Change history"
      actions={
        <>
          {allowed.write && (
            <Button
              variant="outline"
              onClick={() => {
                setSaveError(null);
                setSaveOpen(true);
              }}
              disabled={isSlave}
              title={isSlave ? "A sync slave records no history" : undefined}
            >
              <Plus /> Save a version now
            </Button>
          )}
          {(allowed.export || allowed.import) && (
            <Button variant="outline" onClick={() => setTransferOpen(true)}>
              <ArrowDownUp /> Export or import
            </Button>
          )}
        </>
      }
    />
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      {header}
      {strip}
      {slaveNotice}
      {flashBanner}
      {versionsContent}

      <AppDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save a version now"
        submitLabel="Save version"
        onSubmit={saveVersion}
        isSubmitting={pending}
        maxWidth="md"
      >
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-muted-foreground">Saves the configuration as it is now.</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="version-note">Note (optional)</Label>
            <Input id="version-note" placeholder="Before the upgrade" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          {saveError && (
            <Banner tone="bad" live>
              {saveError}
            </Banner>
          )}
        </div>
      </AppDialog>

      <AppDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete version #${deleteTarget?.id ?? ""}?`}
        submitLabel="Delete"
        onSubmit={deleteVersion}
        isSubmitting={pending}
      >
        <div className="flex flex-col gap-2 text-sm">
          <p className="m-0">The version is deleted. The live configuration does not change.</p>
          {deleteError && (
            <Banner tone="bad" live>
              {deleteError}
            </Banner>
          )}
        </div>
      </AppDialog>

      <TransferDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        isSlave={isSlave}
        allowed={{ export: allowed.export, import: allowed.import }}
        minPassphraseLength={limits.minPassphraseLength}
        historyEnabled={settings.enabled}
        onImported={(text) => refresh({ tone: "ok", text }, null)}
      />

      <HistorySettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        canWrite={allowed.write}
        total={list.total}
        limits={limits}
        onChanged={(text) => refresh({ tone: "ok", text }, selectedId)}
      />
    </div>
  );
}
