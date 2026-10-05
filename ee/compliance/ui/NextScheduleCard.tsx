// SPDX-License-Identifier: Elastic-2.0
"use client";

import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { ReportScheduleView } from "../schedules";
import { REPORT_TYPE_LABELS } from "../types";
import { describeScheduleTiming, periodText, untilText } from "./format";

/** The enabled schedule that runs next, with what it will cover. */
export default function NextScheduleCard({
  schedules,
  now,
  canWrite,
  onOpenSchedules,
}: {
  schedules: ReportScheduleView[];
  now: number;
  canWrite: boolean;
  onOpenSchedules: () => void;
}) {
  const format = useFormat();
  const upcoming = schedules
    .filter((schedule) => schedule.enabled && schedule.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
  const next = upcoming[0] ?? null;
  const others = upcoming.length - 1;

  return (
    <SectionCard
      title="Next scheduled report"
      divided={false}
      className="flex min-w-0 flex-[1_1_340px] flex-col"
      contentClassName="flex flex-1 flex-col gap-3 px-5 pb-[18px]"
      actions={
        <Button variant="link" size="sm" className="h-auto px-0" onClick={onOpenSchedules}>
          {schedules.length > 0 ? "Edit schedules" : "Schedules"}
        </Button>
      }
    >
      {next ? (
        <>
          <div className="flex items-start gap-3.5">
            <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-raise text-muted-foreground">
              <CalendarClock className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-base leading-6 font-semibold [overflow-wrap:anywhere]">{next.name}</span>
              <span>
                <span className="num">{format.dateTime(next.nextRunAt!)}</span>{" "}
                <span className="text-soft">· {untilText(next.nextRunAt!, now)}</span>
              </span>
            </span>
          </div>
          <p className="m-0 text-[13px] text-muted-foreground">
            {next.nextPeriod ? `Covers ${periodText(next.nextPeriod)}. ` : ""}
            {describeScheduleTiming(next)}.
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {next.reportTypes.map((type) => (
              <li key={type} className="inline-flex h-6 items-center rounded-full border border-line2 px-2.5 text-xs text-muted-foreground">
                {REPORT_TYPE_LABELS[type]}
              </li>
            ))}
            {next.questions.length > 0 && (
              <li className="inline-flex h-6 items-center rounded-full border border-line2 px-2.5 text-xs text-muted-foreground">
                {REPORT_TYPE_LABELS.traffic_questions} ({next.questions.length})
              </li>
            )}
          </ul>
          {others > 0 && (
            <p className="m-0 text-xs text-soft">
              {others} more schedule{others === 1 ? "" : "s"} set up.
            </p>
          )}
        </>
      ) : (
        <EmptyState
          compact
          icon={CalendarClock}
          className="px-0 py-1"
          title={schedules.length > 0 ? "Every schedule is turned off" : "No report schedule"}
          action={
            canWrite ? (
              <Button variant="secondary" size="sm" onClick={onOpenSchedules}>
                {schedules.length > 0 ? "Review the schedules" : "Set up a schedule"}
              </Button>
            ) : undefined
          }
        />
      )}
    </SectionCard>
  );
}
