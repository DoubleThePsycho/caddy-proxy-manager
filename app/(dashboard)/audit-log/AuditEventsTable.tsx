"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DiffView, type DiffField, type DiffMode } from "@/components/ui/DiffView";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import type { CompareGroup } from "@/ee/config-history/versions";
import { getAuditEventDetailAction } from "./actions";
import {
  entityTypeLabel,
  isFailureAction,
  joinNames,
  shortHash,
  type AuditEventDetail,
  type AuditEventRow,
} from "@/src/lib/audit-log-view";
import type { AuditSinkSummary } from "@/ee/audit/ui/sink-view";

export type DetailState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; detail: AuditEventDetail };

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
  }
}

/** Event times with seconds, in the account's time zone: "3 Oct, 11:36:20" and "3 Oct 2026, 11:36:20". */
export function useEventTimes() {
  const { timeZone } = useFormat();
  return useMemo(() => {
    const short = formatter(timeZone, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const full = formatter(timeZone, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const safe = (format: Intl.DateTimeFormat) => (iso: string) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : format.format(date);
    };
    return { short: safe(short), full: safe(full), timeZone };
  }, [timeZone]);
}

function toDiffFields(group: CompareGroup): DiffField[] {
  return group.fields.map((field) => ({
    path: field.path,
    before: field.beforeLabel ?? field.before,
    after: field.afterLabel ?? field.after,
    secret: field.secret === true,
  }));
}

function ChangeDiff({ event, state, mode, onModeChange }: {
  event: AuditEventRow;
  state: DetailState | undefined;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
}) {
  const change = event.configChange!;
  const diff = state?.status === "ok" ? state.detail.configDiff : null;
  const fieldCount = diff ? diff.groups.reduce((sum, group) => sum + group.fields.length, 0) : 0;
  return (
    <div className="flex min-w-0 flex-[3_1_420px] flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">Before and after</h3>
        {change.beforeId !== null && change.afterId !== null && (
          <span className="text-xs text-soft">
            From configuration versions <span className="num">#{change.beforeId}</span> and <span className="num">#{change.afterId}</span>
            {diff?.available && diff.groups.length > 0 ? (
              <>
                ; <span className="num">{fieldCount}</span> {fieldCount === 1 ? "field" : "fields"} changed
              </>
            ) : null}
          </span>
        )}
        {diff?.available && diff.groups.length > 0 && (
          <SegmentedControl
            size="sm"
            label="Diff layout"
            className="ml-auto"
            value={mode}
            onChange={onModeChange}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Side by side" },
            ]}
          />
        )}
      </div>
      {!state || state.status === "loading" ? (
        <p className="m-0 text-[13px] text-muted-foreground">Loading the change…</p>
      ) : state.status === "error" ? null : change.pending ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          Waiting for the configuration version that applying this change records.
        </p>
      ) : !diff ? (
        <p className="m-0 text-[13px] text-muted-foreground">No before and after is kept for this event.</p>
      ) : !diff.available || diff.groups.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">{diff.reason ?? "Nothing in the configuration changed."}</p>
      ) : (
        <>
          {diff.groups.map((group) => (
            <DiffView
              key={`${group.entity}:${group.id}`}
              fields={toDiffFields(group)}
              mode={mode}
              beforeLabel={`#${diff.beforeId}`}
              afterLabel={`#${diff.afterId}`}
              label={`Changes to ${group.entityLabel} ${group.label}`}
              emptyText="No field changed."
              title={
                <>
                  <span>{group.entityLabel}</span>
                  <span aria-hidden="true">›</span>
                  <span className="num text-foreground">{group.label}</span>
                  {group.kind !== "changed" && (
                    <Badge variant={group.kind === "added" ? "success" : "destructive"}>{group.kind === "added" ? "Added" : "Removed"}</Badge>
                  )}
                </>
              }
            />
          ))}
          {diff.truncated && (
            <p className="m-0 text-xs text-soft">More changed than is listed here; the change history shows all of it.</p>
          )}
        </>
      )}
    </div>
  );
}

