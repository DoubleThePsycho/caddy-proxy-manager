// SPDX-License-Identifier: Elastic-2.0
"use client";

import { forwardRef, useEffect, useState, useTransition, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/SectionCard";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { TARGET_LABELS } from "@/ee/approvals/types";
import type { RestoreResult } from "@/ee/config-history/service";
import type { RollbackPreview, VersionView } from "@/ee/config-history/versions";
import { jsonInit, requestJson } from "@/src/lib/request-json";
import { describeActors, describeReload, describeRollbackHost, remainingReasons, summarizeFields } from "./history-format";

const LIST_SHOWN = 8;

type Props = {
  version: VersionView;
  /** The caller holds config_history:restore. */
  canRestore: boolean;
  onShowLiveDiff: () => void;
  onRolledBack: (result: RestoreResult, preview: RollbackPreview) => void;
  reloadKey: number;
};

function Box({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
      <h3 className="m-0 text-[13px] font-semibold">
        {title} <span className="num font-medium text-soft">{count}</span>
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{children}</ul>
    </div>
  );
}

function More({ count }: { count: number }) {
  if (count <= 0) return null;
  return <li className="text-xs text-soft">and {count} more</li>;
}

type SummaryProps = {
  version: VersionView;
  preview: RollbackPreview;
  /** The caller holds config_history:restore. */
  canRestore: boolean;
  pending: boolean;
  onRollBack: () => void;
  onShowLiveDiff: () => void;
};

/** The rollback preview in words: what changes, what is undone, warnings, refusals, and the buttons. */
export function RollbackSummary({ version, preview, canRestore, pending, onRollBack, onShowLiveDiff }: SummaryProps) {
  const fmt = useFormat();
  const live = version.live || preview.liveId === version.id;
  const reasons = remainingReasons(preview);
  const allowed = canRestore && preview.canRestore;
  return (
    <>
      {live && (
        <p className="m-0 text-[13px] text-muted-foreground">
          This is the live configuration. Pick an older version on the left to see what rolling back to it would change.
        </p>
      )}
      {!live && preview.identical && (
        <p className="m-0 text-[13px] text-muted-foreground">This version matches the live configuration, so rolling back would change nothing.</p>
      )}
      {!live && !preview.identical && (
        <>
          <p className="m-0 text-[13px] text-muted-foreground">
            The configuration goes back to how it was after <span className="num">#{version.id}</span> and Caddy reloads it on{" "}
            {describeReload(preview.reload)}. The live configuration is saved as a new version first, so you can undo this.
            {preview.reload.heldBack.length > 0 &&
              ` ${preview.reload.heldBack.join(", ")} get${preview.reload.heldBack.length === 1 ? "s" : ""} it only when a revision is promoted.`}
          </p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3">
            <Box title="Hosts that change" count={preview.hosts.length}>
              {preview.hosts.length === 0 && <li className="text-xs text-soft">No host changes.</li>}
              {preview.hosts.slice(0, LIST_SHOWN).map((host) => (
                <li key={`${host.type}:${host.id}`} className="flex flex-col gap-px">
                  <span className="num text-[13px] [overflow-wrap:anywhere]">
                    {host.name}
                    {host.type === "l4_proxy_host" && <span className="font-sans text-xs text-soft"> · {TARGET_LABELS[host.type]}</span>}
                  </span>
                  <span className="text-xs text-soft [overflow-wrap:anywhere]">{describeRollbackHost(host)}</span>
                </li>
              ))}
              <More count={preview.hosts.length - LIST_SHOWN} />
            </Box>
            {preview.settings.length + preview.other.length > 0 && (
              <Box title="Settings and other items" count={preview.settings.length + preview.other.length}>
                {preview.settings.map((setting) => (
                  <li key={`settings:${setting.key}`} className="flex flex-col gap-px">
                    <span className="text-[13px]">Settings › {setting.label}</span>
                    <span className="num text-xs text-soft [overflow-wrap:anywhere]">
                      {setting.kind === "changed" ? summarizeFields(setting.fields) : setting.kind === "added" ? "Set back" : "Cleared"}
                    </span>
                  </li>
                ))}
                {preview.other.slice(0, LIST_SHOWN).map((item) => (
                  <li key={`${item.entity}:${item.id}`} className="flex flex-col gap-px">
                    <span className="text-[13px] [overflow-wrap:anywhere]">
                      {item.entityLabel} › {item.label}
                    </span>
                    <span className="text-xs text-soft">{item.kind === "added" ? "Added back" : item.kind === "removed" ? "Removed" : "Changed"}</span>
                  </li>
                ))}
                <More count={preview.other.length - LIST_SHOWN} />
              </Box>
            )}
            <Box title="Later changes it undoes" count={preview.undoes.length}>
              {preview.undoes.length === 0 && !preview.undoesUnrecordedChanges && (
                <li className="text-xs text-soft">None: nothing was recorded after this version.</li>
              )}
              {preview.undoes.slice(0, LIST_SHOWN).map((undone) => (
                <li key={undone.id} className="flex flex-col gap-px">
                  <span className="text-[13px] [overflow-wrap:anywhere]">{undone.title}</span>
                  <span className="text-xs text-soft">
                    <span className="num">#{undone.id}</span> · {describeActors(undone.actors)} · <span className="num">{fmt.dateTime(undone.createdAt)}</span>
                  </span>
                </li>
              ))}
              <More count={preview.undoes.length - LIST_SHOWN} />
              {preview.undoesUnrecordedChanges && (
                <li className="text-xs text-warn">
                  The live configuration also has changes no version holds (recording was off, or Caddy refused an apply); they are undone
                  too.
                </li>
              )}
            </Box>
          </div>
          {preview.sameHostWarnings.length > 0 && (
            <Banner tone="warn" layout="stacked" title="A later change touched the same host">
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-foreground">
                {preview.sameHostWarnings.slice(0, LIST_SHOWN).map((warning) => (
                  <li key={warning.versionId}>
                    <span className="num">#{warning.versionId}</span> by {describeActors(warning.actors)},{" "}
                    <span className="num">{fmt.dateTime(warning.createdAt)}</span>: {warning.title} ({warning.hosts.join(", ")})
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-1">Rolling back undoes those changes too. To keep them, change the host by hand instead.</p>
            </Banner>
          )}
          {preview.blocked && (
            <Banner tone="bad" layout="stacked" title="This rollback is refused while approval policies protect these hosts">
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-foreground">
                {preview.blocked.hosts.map((host) => (
                  <li key={`${host.type}:${host.id}`}>
                    <span className="num">{host.name}</span>{" "}
                    <span className="text-muted-foreground">
                      · policy {host.policies.map((policy) => policy.name).join(", ")} ({host.operations.join(", ")})
                    </span>
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-1">{preview.blocked.message}</p>
            </Banner>
          )}
          {reasons.length > 0 && (
            <Banner tone="info" layout="stacked" title="Rolling back is not possible here">
              <ul className="m-0 list-disc pl-4">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </Banner>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={onRollBack}
              disabled={!allowed || pending}
              title={allowed ? undefined : reasons[0] ?? preview.blocked?.message}
            >
              <RotateCcw /> Roll back to #{version.id}
            </Button>
            <Button variant="secondary" onClick={onShowLiveDiff}>
              Show the full diff against live
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/** What rolling back to a version would do (from the rollback preview), and the rollback itself. */
export const RollbackPanel = forwardRef<HTMLDivElement, Props>(function RollbackPanel(
  { version, canRestore, onShowLiveDiff, onRolledBack, reloadKey },
  ref
) {
  const fmt = useFormat();
  const [pending, startTransition] = useTransition();
  const key = `${version.id}|${reloadKey}`;
  const [loaded, setLoaded] = useState<{ key: string; preview: RollbackPreview } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<RollbackPreview>(`/api/v1/config-history/${version.id}/rollback-preview`)
      .then((preview) => {
        if (!cancelled) {
          setLoaded({ key, preview });
          setFailure(null);
        }
      })
      .catch((caught: Error) => {
        if (!cancelled) setFailure({ key, message: caught.message });
      });
    return () => {
      cancelled = true;
    };
  }, [key, version.id]);

  const preview = loaded?.key === key ? loaded.preview : null;
  const failed = failure?.key === key ? failure.message : null;

  function rollBack() {
    if (!preview) return;
    const shown = preview;
    setRestoreError(null);
    startTransition(async () => {
      try {
        const result = await requestJson<RestoreResult>(`/api/v1/config-history/${version.id}/restore`, jsonInit("POST"));
        setConfirmOpen(false);
        onRolledBack(result, shown);
      } catch (caught) {
        setRestoreError((caught as Error).message);
      }
    });
  }

  const changes = preview ? preview.hosts.length + preview.settings.length + preview.other.length : 0;

  return (
    <div ref={ref} id="rollback" tabIndex={-1} className="scroll-mt-6 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <SectionCard
        title={
          <span className="inline-flex items-center gap-2.5">
            <RotateCcw aria-hidden="true" className="h-[18px] w-[18px] text-muted-foreground" />
            Roll back to <span className="num">#{version.id}</span>
          </span>
        }
        divided={false}
        contentClassName="flex flex-col gap-3.5 px-5 pb-[18px]"
      >
        {failed && (
          <Banner tone="bad" title="The rollback preview could not be loaded.">
            {failed}
          </Banner>
        )}
        {!preview && !failed && <p className="m-0 text-[13px] text-soft">Working out what rolling back would change…</p>}
        {preview && (
          <RollbackSummary
            version={version}
            preview={preview}
            canRestore={canRestore}
            pending={pending}
            onRollBack={() => {
              setRestoreError(null);
              setConfirmOpen(true);
            }}
            onShowLiveDiff={onShowLiveDiff}
          />
        )}
      </SectionCard>

      <AppDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`Roll back to #${version.id}?`}
        submitLabel="Roll back"
        onSubmit={rollBack}
        isSubmitting={pending}
        maxWidth="md"
      >
        {preview && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="m-0">
              The configuration is replaced with version <span className="num">#{version.id}</span> from{" "}
              <span className="num">{fmt.dateTime(version.createdAt)}</span> and applied to Caddy on {describeReload(preview.reload)}. The live
              configuration is saved as a new version first, so you can undo this.
            </p>
            <p className="m-0 text-muted-foreground">
              <span className="num">{changes}</span> item{changes === 1 ? "" : "s"} change and <span className="num">{preview.undoes.length}</span> later
              version{preview.undoes.length === 1 ? " is" : "s are"} undone. Users, group members, sign-in settings and API tokens are not changed.
            </p>
            {restoreError && (
              <Banner tone="bad" title="The rollback failed." live>
                {restoreError}
              </Banner>
            )}
          </div>
        )}
      </AppDialog>
    </div>
  );
});
