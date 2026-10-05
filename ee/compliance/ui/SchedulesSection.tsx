// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { ReportScheduleView, ScheduleRunResult } from "../schedules";
import { REPORT_TYPE_LABELS, SELECTABLE_REPORT_TYPES, type SelectableReportType } from "../types";
import type { ChannelChoice, QuestionChoice } from "./ComplianceClient";
import { describeScheduleTiming, periodText, untilText, WEEKDAY_LABELS, WEEKDAY_ORDER } from "./format";
import { callApi, Field, LOCKED_HINT } from "./shared";

type Frequency = "weekly" | "monthly";

type Form = {
  name: string;
  enabled: boolean;
  frequency: Frequency;
  weekday: string;
  dayOfMonth: string;
  time: string;
  timeZone: string;
  reportTypes: SelectableReportType[];
  questionIds: number[];
  channelIds: number[];
};

const RUN_TONE: Record<NonNullable<ReportScheduleView["lastStatus"]>, StatusTone> = { success: "ok", partial: "warn", failed: "bad" };
const RUN_LABEL: Record<NonNullable<ReportScheduleView["lastStatus"]>, string> = { success: "Generated", partial: "Partly generated", failed: "Failed" };

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function emptyForm(): Form {
  return {
    name: "",
    enabled: true,
    frequency: "monthly",
    weekday: "monday",
    dayOfMonth: "1",
    time: "06:00",
    timeZone: browserTimeZone(),
    reportTypes: [...SELECTABLE_REPORT_TYPES],
    questionIds: [],
    channelIds: [],
  };
}

function formOf(schedule: ReportScheduleView): Form {
  return {
    name: schedule.name,
    enabled: schedule.enabled,
    frequency: schedule.frequency,
    weekday: schedule.weekday ?? "monday",
    dayOfMonth: String(schedule.dayOfMonth ?? 1),
    time: schedule.time,
    timeZone: schedule.timeZone,
    reportTypes: schedule.reportTypes,
    questionIds: schedule.questions.map((question) => question.savedQuestionId).filter((id): id is number => id !== null),
    channelIds: schedule.channelIds,
  };
}

function bodyOf(form: Form): Record<string, unknown> {
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    frequency: form.frequency,
    ...(form.frequency === "weekly" ? { weekday: form.weekday } : { dayOfMonth: Number(form.dayOfMonth) }),
    time: form.time.trim(),
    timeZone: form.timeZone.trim(),
    reportTypes: form.reportTypes,
    questionIds: form.questionIds,
    channelIds: form.channelIds,
  };
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Saved questions offered: the ones the user can see, and those already copied into the schedule. */
function questionOptions(schedule: ReportScheduleView | null, questions: QuestionChoice[]): (QuestionChoice & { copyOnly: boolean })[] {
  const offered = questions.map((question) => ({ ...question, copyOnly: false }));
  for (const copy of schedule?.questions ?? []) {
    if (copy.savedQuestionId !== null && !questions.some((question) => question.id === copy.savedQuestionId)) {
      offered.push({ id: copy.savedQuestionId, question: copy.question, interpretation: copy.interpretation, copyOnly: true });
    }
  }
  return offered;
}

