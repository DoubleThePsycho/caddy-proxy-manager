// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, FileDown, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { cn } from "@/lib/utils";
import { ASSESSMENT_QUESTIONS, CLASSIFICATION_LABELS, NOTIFICATION_STATUS_LABELS } from "../incident-register";
import type { IncidentSummaryView, IncidentView } from "../types";
import { CLASSIFICATION_BADGE, NOTIFICATION_TONE, durationText, untilText } from "./format";
import { AssessDialog, ConfirmIncidentDelete, RecordIncidentDialog, TimelineEntryDialog } from "./IncidentDialogs";
import { callApi, LOCKED_HINT } from "./shared";

export type DraftSources = {
  alertEvents: { id: number; at: string; severity: string; status: string; title: string }[];
  proxyHosts: { id: number; name: string }[];
};

const ANSWER_LABELS = { yes: "Yes", no: "No", unknown: "Not known yet" } as const;

function sameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10);
}

function WindowCell({ incident }: { incident: Pick<IncidentSummaryView, "startedAt" | "endedAt"> }) {
  const format = useFormat();
  if (!incident.startedAt && !incident.endedAt) return <span className="text-soft">Not recorded</span>;
  if (incident.startedAt && !incident.endedAt) {
    return (
      <span>
        From <span className="num">{format.dateTime(incident.startedAt)}</span>, <span className="text-warn">ongoing</span>
      </span>
    );
  }
  if (!incident.startedAt) {
    return (
      <span>
        Ended <span className="num">{format.dateTime(incident.endedAt!)}</span>
      </span>
    );
  }
  return (
    <span className="num">
      {format.dateTime(incident.startedAt)} to {sameDay(incident.startedAt, incident.endedAt!) ? format.time(incident.endedAt!) : format.dateTime(incident.endedAt!)}
    </span>
  );
}

function NotificationCell({ incident, now }: { incident: IncidentSummaryView; now: number }) {
  const format = useFormat();
  if (incident.notification === "required" && incident.nextDeadline) {
    const { nextDeadline } = incident;
    return (
      <span className={cn("flex flex-col gap-0.5", nextDeadline.overdue ? "text-bad" : "text-warn")}>
        <span>{nextDeadline.label}</span>
        <span className="text-xs">
          {nextDeadline.overdue ? "Overdue since " : "Due "}
          <span className="num">{format.dateTime(nextDeadline.at)}</span>
          {!nextDeadline.overdue && ` · ${untilText(nextDeadline.at, now)}`}
        </span>
      </span>
    );
  }
  return <span className={NOTIFICATION_TONE[incident.notification]}>{NOTIFICATION_STATUS_LABELS[incident.notification]}</span>;
}

