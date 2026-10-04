// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, ClipboardCheck, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppDialog } from "@/components/ui/AppDialog";
import type { CampaignSummary, ReviewScope, ScheduleView } from "../types";
import { callApi, CampaignStatusPill, describeScope, Field, formatDateTime, formatDay, LOCKED_HINT } from "./shared";

type Option = { id: number; name: string };
type UserOption = { id: number; email: string; name: string | null };

type Props = {
  campaigns: CampaignSummary[];
  schedules: ScheduleView[];
  users: UserOption[];
  customRoles: Option[];
  groups: Option[];
  configurable: boolean;
  canWrite: boolean;
  editionLabel: string;
  /** Items the signed-in user has to decide. */
  myPending: number;
  /** When the page was rendered, for "due in N days". */
  now?: string;
};

type Form = {
  name: string;
  scopeType: "all" | "filter";
  roles: string[];
  customRoleIds: number[];
  groupIds: number[];
  reviewerIds: number[];
  repeat: boolean;
  dueDate: string;
  durationDays: string;
  intervalMonths: string;
};

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const EMPTY: Form = {
  name: "",
  scopeType: "all",
  roles: [],
  customRoleIds: [],
  groupIds: [],
  reviewerIds: [],
  repeat: false,
  dueDate: "",
  durationDays: "14",
  intervalMonths: "3",
};

function toggle<T>(list: T[], value: T, on: boolean): T[] {
  return on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
}