function ScheduleDialog({
  schedule,
  channels,
  questions,
  onClose,
  onSaved,
}: {
  schedule: ReportScheduleView | null;
  channels: ChannelChoice[];
  questions: QuestionChoice[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<Form>(() => (schedule ? formOf(schedule) : emptyForm()));
  const [error, setError] = useState<string | null>(null);
  // Notices go to every channel type except PagerDuty, which pages people.
  const offered = channels.filter((channel) => channel.type !== "pagerduty" || form.channelIds.includes(channel.id));
  const questionChoices = questionOptions(schedule, questions);

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        if (schedule) await callApi(`/schedules/${schedule.id}`, "PUT", bodyOf(form));
        else await callApi("/schedules", "POST", bodyOf(form));
        toast.success(schedule ? "Schedule saved" : "Schedule set up");
        onSaved();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <AppDialog open onClose={onClose} title={schedule ? `Edit “${schedule.name}”` : "New report schedule"} maxWidth="lg" submitLabel={schedule ? "Save" : "Set up"} onSubmit={save} isSubmitting={pending}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Name" htmlFor="schedule-name">
            <Input id="schedule-name" value={form.name} maxLength={100} placeholder="Monthly evidence" onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} aria-label="Enabled" />
            Enabled
          </label>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Runs</span>
          <SegmentedControl
            label="Frequency"
            value={form.frequency}
            onChange={(frequency) => setForm({ ...form, frequency })}
            options={[
              { value: "monthly", label: "Every month" },
              { value: "weekly", label: "Every week" },
            ]}
          />
          <p className="m-0 text-xs text-muted-foreground">
            {form.frequency === "monthly" ? "Each run covers the previous calendar month." : "Each run covers the seven days before the day it runs."}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {form.frequency === "weekly" ? (
            <Field label="On" htmlFor="schedule-weekday">
              <Select value={form.weekday} onValueChange={(weekday) => setForm({ ...form, weekday })}>
                <SelectTrigger id="schedule-weekday" aria-label="Weekday">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAY_ORDER.map((day) => (
                    <SelectItem key={day} value={day}>
                      {WEEKDAY_LABELS[day]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <Field label="On day" htmlFor="schedule-day" hint="1 to 28">
              <Input id="schedule-day" inputMode="numeric" value={form.dayOfMonth} onChange={(event) => setForm({ ...form, dayOfMonth: event.target.value })} />
            </Field>
          )}
          <Field label="At" htmlFor="schedule-time" hint="24-hour, HH:MM">
            <Input id="schedule-time" value={form.time} placeholder="06:00" onChange={(event) => setForm({ ...form, time: event.target.value })} />
          </Field>
          <Field label="Time zone" htmlFor="schedule-zone">
            <Input id="schedule-zone" value={form.timeZone} onChange={(event) => setForm({ ...form, timeZone: event.target.value })} />
          </Field>
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">Reports</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {SELECTABLE_REPORT_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.reportTypes.includes(type)} onCheckedChange={() => setForm({ ...form, reportTypes: toggle(form.reportTypes, type) })} />
                {REPORT_TYPE_LABELS[type]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">Traffic questions</legend>
          {questionChoices.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">
              No saved questions yet. Ask one on the Analytics page (or with Ask about traffic above) and save it to add it here.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {questionChoices.map((question) => (
                <label key={question.id} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={form.questionIds.includes(question.id)}
                    onCheckedChange={() => setForm({ ...form, questionIds: toggle(form.questionIds, question.id) })}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="[overflow-wrap:anywhere]">{question.question}</span>
                    <span className="text-xs text-soft [overflow-wrap:anywhere]">
                      {question.interpretation}
                      {question.copyOnly ? " · the copy kept in this schedule (the saved question is deleted or not shared with you)" : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">Notice to</legend>
          {offered.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">No alert channels yet; add one on the Alerts page.</p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {offered.map((channel) => (
                <label key={channel.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.channelIds.includes(channel.id)} onCheckedChange={() => setForm({ ...form, channelIds: toggle(form.channelIds, channel.id) })} />
                  {channel.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
      </div>
    </AppDialog>
  );
}

/** Report schedules: evidence packs every week or month. */
export default function SchedulesSection({
  schedules,
  channels,
  questions,
  canWrite,
  configurable,
  now,
}: {
  schedules: ReportScheduleView[];
  channels: ChannelChoice[];
  questions: QuestionChoice[];
  canWrite: boolean;
  configurable: boolean;
  now: number;
}) {
  const router = useRouter();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<ReportScheduleView | "new" | null>(null);
  const [deleting, setDeleting] = useState<ReportScheduleView | null>(null);
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const canConfigure = canWrite && configurable;

  function setEnabled(schedule: ReportScheduleView, enabled: boolean) {
    startTransition(async () => {
      try {
        await callApi(`/schedules/${schedule.id}`, "PUT", { enabled });
        toast.success(enabled ? `“${schedule.name}” turned on` : `“${schedule.name}” turned off`);
      } catch (err) {
        toast.error((err as Error).message);
      }
      router.refresh();
    });
  }

  function runNow(schedule: ReportScheduleView) {
    startTransition(async () => {
      try {
        const result = await callApi<ScheduleRunResult>(`/schedules/${schedule.id}/run`, "POST");
        const text = `${result.reports.length} report${result.reports.length === 1 ? "" : "s"} for ${periodText(result.period)}`;
        if (result.status === "success") toast.success(`Generated ${text}`);
        else toast.warning(`Generated ${text}; ${result.failed.length} could not be generated`);
      } catch (err) {
        toast.error((err as Error).message);
      }
      router.refresh();
    });
  }

  function remove() {
    const schedule = deleting;
    if (!schedule) return;
    startTransition(async () => {
      try {
        await callApi(`/schedules/${schedule.id}`, "DELETE");
        toast.success("Schedule deleted");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setDeleting(null);
      router.refresh();
    });
  }

  return (
    <SectionCard
      id="schedules"
      title="Report schedules"
      count={schedules.length}
      actions={
        canWrite && (
          <Button variant="secondary" size="sm" onClick={() => setEditing("new")} disabled={!configurable} title={configurable ? undefined : LOCKED_HINT}>
            <Plus />
            New schedule
          </Button>
        )
      }
    >
      {schedules.length === 0 ? (
        <EmptyState compact icon={CalendarClock} title="No report schedule" />
      ) : (
        <Table className="min-w-[1040px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Schedule</TableHead>
              <TableHead scope="col">When</TableHead>
              <TableHead scope="col">Next run</TableHead>
              <TableHead scope="col">Last run</TableHead>
              <TableHead scope="col">Notice to</TableHead>
              <TableHead scope="col">Enabled</TableHead>
              {canWrite && (
                <TableHead scope="col" className="w-[120px]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((schedule) => {
              const failedDeliveries = schedule.lastDeliveries.filter((delivery) => !delivery.ok);
              return (
                <TableRow key={schedule.id} className="align-top">
                  <TableCell className="align-top">
                    <span className="flex flex-col gap-1">
                      <span className="font-semibold">{schedule.name}</span>
                      <span className="flex flex-wrap gap-1">
                        {schedule.reportTypes.map((type) => (
                          <span key={type} className="inline-flex h-5 items-center rounded-full border border-line2 px-2 text-[11px] text-muted-foreground">
                            {REPORT_TYPE_LABELS[type]}
                          </span>
                        ))}
                        {schedule.questions.length > 0 && (
                          <span
                            className="inline-flex h-5 items-center rounded-full border border-line2 px-2 text-[11px] text-muted-foreground"
                            title={schedule.questions.map((question) => question.question).join("\n")}
                          >
                            {schedule.questions.length} traffic question{schedule.questions.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="align-top">{describeScheduleTiming(schedule)}</TableCell>
                  <TableCell className="align-top">
                    {schedule.enabled && schedule.nextRunAt ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="num whitespace-nowrap">{format.dateTime(schedule.nextRunAt)}</span>
                        <span className="text-xs text-soft">
                          {untilText(schedule.nextRunAt, now)}
                          {schedule.nextPeriod ? ` · covers ${periodText(schedule.nextPeriod)}` : ""}
                        </span>
                      </span>
                    ) : (
                      <span className="text-soft">Off</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {schedule.lastRunAt && schedule.lastStatus ? (
                      <span className="flex flex-col gap-0.5">
                        <StatusDot tone={RUN_TONE[schedule.lastStatus]} label={<>{RUN_LABEL[schedule.lastStatus]} <span className="num">{format.dateTime(schedule.lastRunAt)}</span></>} />
                        <span className="text-xs text-soft">
                          {schedule.lastReports.length} report{schedule.lastReports.length === 1 ? "" : "s"}
                          {failedDeliveries.length > 0 ? ` · notice failed to ${failedDeliveries.map((delivery) => delivery.channelName).join(", ")}` : ""}
                        </span>
                        {schedule.lastError && <span className="text-xs text-bad [overflow-wrap:anywhere]">{schedule.lastError}</span>}
                      </span>
                    ) : (
                      <span className="text-soft">Not run yet</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {schedule.channelIds.length === 0 ? (
                      <span className="text-soft">Nobody</span>
                    ) : (
                      schedule.channelIds.map((id) => channelNames.get(id) ?? `Channel #${id}`).join(", ")
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <Switch
                      checked={schedule.enabled}
                      // Turning a schedule off always works; turning it on needs the license.
                      disabled={!canWrite || pending || (!schedule.enabled && !configurable)}
                      title={!schedule.enabled && !configurable ? LOCKED_HINT : undefined}
                      onCheckedChange={(checked) => setEnabled(schedule, checked)}
                      aria-label={`Enable ${schedule.name}`}
                    />
                  </TableCell>
                  {canWrite && (
                    <TableCell className="align-top">
                      <span className="flex justify-end gap-0.5">
                        <Button variant="ghost" size="icon-sm" title={canConfigure ? "Run now" : LOCKED_HINT} aria-label={`Run ${schedule.name} now`} disabled={!canConfigure || pending} onClick={() => runNow(schedule)}>
                          <Play />
                        </Button>
                        <Button variant="ghost" size="icon-sm" title={canConfigure ? "Edit" : LOCKED_HINT} aria-label={`Edit ${schedule.name}`} disabled={!canConfigure} onClick={() => setEditing(schedule)}>
                          <Pencil />
                        </Button>
                        <Button variant="ghost" size="icon-sm" title="Delete" aria-label={`Delete ${schedule.name}`} onClick={() => setDeleting(schedule)}>
                          <Trash2 />
                        </Button>
                      </span>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {editing !== null && (
        <ScheduleDialog
          schedule={editing === "new" ? null : editing}
          channels={channels}
          questions={questions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      <AppDialog open={deleting !== null} onClose={() => setDeleting(null)} title="Delete schedule" submitLabel="Delete" onSubmit={remove} isSubmitting={pending}>
        <p className="text-sm">Delete “{deleting?.name}”? The reports it generated are kept.</p>
      </AppDialog>
    </SectionCard>
  );
}