/** Everything recorded about one incident: timeline, assessment, classification and the actions on it. */
function IncidentDetail({
  id,
  canWrite,
  onChanged,
  onDeleted,
}: {
  id: number;
  canWrite: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const format = useFormat();
  const { productName } = useBranding();
  const [incident, setIncident] = useState<IncidentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<"assess" | "timeline" | "delete" | null>(null);

  const load = useCallback(() => {
    setError(null);
    callApi<IncidentView>(`/incidents/${id}`)
      .then(setIncident)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function updated(next: IncidentView, message: string) {
    setIncident(next);
    setDialog(null);
    toast.success(message);
    onChanged();
  }

  function setStatus(status: "open" | "closed") {
    startTransition(async () => {
      try {
        updated(await callApi<IncidentView>(`/incidents/${id}`, "PUT", { status }), status === "closed" ? "Incident closed" : "Incident reopened");
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }

  if (error) {
    return (
      <Banner tone="bad" actions={<Button variant="secondary" size="sm" onClick={load}>Try again</Button>}>
        {error}
      </Banner>
    );
  }
  if (!incident) return <p className="m-0 px-1 py-2 text-[13px] text-muted-foreground">Loading the incident…</p>;

  const deciding = ASSESSMENT_QUESTIONS.filter((question) => question.decides);
  const informing = ASSESSMENT_QUESTIONS.filter((question) => !question.decides);
  const earlyWarning = incident.stages.find((stage) => stage.key === "early_warning");
  const classifiedBy = incident.classifiedBy?.name ?? (incident.classifiedBy?.userId ? `user #${incident.classifiedBy.userId}` : null);

  return (
    <div id={`incident-detail-${id}`} className="flex flex-col gap-4">
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))]">
        <section aria-labelledby={`incident-${id}-timeline`} className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-panel px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`incident-${id}-timeline`} className="m-0 text-sm font-semibold">
              Timeline
            </h3>
            {canWrite && (
              <Button variant="link" size="sm" className="ml-auto h-auto px-0" onClick={() => setDialog("timeline")}>
                Add an entry
              </Button>
            )}
          </div>
          <span className="text-xs text-soft">
            Figures {productName} collected are aggregated: never log lines, client addresses or request contents.
          </span>
          <ol className="m-0 flex list-none flex-col p-0">
            {incident.timeline.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex gap-2.5 border-t border-line py-2 text-[13px]">
                <span className="num w-[150px] shrink-0 text-soft">{format.dateTime(entry.at)}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{entry.text}</span>
                {entry.source === "facts" && <span className="shrink-0 self-start rounded-full border border-line2 px-1.5 text-[11px] leading-[18px] text-soft">Collected</span>}
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby={`incident-${id}-assessment`} className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-panel px-4 py-3.5">
          <h3 id={`incident-${id}-assessment`} className="m-0 text-sm font-semibold">
            Is it significant? NIS2 Art. 23(3)
          </h3>
          <dl className="m-0 flex flex-col">
            {[...deciding, ...informing].map((question) => {
              const answer = incident.assessment[question.key];
              return (
                <div key={question.key} className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-line py-2 text-[13px]">
                  <dt className="min-w-0 flex-[1_1_220px]">
                    {question.question}
                    <span className="block text-xs text-soft">{question.legalBasis}{question.decides ? "" : ", for the early warning"}</span>
                  </dt>
                  <dd className="m-0 min-w-0 flex-[1_1_200px] text-muted-foreground">
                    <span className={cn("font-semibold", answer.answer === "unknown" ? "text-soft" : "text-foreground")}>{ANSWER_LABELS[answer.answer]}</span>
                    {answer.reason && <> · {answer.reason}</>}
                  </dd>
                </div>
              );
            })}
          </dl>
          {incident.suggestedClassification !== incident.classification && incident.suggestedClassification !== "undetermined" && (
            <p className="m-0 text-xs text-muted-foreground">
              The answers suggest: <span className="font-semibold text-foreground">{CLASSIFICATION_LABELS[incident.suggestedClassification].toLowerCase()}</span>. The
              classification stays a person&apos;s decision.
            </p>
          )}
        </section>
      </div>

      <div className="flex gap-3 rounded-xl border border-line2 bg-panel2 px-3.5 py-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold">
            {incident.classification === "undetermined"
              ? "Not assessed yet. Answer the questions above and classify the incident."
              : `Classified ${CLASSIFICATION_LABELS[incident.classification].toLowerCase()}${classifiedBy ? ` by ${classifiedBy}` : ""}${incident.classifiedAt ? ` on ${format.dateTime(incident.classifiedAt)}` : ""}.`}{" "}
            {incident.classification === "significant"
              ? incident.notification === "submitted"
                ? "Every notification stage is submitted."
                : `Notification is required${earlyWarning && !earlyWarning.submittedAt ? `: the early warning is due ${format.dateTime(earlyWarning.deadline)}` : ""}.`
              : incident.classification === "not_significant"
                ? "No notification is due."
                : ""}
          </span>
          <span className="text-[13px] whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
            {incident.cause ? `Cause: ${incident.cause}` : "No cause recorded yet."}
            {incident.closedAt ? ` Closed ${format.dateTime(incident.closedAt)}.` : ""}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {canWrite && (
          <Button variant="secondary" size="sm" onClick={() => setDialog("assess")}>
            Assess and classify
          </Button>
        )}
        <Button asChild variant="secondary" size="sm">
          <Link href={`/compliance/incidents/${id}`}>{incident.classification === "significant" ? "Notification draft" : "Open the record"}</Link>
        </Button>
        <Button asChild variant="secondary" size="sm">
          <a href={`/print/compliance/incidents/${id}`} target="_blank" rel="noopener">
            <FileDown />
            Download record (PDF)
          </a>
        </Button>
        {canWrite && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setStatus(incident.status === "closed" ? "open" : "closed")}>
            {incident.status === "closed" ? "Reopen" : "Close the incident"}
          </Button>
        )}
        {canWrite && (
          <Button variant="ghost" size="sm" className="text-bad" onClick={() => setDialog("delete")}>
            Delete
          </Button>
        )}
      </div>

      {dialog === "assess" && <AssessDialog incident={incident} onClose={() => setDialog(null)} onSaved={(next) => updated(next, "Assessment saved")} />}
      {dialog === "timeline" && <TimelineEntryDialog incident={incident} onClose={() => setDialog(null)} onSaved={(next) => updated(next, "Entry added")} />}
      {dialog === "delete" && (
        <ConfirmIncidentDelete
          incident={incident}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            onDeleted();
          }}
        />
      )}
    </div>
  );
}

