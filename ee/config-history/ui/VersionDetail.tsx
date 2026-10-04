// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { DiffView, type DiffMode } from "@/components/ui/DiffView";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBytes } from "@/components/ui/chart-format";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { VersionComparison, VersionView } from "@/ee/config-history/versions";
import { requestJson } from "@/src/lib/request-json";
import {
  REASON_LONG,
  compareQuery,
  describeActors,
  emptyCompareText,
  groupTitle,
  leadActor,
  toDiffField,
  type CompareTarget,
} from "./history-format";
import { Avatar, LivePill, ReasonPill } from "./VersionTimeline";

const GROUPS_SHOWN = 40;

type Props = {
  version: VersionView;
  /** Other versions to compare with (this page's). */
  others: VersionView[];
  compare: CompareTarget;
  onCompare: (target: CompareTarget) => void;
  canDelete: boolean;
  onDelete: () => void;
  /** Changes when the configuration changed (a rollback, a new version), to compare again. */
  reloadKey: number;
};

function sideLabel(side: VersionComparison["from"]): string {
  if (side.kind === "current") return "Live";
  if (side.kind === "empty") return "Nothing";
  return `#${side.id}`;
}

/** The selected version: what it is, who made it, and what changed against another version or the live configuration. */
export function VersionDetail({ version, others, compare, onCompare, canDelete, onDelete, reloadKey }: Props) {
  const fmt = useFormat();
  const headingId = useId();
  // The live version has nothing to compare with the live configuration, nor a version with itself.
  const target: CompareTarget = (compare === "live" && version.live) || compare === version.id ? "previous" : compare;
  const [mode, setMode] = useState<DiffMode>("unified");
  const [result, setResult] = useState<{ key: string; comparison: VersionComparison } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const query = compareQuery(version.id, target);
  const key = `${query}|${reloadKey}`;

  useEffect(() => {
    let cancelled = false;
    requestJson<VersionComparison>(`/api/v1/config-history/compare?${query}`)
      .then((comparison) => {
        if (!cancelled) {
          setResult({ key, comparison });
          setError(null);
          setShowAll(false);
        }
      })
      .catch((caught: Error) => {
        if (!cancelled) setError({ key, message: caught.message });
      });
    return () => {
      cancelled = true;
    };
  }, [key, query]);

  const comparison = result?.key === key ? result.comparison : null;
  const failed = error?.key === key ? error.message : null;
  const loading = !comparison && !failed;
  const previousId = comparison && target === "previous" && comparison.from.kind === "snapshot" ? comparison.from.id : version.previousId;

  const segment = typeof target === "number" ? "other" : target;
  const otherChoices = others.filter((candidate) => candidate.id !== version.id);
  const who = describeActors(version.actors);

  let caption: string;
  if (target === "live") caption = `What rolling back to #${version.id} would change in the live configuration.`;
  else if (comparison?.from.kind === "empty") caption = `#${version.id} is the oldest version kept, so everything in it shows as added.`;
  else if (typeof target === "number") caption = `Changes from #${target} to #${version.id}. Timestamps are ignored and secrets are never shown.`;
  else caption = previousId !== null ? `Changes from #${previousId} to #${version.id}. Timestamps are ignored and secrets are never shown.` : "Changes in this version.";

  const beforeLabel = comparison ? sideLabel(comparison.from) : "Before";
  const afterLabel = `#${version.id}`;
  const groups = comparison?.groups ?? [];
  const shown = showAll ? groups : groups.slice(0, GROUPS_SHOWN);

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-col gap-1.5 border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-[13px] text-soft">Version #{version.id}</span>
          {version.live && <LivePill size="md" />}
          <ReasonPill reason={version.reason} label={REASON_LONG[version.reason]} size="md" />
          {canDelete && (
            <Button variant="ghost" size="sm" className="ml-auto text-bad hover:text-bad" onClick={onDelete}>
              <Trash2 /> Delete version
            </Button>
          )}
        </div>
        <h2 id={headingId} className="m-0 text-lg font-semibold leading-[26px] tracking-[-0.01em] [overflow-wrap:anywhere]">
          {version.title}
        </h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={leadActor(version.actors)} size="md" />
            <span className="font-semibold text-foreground">{who}</span>
          </span>
          <span className="num">{fmt.dateTime(version.createdAt)}</span>
          {version.changeRequestIds.map((id) => (
            <Link key={id} href={`/approvals?request=${id}`} className="text-brand underline-offset-4 hover:text-foreground hover:underline">
              Approval request #{id}
            </Link>
          ))}
          <span>
            Change <span className="num text-foreground">{version.size}</span>
          </span>
          <span>
            Snapshot <span className="num">{formatBytes(version.sizeBytes)}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span>Compare with</span>
          <SegmentedControl
            size="sm"
            label="Compare with"
            value={segment}
            onChange={(value) => {
              if (value === "other") onCompare(otherChoices[0]?.id ?? "previous");
              else onCompare(value);
            }}
            options={[
              { value: "previous", label: "Previous version" },
              { value: "live", label: "Live configuration", disabled: version.live },
              { value: "other", label: "Another version", disabled: otherChoices.length === 0 },
            ]}
          />
          {typeof target === "number" && (
            <Select value={String(target)} onValueChange={(value) => onCompare(Number(value))}>
              <SelectTrigger aria-label="Version to compare with" className="h-8 w-[min(260px,100%)] text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {otherChoices.map((candidate) => (
                  <SelectItem key={candidate.id} value={String(candidate.id)}>
                    #{candidate.id} · {candidate.title.length > 60 ? `${candidate.title.slice(0, 59)}…` : candidate.title}
                  </SelectItem>
                ))}
                {!otherChoices.some((candidate) => candidate.id === target) && <SelectItem value={String(target)}>#{target}</SelectItem>}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground sm:ml-auto">
          <span>View</span>
          <SegmentedControl
            size="sm"
            label="Diff layout"
            value={mode}
            onChange={setMode}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Side by side" },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 px-5 pb-5 pt-4">
        <p className="m-0 text-[13px] text-muted-foreground">{caption}</p>
        {failed && (
          <Banner tone="bad" title="The comparison could not be loaded.">
            {failed}
          </Banner>
        )}
        {loading && <p className="m-0 text-[13px] text-soft">Comparing…</p>}
        {comparison && groups.length === 0 && (
          <p className="m-0 rounded-[10px] border border-dashed border-line2 px-4 py-3.5 text-[13px] text-muted-foreground">
            {emptyCompareText(version, target, previousId)}
          </p>
        )}
        {shown.map((group) => (
          <DiffView
            key={`${group.entity}:${group.id}`}
            mode={mode}
            fields={group.fields.map(toDiffField)}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
            label={groupTitle(group)}
            emptyText={`${groupTitle(group)}: no field changes`}
            title={
              <>
                <span>{group.entityLabel}</span>
                <span aria-hidden="true">›</span>
                <span className="num text-foreground [overflow-wrap:anywhere]">{group.label}</span>
                {group.kind !== "changed" && (
                  <span
                    className={
                      group.kind === "added"
                        ? "inline-flex h-[18px] items-center rounded-full bg-ok-tint px-1.5 text-[11px] font-semibold text-ok"
                        : "inline-flex h-[18px] items-center rounded-full bg-bad-tint px-1.5 text-[11px] font-semibold text-bad"
                    }
                  >
                    {group.kind === "added" ? "Added" : "Removed"}
                  </span>
                )}
              </>
            }
          />
        ))}
        {groups.length > shown.length && (
          <Button variant="secondary" size="sm" className="self-start" onClick={() => setShowAll(true)}>
            Show all <span className="num">{groups.length}</span> changed items
          </Button>
        )}
      </div>
    </section>
  );
}