function RecordedData({ state }: { state: DetailState | undefined }) {
  const data = state?.status === "ok" ? state.detail.data : undefined;
  return (
    <div className="flex min-w-0 flex-[3_1_420px] flex-col gap-2.5">
      <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">Recorded with the event</h3>
      {!state || state.status === "loading" ? (
        <p className="m-0 text-[13px] text-muted-foreground">Loading…</p>
      ) : state.status === "error" ? null : data === null || data === undefined ? (
        <p className="m-0 text-[13px] text-muted-foreground">Nothing else was recorded with this event.</p>
      ) : (
        <pre className="num m-0 max-h-72 overflow-auto rounded-lg border border-line bg-background p-3 text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** The expanded part of an event row (exported for the render test). */
export function EventDetail({
  event,
  state,
  sinks,
  canHistory,
  canApprovals,
  mode,
  onModeChange,
}: {
  event: AuditEventRow;
  state: DetailState | undefined;
  sinks: AuditSinkSummary[] | null;
  canHistory: boolean;
  canApprovals: boolean;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
}) {
  const times = useEventTimes();
  const change = event.configChange;
  const previousId = state?.status === "ok" ? state.detail.previousEventId : null;
  const streamedTo = sinks?.filter((sink) => sink.lastDeliveredId >= event.id).map((sink) => sink.name) ?? [];
  const historyLink = canHistory && change?.afterId != null;
  const rollbackLink = canHistory && change?.beforeId != null && change.afterId != null && change.beforeId !== change.afterId;
  return (
    <div className="flex flex-col gap-3">
      {state?.status === "error" && <Banner tone="bad">{state.message}</Banner>}
      <div className="flex flex-wrap gap-4 rounded-xl border border-line2 bg-panel p-4">
        {change ? <ChangeDiff event={event} state={state} mode={mode} onModeChange={onModeChange} /> : <RecordedData state={state} />}
        <dl className="m-0 grid min-w-0 flex-[2_1_280px] grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-3.5 gap-y-2 text-[13px]">
          <dt className="text-soft">Recorded</dt>
          <dd className="num m-0">{times.full(event.createdAt)}</dd>
          <dt className="text-soft">Actor</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">
            {event.actor.name}
            {event.actor.email && event.actor.email !== event.actor.name && <span className="text-soft"> {event.actor.email}</span>}
          </dd>
          <dt className="text-soft">Entity</dt>
          <dd className="m-0">
            <span className="num">{event.entityType}</span>
            {event.entityId !== null && <span className="num text-soft"> #{event.entityId}</span>}
          </dd>
          <dt className="text-soft">Hash</dt>
          <dd className="num m-0 [overflow-wrap:anywhere]" title={event.hash ?? undefined}>
            {event.hash ? shortHash(event.hash) : "Recorded before the hash chain existed"}
          </dd>
          <dt className="text-soft">Previous</dt>
          <dd className="num m-0 [overflow-wrap:anywhere]" title={event.prevHash ?? undefined}>
            {shortHash(event.prevHash)}
            {previousId !== null && <span className="text-soft"> #{previousId}</span>}
          </dd>
          {sinks !== null && (
            <>
              <dt className="text-soft">Streamed</dt>
              <dd className="m-0">
                {sinks.length === 0 ? "No streaming destination" : streamedTo.length > 0 ? joinNames(streamedTo) : "Not delivered yet"}
              </dd>
            </>
          )}
          {change?.changeRequestId != null && (
            <>
              <dt className="text-soft">Approved in</dt>
              <dd className="m-0">
                {canApprovals ? (
                  <Link href={`/approvals?request=${change.changeRequestId}`} className="text-brand underline-offset-4 hover:underline">
                    Change request <span className="num">#{change.changeRequestId}</span>
                  </Link>
                ) : (
                  <>
                    Change request <span className="num">#{change.changeRequestId}</span>
                  </>
                )}
              </dd>
            </>
          )}
          {(historyLink || rollbackLink) && (
            <dd className="col-span-full m-0 mt-1 flex flex-wrap gap-2">
              {historyLink && (
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/history?version=${change!.afterId}`}>Open in change history</Link>
                </Button>
              )}
              {rollbackLink && (
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/history?version=${change!.beforeId}&rollback=1`}>Roll back this change</Link>
                </Button>
              )}
            </dd>
          )}
        </dl>
      </div>
    </div>
  );
}

export function AuditEventsTable({
  events,
  sinks,
  canHistory,
  canApprovals,
}: {
  events: AuditEventRow[];
  sinks: AuditSinkSummary[] | null;
  canHistory: boolean;
  canApprovals: boolean;
}) {
  const times = useEventTimes();
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const [mode, setMode] = useState<DiffMode>("unified");

  async function load(id: number) {
    setDetails((current) => ({ ...current, [id]: { status: "loading" } }));
    try {
      const outcome = await getAuditEventDetailAction(id);
      setDetails((current) => ({
        ...current,
        [id]: "error" in outcome ? { status: "error", message: outcome.error } : { status: "ok", detail: outcome.detail },
      }));
    } catch {
      setDetails((current) => ({ ...current, [id]: { status: "error", message: "The event could not be loaded. Try again." } }));
    }
  }

  function toggle(id: number) {
    const next = new Set(open);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      const state = details[id];
      if (!state || state.status === "error") void load(id);
    }
    setOpen(next);
  }

  return (
    <Table className="min-w-[1100px]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="first:pl-[18px]">Time</TableHead>
          <TableHead scope="col">Actor</TableHead>
          <TableHead scope="col">Action</TableHead>
          <TableHead scope="col">Entity</TableHead>
          <TableHead scope="col">Summary</TableHead>
          <TableHead scope="col" className="text-right">Event</TableHead>
          <TableHead scope="col" className="last:pr-[18px]">Change</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => {
          const expanded = open.has(event.id);
          const detailId = `audit-event-${event.id}-detail`;
          const label = event.configChange ? (expanded ? "Hide diff" : "Show diff") : expanded ? "Hide details" : "Details";
          return (
            <Fragment key={event.id}>
              <TableRow className={cn(expanded && "border-b-0 bg-panel2")}>
                <TableCell className="num whitespace-nowrap text-muted-foreground first:pl-[18px]">{times.short(event.createdAt)}</TableCell>
                <TableCell className={cn("max-w-[180px] truncate", event.actor.kind !== "user" && "text-muted-foreground")} title={event.actor.email ?? undefined}>
                  {event.actor.name}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "num inline-block max-w-[220px] truncate rounded px-1.5 align-middle text-xs leading-[18px]",
                      isFailureAction(event.action) ? "bg-warn-tint text-warn" : "bg-raise text-muted-foreground"
                    )}
                    title={event.action}
                  >
                    {event.action}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="text-muted-foreground">{entityTypeLabel(event.entityType)}</span>
                  {event.entityId !== null && <span className="num"> #{event.entityId}</span>}
                </TableCell>
                <TableCell className="min-w-[280px] [overflow-wrap:anywhere]">
                  {event.summary ?? <span className="text-muted-foreground">{`${event.action} on ${event.entityType}`}</span>}
                </TableCell>
                <TableCell className="num text-right text-soft">#{event.id}</TableCell>
                <TableCell className="last:pr-[18px]">
                  <button
                    type="button"
                    onClick={() => toggle(event.id)}
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    aria-label={`${label}, event ${event.id}`}
                    className={cn(
                      "inline-flex items-center gap-1 whitespace-nowrap rounded text-[13px] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      event.configChange ? "text-brand" : "text-muted-foreground"
                    )}
                  >
                    {label}
                    <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                  </button>
                </TableCell>
              </TableRow>
              {expanded && (
                <TableRow id={detailId} className="bg-panel2 hover:bg-panel2">
                  <TableCell colSpan={7} className="pt-1 pb-[18px] first:pl-[18px] last:pr-[18px]">
                    <EventDetail
                      event={event}
                      state={details[event.id]}
                      sinks={sinks}
                      canHistory={canHistory}
                      canApprovals={canApprovals}
                      mode={mode}
                      onModeChange={setMode}
                    />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