/** The incident register: every security event, significant or not, with its NIS2 Article 23 assessment. */
export default function IncidentRegister({
  page,
  sources,
  canWrite,
  configurable,
  initialOpenId,
  now,
}: {
  /** A page of the register, newest first. */
  page: { incidents: IncidentSummaryView[]; total: number; page: number; perPage: number };
  sources: DraftSources;
  canWrite: boolean;
  configurable: boolean;
  initialOpenId: number | null;
  now: number;
}) {
  const router = useRouter();
  const format = useFormat();
  const [openId, setOpenId] = useState<number | null>(initialOpenId);
  const [recording, setRecording] = useState(false);
  const { hrefFor } = useUrlPage("incidentPage");
  const incidents = page.incidents;

  useEffect(() => {
    if (initialOpenId !== null) document.getElementById(`incident-row-${initialOpenId}`)?.scrollIntoView({ block: "center" });
  }, [initialOpenId]);

  return (
    <SectionCard
      id="incidents"
      title="Incident register"
      count={page.total}
      description="Significant incidents get notification drafts with their 24-hour, 72-hour and one-month deadlines."
      footer={
        page.total > page.perPage ? (
          <Pagination page={page.page} perPage={page.perPage} total={page.total} noun="incidents" label="Pages of incidents" hrefFor={hrefFor} />
        ) : undefined
      }
      actions={
        canWrite && (
          <Button variant="secondary" size="sm" onClick={() => setRecording(true)} disabled={!configurable} title={configurable ? undefined : LOCKED_HINT}>
            <Plus />
            Record an incident
          </Button>
        )
      }
    >
      {incidents.length === 0 ? (
        <EmptyState
          compact
          title="No incident recorded"
          description="Record security events here, significant or not."
        />
      ) : (
        <Table className="min-w-[1000px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Incident</TableHead>
              <TableHead scope="col">Window</TableHead>
              <TableHead scope="col">Became aware</TableHead>
              <TableHead scope="col">Classification</TableHead>
              <TableHead scope="col">Notification</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className="w-[110px]">
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {incidents.map((incident) => {
              const open = openId === incident.id;
              return (
                <Fragment key={incident.id}>
                  <TableRow id={`incident-row-${incident.id}`} className={cn("align-top", open && "bg-panel2")}>
                    <TableCell className="py-3 align-top">
                      <span className="flex flex-col gap-0.5">
                        <span className="font-semibold [overflow-wrap:anywhere]">{incident.title}</span>
                        <span className="text-xs text-soft">
                          {format.date(incident.detectedAt)} ·{" "}
                          {incident.proxyHostCount === 0 ? "every host" : `${incident.proxyHostCount} host${incident.proxyHostCount === 1 ? "" : "s"}`}
                          {incident.startedAt && incident.endedAt ? ` · lasted ${durationText(incident.startedAt, incident.endedAt)}` : ""}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      <WindowCell incident={incident} />
                    </TableCell>
                    <TableCell className="num py-3 align-top whitespace-nowrap">{format.dateTime(incident.detectedAt)}</TableCell>
                    <TableCell className="py-3 align-top">
                      <Badge variant={CLASSIFICATION_BADGE[incident.classification]}>{CLASSIFICATION_LABELS[incident.classification]}</Badge>
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      <NotificationCell incident={incident} now={now} />
                    </TableCell>
                    <TableCell className="py-3 align-top whitespace-nowrap">
                      {incident.status === "closed" ? (
                        <StatusDot tone="off" label={<>Closed{incident.closedAt && <> <span className="num">{format.date(incident.closedAt)}</span></>}</>} />
                      ) : (
                        <StatusDot tone="warn" label="Open" />
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-right align-top">
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-expanded={open}
                        aria-controls={`incident-detail-${incident.id}`}
                        aria-label={`${open ? "Hide" : "Show"} the details of ${incident.title}`}
                        onClick={() => setOpenId(open ? null : incident.id)}
                      >
                        {open ? "Hide" : "Details"}
                        <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {open && (
                    <TableRow className="bg-panel2 hover:bg-panel2">
                      <TableCell colSpan={7} className="px-4 pt-1 pb-4">
                        <IncidentDetail
                          id={incident.id}
                          canWrite={canWrite}
                          onChanged={() => router.refresh()}
                          onDeleted={() => {
                            setOpenId(null);
                            router.refresh();
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      {recording && (
        <RecordIncidentDialog
          sources={sources}
          onClose={() => setRecording(false)}
          onCreated={(incident) => {
            setRecording(false);
            setOpenId(incident.id);
            router.refresh();
          }}
        />
      )}
    </SectionCard>
  );
}
