// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Clock, Globe, RefreshCw, ShieldAlert, ShieldCheck, X, type LucideIcon } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { DiffView } from "@/components/ui/DiffView";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import {
  MAX_COMMENT_LENGTH,
  MIN_EMERGENCY_REASON_LENGTH,
  OPEN_STATUSES,
  TARGET_LABELS,
  type ApprovalPolicyView,
  type ChangeRequestView,
} from "@/ee/approvals/types";
import { requestJson } from "./client-api";
import { describeRequest, longStatus, operationLabel, policyFacts, policySentence, STATUS_TONE } from "./request-format";
import { Initials, Pill } from "./RequestParts";

const IMPACT: Record<ChangeRequestView["impact"]["lines"][number]["key"], { label: string; icon: LucideIcon }> = {
  hosts: { label: "Hosts", icon: Globe },
  caddy: { label: "Caddy", icon: RefreshCw },
  when: { label: "When", icon: Clock },
};

type Entry = { key: string; who: string; verb: string; tone: "ok" | "bad" | "muted"; at: string; text: string | null };

function discussion(request: ChangeRequestView): Entry[] {
  const entries: Entry[] = [
    { key: "request", who: request.requestedBy.name, verb: "requested", tone: "muted", at: request.createdAt, text: request.note },
  ];
  for (const review of request.reviews) {
    entries.push({
      key: `review-${review.id}`,
      who: review.userName,
      verb: review.decision === "approve" ? "approved" : review.decision === "reject" ? "rejected" : "commented",
      tone: review.decision === "approve" ? "ok" : review.decision === "reject" ? "bad" : "muted",
      at: review.createdAt,
      text: review.comment,
    });
  }
  if (request.emergency && request.emergencyBy) {
    entries.push({
      key: "emergency",
      who: request.emergencyBy.name,
      verb: "applied it as an emergency change",
      tone: "bad",
      at: request.decidedAt ?? request.updatedAt,
      text: request.emergencyReason,
    });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

const VERB_TONE: Record<Entry["tone"], string> = { ok: "text-ok", bad: "text-bad", muted: "text-muted-foreground" };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function PolicyPanel({
  request,
  policies,
  onShowPolicies,
}: {
  request: ChangeRequestView;
  policies: ApprovalPolicyView[];
  onShowPolicies?: () => void;
}) {
  const format = useFormat();
  const covering = request.policies.map((ref) => ({ ref, policy: policies.find((policy) => policy.id === ref.id) ?? null }));
  const open = OPEN_STATUSES.includes(request.status);
  const window = request.window;
  const windowNote = !open
    ? request.impact.schedule.description
    : !window.restricted
      ? "No change window: the change is applied as soon as it is approved."
      : window.open
        ? `The change window is open now: ${window.description}.`
        : window.nextOpenAt
          ? `The change window is closed now. It opens ${format.dateTime(window.nextOpenAt)} (${window.description}).`
          : "The change windows of its policies never open together; an emergency change or a policy change is needed.";
  const windowClosed = open && window.restricted && !window.open;
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line2 bg-panel2 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-soft">
        <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
        <span>{covering.length === 1 ? "Policy that applies" : covering.length === 0 ? "No policy recorded" : "Policies that apply"}</span>
        <span className="ml-auto flex flex-wrap gap-x-3">
          {covering.map(({ ref }) =>
            onShowPolicies ? (
              <button key={ref.id} type="button" onClick={onShowPolicies} className="text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline">
                {ref.name}
              </button>
            ) : (
              <span key={ref.id} className="text-[13px] text-foreground">
                {ref.name}
              </span>
            )
          )}
        </span>
      </div>
      {covering.map(({ ref, policy }) =>
        policy ? (
          <div key={ref.id} className="flex flex-col gap-2.5">
            <p className="m-0 text-[15px] leading-[22px] font-semibold">{policySentence(policy)}</p>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={`What “${policy.name}” covers`}>
              {policyFacts(policy).map((fact) => (
                <li key={fact} className="inline-flex h-6 items-center rounded-full border border-line2 px-2 text-xs text-muted-foreground">
                  {fact}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p key={ref.id} className="m-0 text-[13px] text-muted-foreground">
            The policy “{ref.name}” no longer exists. The approvals it asked for still apply to this request.
          </p>
        )
      )}
      <p className={cn("m-0 flex items-start gap-2 text-[13px]", windowClosed ? "text-warn" : "text-muted-foreground")}>
        <Clock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{windowNote}</span>
      </p>
    </div>
  );
}

export default function RequestDetail({
  request,
  policies,
  onOutcome,
  onShowPolicies,
}: {
  request: ChangeRequestView;
  policies: ApprovalPolicyView[];
  /** Called with the request as it is after an action, and the verb for the message. */
  onOutcome: (result: ChangeRequestView, verb: string) => void;
  onShowPolicies?: () => void;
}) {
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [comment, setComment] = useState("");
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { viewer } = request;
  const open = OPEN_STATUSES.includes(request.status);
  const hasComment = comment.trim().length > 0;
  const commentBody = hasComment ? { comment: comment.trim() } : {};
  const hasApproverRole = viewer.canReject;
  const titleId = `request-${request.id}-title`;

  function act(path: string, body: unknown, verb: string, after?: () => void) {
    startTransition(async () => {
      try {
        const result = await requestJson<ChangeRequestView>(`/api/v1/change-requests/${request.id}/${path}`, "POST", body);
        setComment("");
        after?.();
        onOutcome(result, verb);
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  function submitEmergency() {
    if (reason.trim().length < MIN_EMERGENCY_REASON_LENGTH) {
      toast.error(`Give a reason of at least ${MIN_EMERGENCY_REASON_LENGTH} characters`);
      return;
    }
    act("emergency", { reason: reason.trim() }, "Emergency change", () => {
      setEmergencyOpen(false);
      setReason("");
    });
  }

  const entries = discussion(request);
  const waitingForWindow = request.status === "approved" && request.impact.schedule.state === "waiting";

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-col gap-1.5 border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-xs text-soft">#{request.id}</span>
          <span className="text-xs text-soft">{operationLabel(request)}</span>
          <Pill tone={STATUS_TONE[request.status]}>{longStatus(request)}</Pill>
          {request.emergency && (
            <Pill tone="destructive">
              <ShieldAlert aria-hidden="true" className="h-3 w-3" />
              Emergency
            </Pill>
          )}
        </div>
        <h2 id={titleId} className="m-0 text-lg leading-[26px] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">
          {describeRequest(request)}
        </h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
          <span>
            Requested by <span className="font-semibold text-foreground">{request.requestedBy.name}</span> on{" "}
            <span className="num">{format.dateTime(request.createdAt)}</span>
          </span>
          {request.status === "pending" && (
            <span>
              Expires <span className="num">{format.dateTime(request.expiresAt)}</span>
            </span>
          )}
          {request.appliedAt && (
            <span>
              Applied <span className="num">{format.dateTime(request.appliedAt)}</span>
              {request.appliedBy ? ` by ${request.appliedBy.name}` : " by the scheduler"}
            </span>
          )}
          {request.tags.length > 0 && (
            <span>
              Tags <span className="num text-foreground">{request.tags.join(", ")}</span>
            </span>
          )}
          <span>
            Approvals{" "}
            <span className="num font-semibold text-foreground">
              {request.approvals} of {request.requiredApprovals}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          <Link href={`/audit-log?entityType=change_request&entityId=${request.id}`} className="text-brand underline-offset-4 hover:text-foreground hover:underline">
            Audit log of this request
          </Link>
          {request.status === "applied" && (
            <Link href="/history" className="text-brand underline-offset-4 hover:text-foreground hover:underline">
              Change history
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-5 px-5 pt-[18px] pb-5">
        {waitingForWindow && (
          <Banner tone="ok" icon={Clock} title={request.impact.schedule.description}>
            Before applying, the dashboard checks that {request.targetName} has not changed since the request was made and that the policies
            still have enough approvals.
          </Banner>
        )}
        {request.emergencyReason && (
          <Banner tone="bad" icon={ShieldAlert} title={`Emergency change by ${request.emergencyBy?.name ?? "unknown"}.`}>
            {request.emergencyReason}
          </Banner>
        )}
        {request.error && (
          <Banner tone={request.status === "failed" ? "bad" : "warn"} title={request.status === "failed" ? "Applying the change failed." : undefined}>
            {request.error}
          </Banner>
        )}

        <PolicyPanel request={request} policies={policies} onShowPolicies={onShowPolicies} />

        <Section title="What changes">
          {request.note && (
            <p className="m-0 text-[13px] text-muted-foreground">
              <span className="text-soft">Reason given: </span>
              {request.note}
            </p>
          )}
          <DiffView
            fields={request.changes}
            showModeToggle
            title={
              <>
                <span>{TARGET_LABELS[request.targetType]}s</span>
                <span aria-hidden="true">›</span>
                <span className="num text-foreground">{request.targetName}</span>
              </>
            }
            beforeLabel="Now"
            afterLabel="Requested"
            label={`Changes requested in #${request.id}`}
            emptyText="No field changes: the change saves the host as it is."
          />
        </Section>

        {request.impact.lines.length > 0 && (
          <Section title="Impact">
            <dl className="m-0 flex flex-col border-t border-line">
              {request.impact.lines.map((line) => {
                const { label, icon: Icon } = IMPACT[line.key];
                return (
                  <div key={line.key} className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line py-2.5">
                    <dt className="flex flex-[0_0_72px] items-center gap-2 text-[13px] text-muted-foreground">
                      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                      {label}
                    </dt>
                    <dd className="m-0 min-w-0 flex-[1_1_320px] text-[13px]">{line.text}</dd>
                  </div>
                );
              })}
            </dl>
          </Section>
        )}

        <Section title="Discussion">
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {entries.map((entry) => (
              <li key={entry.key} className="flex gap-2.5">
                <Initials name={entry.who} size="md" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px]">
                    <span className="font-semibold">{entry.who}</span> <span className={VERB_TONE[entry.tone]}>{entry.verb}</span>{" "}
                    <span className="num text-xs text-soft">{format.dateTime(entry.at)}</span>
                  </span>
                  {entry.text && <span className="text-[13px] whitespace-pre-line [overflow-wrap:anywhere]">{entry.text}</span>}
                </span>
              </li>
            ))}
          </ol>
        </Section>

        {open && (
          <div className="flex flex-col gap-2.5 border-t border-line pt-4">
            {viewer.isRequester && request.status === "pending" && (
              <p className="m-0 text-xs text-muted-foreground">You made this request: someone else has to approve it.</p>
            )}
            <Label htmlFor={`decision-comment-${request.id}`} className="text-sm font-semibold">
              Your comment
            </Label>
            <Textarea
              id={`decision-comment-${request.id}`}
              value={comment}
              maxLength={MAX_COMMENT_LENGTH}
              onChange={(event) => setComment(event.target.value)}
              placeholder={viewer.canReject ? "Required to reject, optional to approve" : "Comment"}
              rows={3}
            />
            <div className="flex flex-wrap items-center gap-2">
              {viewer.canApprove && (
                <Button disabled={pending} onClick={() => act("approve", commentBody, "Approved")}>
                  <Check /> Approve
                </Button>
              )}
              {request.status === "approved" && hasApproverRole && (
                <Button
                  variant="secondary"
                  disabled={pending || !viewer.canApply}
                  title={viewer.canApply ? undefined : "The change window is closed"}
                  onClick={() => act("apply", undefined, "Applied")}
                >
                  Apply now
                </Button>
              )}
              {viewer.canReject && (
                <Button variant="danger" disabled={pending || !hasComment} onClick={() => act("reject", { comment: comment.trim() }, "Rejected")}>
                  <X /> Reject
                </Button>
              )}
              <Button variant="secondary" disabled={pending || !hasComment} onClick={() => act("comments", { comment: comment.trim() }, "Comment added")}>
                Comment
              </Button>
              {viewer.canEmergency && (
                <Button variant="danger" disabled={pending} onClick={() => setEmergencyOpen(true)}>
                  <ShieldAlert /> Emergency change
                </Button>
              )}
              {viewer.canCancel && (
                <Button variant="ghost" disabled={pending} onClick={() => act("cancel", commentBody, "Cancelled")}>
                  Cancel request
                </Button>
              )}
              <span className="flex-[1_1_220px] text-xs text-soft">
                {request.status === "approved"
                  ? "Apply now works inside the change window. An emergency change skips it and needs a reason."
                  : viewer.canReject
                    ? `A reason is required to reject; ${request.requestedBy.name} sees it here and in the audit log.`
                    : "Comments are visible to everyone who can see this request and are recorded in the audit log."}
              </span>
            </div>
          </div>
        )}
      </div>

      <AppDialog
        open={emergencyOpen}
        onClose={() => setEmergencyOpen(false)}
        title={`Emergency change #${request.id}`}
        maxWidth="md"
        submitLabel="Apply now"
        isSubmitting={pending}
        onSubmit={submitEmergency}
      >
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm">
            This applies {describeRequest(request)} at once, without the remaining approvals and outside any change window. It is flagged
            as an emergency change on the request and in the audit log.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`emergency-reason-${request.id}`}>Reason</Label>
            <Textarea
              id={`emergency-reason-${request.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Incident number and why it cannot wait"
              rows={3}
            />
            <p className="m-0 text-xs text-muted-foreground">At least {MIN_EMERGENCY_REASON_LENGTH} characters.</p>
          </div>
        </div>
      </AppDialog>
    </section>
  );
}