function CheckList<T extends string | number>({
  idPrefix,
  options,
  selected,
  onChange,
}: {
  idPrefix: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  if (options.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <div className="max-h-48 divide-y divide-line overflow-y-auto rounded-xl border border-line">
      {options.map((option) => {
        const id = `${idPrefix}-${option.value}`;
        return (
          <div key={String(option.value)} className="flex items-center gap-3 px-3 py-2">
            <Checkbox id={id} checked={selected.includes(option.value)} onCheckedChange={(checked) => onChange(toggle(selected, option.value, checked === true))} />
            <Label htmlFor={id} className="font-normal">{option.label}</Label>
          </div>
        );
      })}
    </div>
  );
}

export default function AccessReviewsClient(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [deletingSchedule, setDeletingSchedule] = useState<ScheduleView | null>(null);
  const editable = props.canWrite && props.configurable;
  const names = useMemo(() => ({
    customRoles: new Map(props.customRoles.map((role) => [role.id, role.name])),
    groups: new Map(props.groups.map((group) => [group.id, group.name])),
  }), [props.customRoles, props.groups]);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  function openForm() {
    setForm({ ...EMPTY, dueDate: inDays(14) });
    setError(null);
    setOpen(true);
  }

  function scopeOf(): ReviewScope {
    return form.scopeType === "all"
      ? { type: "all" }
      : { type: "filter", roles: form.roles as ("admin" | "user" | "viewer")[], customRoleIds: form.customRoleIds, groupIds: form.groupIds };
  }

  function start() {
    setError(null);
    startTransition(async () => {
      try {
        if (form.repeat) {
          await callApi("/api/v1/access-review-schedules", "POST", {
            name: form.name,
            scope: scopeOf(),
            reviewerIds: form.reviewerIds,
            durationDays: Number(form.durationDays),
            intervalMonths: Number(form.intervalMonths),
          });
          toast.success("Schedule created; the first review starts now");
        } else {
          if (!form.dueDate) throw new Error("Choose a due date");
          await callApi("/api/v1/access-reviews", "POST", {
            name: form.name,
            scope: scopeOf(),
            reviewerIds: form.reviewerIds,
            dueAt: new Date(`${form.dueDate}T23:59:59`).toISOString(),
          });
          toast.success("Access review started");
        }
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function setScheduleEnabled(schedule: ScheduleView, enabled: boolean) {
    startTransition(async () => {
      try {
        await callApi(`/api/v1/access-review-schedules/${schedule.id}`, "PUT", { enabled });
        toast.success(enabled ? "Schedule enabled" : "Schedule disabled");
      } catch (err) {
        toast.error((err as Error).message);
      }
      router.refresh();
    });
  }

  function deleteSchedule() {
    const schedule = deletingSchedule;
    if (!schedule) return;
    startTransition(async () => {
      try {
        await callApi(`/api/v1/access-review-schedules/${schedule.id}`, "DELETE");
        toast.success("Schedule deleted");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setDeletingSchedule(null);
      router.refresh();
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Identity", "Access reviews"]}
        title="Access reviews"
        description="Reviewers confirm or revoke each user's dashboard account, role, group memberships and API tokens. Every campaign leaves a downloadable record."
        actions={props.canWrite ? (
          <Button onClick={openForm} disabled={!props.configurable} title={props.configurable ? undefined : LOCKED_HINT}>
            <Plus /> Start review
          </Button>
        ) : undefined}
      />

      {!props.configurable && (
        <Banner tone="info" title="Read-only without a license.">
          Starting and scheduling access reviews needs a license with access reviews ({props.editionLabel} edition). Open reviews can
          still be decided, completed, cancelled and deleted, and schedules disabled.{" "}
          <Link href="/license" className="text-brand underline-offset-4 hover:underline">Licensing</Link>
        </Banner>
      )}

      {props.myPending > 0 && (
        <Banner
          tone="info"
          icon={ClipboardCheck}
          title={`You have ${props.myPending} item${props.myPending === 1 ? "" : "s"} to review.`}
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href="/my-reviews">Open my reviews</Link>
            </Button>
          }
        />
      )}

      <SectionCard
        title="Campaigns"
        count={props.campaigns.length}
        description="Nobody reviews their own access. Revocations apply when the reviewer confirms."
      >
        {props.campaigns.length === 0 ? (
          <EmptyState
            compact
            icon={ClipboardCheck}
            title="No access review yet"
            description="Start one to have reviewers confirm who still needs their access."
            action={props.canWrite && props.configurable ? <Button size="sm" onClick={openForm}><Plus /> Start review</Button> : undefined}
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Reviewers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.campaigns.map((campaign) => {
                const decided = campaign.counts.total - campaign.counts.pending;
                const share = campaign.counts.total ? (decided / campaign.counts.total) * 100 : 0;
                return (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/access-reviews/${campaign.id}`} className="text-foreground underline-offset-4 hover:underline">{campaign.name}</Link>
                        {campaign.scheduleId !== null && <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] font-normal text-muted-foreground">Scheduled</span>}
                      </span>
                    </TableCell>
                    <TableCell><CampaignStatusPill campaign={campaign} now={props.now} /></TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        <span>
                          <span className="num">{decided} of {campaign.counts.total}</span> decided
                          {campaign.counts.revoked > 0 && <span className="text-muted-foreground"> · <span className="num">{campaign.counts.revoked}</span> revoked</span>}
                        </span>
                        <span aria-hidden="true" className="block h-1 w-28 overflow-hidden rounded-sm bg-raise">
                          <span className="block h-1 bg-ok" style={{ width: `${share}%` }} />
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="num">{formatDay(campaign.dueAt)}</TableCell>
                    <TableCell className="text-[13px]">{describeScope(campaign.scope, names)}</TableCell>
                    <TableCell className="text-[13px]">{campaign.reviewers.map((reviewer) => reviewer.name || reviewer.email || `#${reviewer.id}`).join(", ")}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard
        title="Schedules"
        count={props.schedules.length}
        description="Recurring reviews start a new campaign every few months. Turn on Repeat in Start review to create one."
      >
        {props.schedules.length === 0 ? (
          <EmptyState compact icon={CalendarClock} title="No schedule" description="A schedule starts the same review every few months, so nobody has to remember." />
        ) : (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Every</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Enabled</TableHead>
                {props.canWrite && <TableHead className="text-right">Delete</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.schedules.map((schedule) => (
                <TableRow key={schedule.id}>
                  <TableCell className="font-medium">
                    {schedule.name}
                    <div className="text-xs font-normal text-muted-foreground">{describeScope(schedule.scope, names)}</div>
                  </TableCell>
                  <TableCell>{schedule.intervalMonths} month{schedule.intervalMonths === 1 ? "" : "s"}, {schedule.durationDays} days to review</TableCell>
                  <TableCell className="num">{schedule.enabled ? formatDateTime(schedule.nextRunAt) : "—"}</TableCell>
                  <TableCell>
                    <span className="num">{formatDateTime(schedule.lastRunAt)}</span>
                    {schedule.lastError && <div className="text-xs text-bad">{schedule.lastError}</div>}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={schedule.enabled}
                      onCheckedChange={(checked) => setScheduleEnabled(schedule, checked)}
                      disabled={!props.canWrite || pending || (!props.configurable && !schedule.enabled)}
                      aria-label={`${schedule.name} enabled`}
                    />
                  </TableCell>
                  {props.canWrite && (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon-sm" className="text-bad hover:text-bad" title="Delete" aria-label={`Delete schedule ${schedule.name}`} onClick={() => setDeletingSchedule(schedule)} disabled={pending}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <AppDialog open={open} onClose={() => setOpen(false)} title="Start an access review" submitLabel={form.repeat ? "Create schedule" : "Start"} onSubmit={start} isSubmitting={pending} maxWidth="lg">
        <div className="flex flex-col gap-4">
          {error && <Banner tone="bad" live>{error}</Banner>}
          <Field label="Name" htmlFor="review-name">
            <Input id="review-name" value={form.name} maxLength={100} placeholder="Quarterly access review" onChange={(event) => set("name", event.target.value)} />
          </Field>
          <Field label="Who is reviewed" hint="Every access of the users in scope is reviewed: account, role, groups and API tokens.">
            <div className="flex gap-4">
              {(["all", "filter"] as const).map((type) => (
                <label key={type} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="scope-type" checked={form.scopeType === type} onChange={() => set("scopeType", type)} />
                  {type === "all" ? "All active users" : "Users with chosen roles or groups"}
                </label>
              ))}
            </div>
          </Field>
          {form.scopeType === "filter" && (
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Built-in roles">
                <CheckList idPrefix="scope-role" options={[{ value: "admin", label: "Admin" }, { value: "user", label: "User" }, { value: "viewer", label: "Viewer" }]} selected={form.roles} onChange={(next) => set("roles", next)} />
              </Field>
              <Field label="Custom roles">
                <CheckList idPrefix="scope-custom" options={props.customRoles.map((role) => ({ value: role.id, label: role.name }))} selected={form.customRoleIds} onChange={(next) => set("customRoleIds", next)} />
              </Field>
              <Field label="Groups">
                <CheckList idPrefix="scope-group" options={props.groups.map((group) => ({ value: group.id, label: group.name }))} selected={form.groupIds} onChange={(next) => set("groupIds", next)} />
              </Field>
            </div>
          )}
          <Field label="Reviewers" hint="Any active user can review; reviewers see the review under My reviews. A reviewer in scope needs another reviewer for their own access.">
            <CheckList idPrefix="reviewer" options={props.users.map((user) => ({ value: user.id, label: user.name ? `${user.name} (${user.email})` : user.email }))} selected={form.reviewerIds} onChange={(next) => set("reviewerIds", next)} />
          </Field>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="review-repeat" className="flex flex-col items-start gap-1">
              <span>Repeat</span>
              <span className="text-xs font-normal text-muted-foreground">Start the first review now and a new one every few months.</span>
            </Label>
            <Switch id="review-repeat" checked={form.repeat} onCheckedChange={(checked) => set("repeat", checked)} />
          </div>
          {form.repeat ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Every (months)" htmlFor="review-interval">
                <Input id="review-interval" inputMode="numeric" value={form.intervalMonths} onChange={(event) => set("intervalMonths", event.target.value)} />
              </Field>
              <Field label="Days to review" htmlFor="review-duration">
                <Input id="review-duration" inputMode="numeric" value={form.durationDays} onChange={(event) => set("durationDays", event.target.value)} />
              </Field>
            </div>
          ) : (
            <Field label="Due" htmlFor="review-due">
              <Input id="review-due" type="date" value={form.dueDate} min={inDays(1)} onChange={(event) => set("dueDate", event.target.value)} />
            </Field>
          )}
          {!editable && <p className="text-xs text-muted-foreground">{LOCKED_HINT}</p>}
        </div>
      </AppDialog>

      <AppDialog open={deletingSchedule !== null} onClose={() => setDeletingSchedule(null)} title={`Delete schedule "${deletingSchedule?.name ?? ""}"?`} submitLabel="Delete" onSubmit={deleteSchedule} isSubmitting={pending}>
        <p className="text-sm text-muted-foreground">No new campaign will start. Campaigns it already started stay.</p>
      </AppDialog>
    </div>
  );
}
