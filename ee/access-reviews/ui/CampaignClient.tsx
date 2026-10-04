// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Download } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { CampaignEvidence } from "../evidence";
import type { CampaignDetail } from "../types";
import { callApi, CampaignStatusPill, describeScope, dueText } from "./shared";
import { ConfirmPanel, ReviewProgress, ReviewTable, useReviewDecisions } from "./ReviewWorkspace";

type Props = {
  campaign: CampaignDetail;
  canWrite: boolean;
  customRoles: { id: number; name: string }[];
  groups: { id: number; name: string }[];
  /** The signed-in user reviews this open campaign, so they decide its items here. */
  isReviewer: boolean;
  currentUserId?: number;
  /** Evidence for each item (sign-ins, last change, last use); null when it could not be read. */
  evidence?: CampaignEvidence | null;
  /** Who started it. */
  startedBy?: string | null;
  /** When the page was rendered, for "due in N days". */
  now?: string;
  /** Names link to Users and groups (users:read). */
  linkUsers?: boolean;
};

type Action = "complete" | "cancel" | "delete";

const ACTION_TEXT: Record<Action, { title: string; label: string; body: string }> = {
  complete: {
    title: "Complete this review now?",
    label: "Complete",
    body: "Items nobody confirmed are recorded as not reviewed and their access stays as it is. The record is final afterwards.",
  },
  cancel: {
    title: "Cancel this review?",
    label: "Cancel review",
    body: "Nothing more can be decided or revoked. Revocations already confirmed stay.",
  },
  delete: {
    title: "Delete this review?",
    label: "Delete",
    body: "The campaign and its record are deleted. The audit log keeps the events. Download the record first if you need it.",
  },
};

/** One access review: progress, the people and their access with evidence, and the reviewer's decisions. */
export default function CampaignClient({
  campaign,
  canWrite,
  customRoles,
  groups,
  isReviewer,
  currentUserId = 0,
  evidence = null,
  startedBy = null,
  now,
  linkUsers = false,
}: Props) {
  const router = useRouter();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<Action | null>(null);
  const names = useMemo(() => ({
    customRoles: new Map(customRoles.map((role) => [role.id, role.name])),
    groups: new Map(groups.map((group) => [group.id, group.name])),
  }), [customRoles, groups]);
  const items = useMemo(
    () => campaign.items.map((item) => ({ ...item, ownAccess: item.subjectUserId === currentUserId })),
    [campaign.items, currentUserId]
  );
  const open = campaign.status === "open";
  const decisions = useReviewDecisions({ campaignId: campaign.id, items, currentUserId, decidable: isReviewer && open, evidence });
  const counts = campaign.counts;
  const people = new Set(campaign.items.map((item) => item.subjectUserId)).size;
  const drafts = decisions.mine.length;
  const recordLabel = campaign.status === "completed" ? "Final record, CSV" : campaign.status === "cancelled" ? "Record, CSV" : "Interim record, CSV";
  const due = dueText(campaign, now);

  function run() {
    const current = action;
    if (!current) return;
    startTransition(async () => {
      try {
        if (current === "delete") {
          await callApi(`/api/v1/access-reviews/${campaign.id}`, "DELETE");
          toast.success("Access review deleted");
          router.push("/access-reviews");
          return;
        }
        await callApi(`/api/v1/access-reviews/${campaign.id}/${current}`, "POST");
        toast.success(current === "complete" ? "Access review completed" : "Access review cancelled");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setAction(null);
      router.refresh();
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Identity", { label: "Access reviews", href: "/access-reviews" }, campaign.name]}
        title={
          <>
            {campaign.name}
            <CampaignStatusPill campaign={campaign} now={now} />
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/api/v1/access-reviews/${campaign.id}/record?format=csv`}>
                <Download />
                {recordLabel}
              </a>
            </Button>
            {canWrite && open && (
              <Button variant="ghost" onClick={() => setAction("complete")} disabled={pending}>
                Complete early
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="More actions for this review">
                  More
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={`/api/v1/access-reviews/${campaign.id}/record?format=json`}>Record, JSON</a>
                </DropdownMenuItem>
                {canWrite && (
                  <>
                    <DropdownMenuSeparator />
                    {open && <DropdownMenuItem onSelect={() => setAction("cancel")}>Cancel review</DropdownMenuItem>}
                    <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setAction("delete")}>Delete review</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {isReviewer && open && (
              <Button onClick={() => decisions.setConfirming(true)} disabled={drafts === 0 || decisions.pending}>
                {drafts > 0 ? `Confirm ${drafts} decision${drafts === 1 ? "" : "s"}` : "Confirm decisions"}
              </Button>
            )}
          </>
        }
      />

      <section aria-labelledby="progress-title" className="flex flex-wrap gap-x-10 gap-y-5 rounded-2xl border border-line bg-panel px-5 py-[18px]">
        <div className="flex min-w-0 flex-[3_1_420px] flex-col gap-2.5">
          <h2 id="progress-title" className="m-0 text-[13px] leading-5 font-medium text-muted-foreground">Progress</h2>
          <ReviewProgress items={decisions.items} />
        </div>
        <dl className="m-0 grid min-w-0 flex-[2_1_320px] grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] content-start gap-x-5 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-soft">Due</dt>
            <dd className="m-0 flex flex-col">
              <span className="num">{format.dateTime(campaign.dueAt)}</span>
              {due && <span className={campaign.overdue ? "text-xs text-bad" : open ? "text-xs text-warn" : "text-xs text-soft"}>{due}</span>}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-soft">Started</dt>
            <dd className="m-0 flex flex-col">
              <span>
                <span className="num">{format.date(campaign.startedAt)}</span>
                {startedBy ? ` by ${startedBy}` : campaign.scheduleId !== null ? " by its schedule" : ""}
              </span>
              <span className="text-xs text-soft">Snapshot of access at that time</span>
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-soft">In scope</dt>
            <dd className="m-0 flex flex-col">
              <span>
                <span className="num">{people}</span> {people === 1 ? "person" : "people"}, <span className="num">{counts.total}</span> item{counts.total === 1 ? "" : "s"}
              </span>
              <span className="text-xs text-soft">{describeScope(campaign.scope, names)}</span>
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-soft">Reviewers</dt>
            <dd className="m-0 flex flex-col">
              <span>
                {campaign.reviewers
                  .map((reviewer) => `${reviewer.name || reviewer.email || `#${reviewer.id}`}${reviewer.id === currentUserId ? " (you)" : ""}`)
                  .join(", ")}
              </span>
              <span className="text-xs text-soft">Nobody reviews their own access</span>
            </dd>
          </div>
        </dl>
      </section>

      {counts.unreviewable > 0 && (
        <Banner tone="bad" title={`${counts.unreviewable} item${counts.unreviewable === 1 ? "" : "s"} cannot be decided.`}>
          They belong to the only reviewer, who cannot review their own access. Start a new review with another reviewer for them.
        </Banner>
      )}
      {!isReviewer && open && (
        <Banner tone="info">You do not review this campaign, so its items are shown read-only. Its reviewers decide them.</Banner>
      )}
      {evidence === null && (
        <Banner tone="warn">The evidence for this review could not be read. Decisions still work.</Banner>
      )}

      <ConfirmPanel decisions={decisions} />

      <ReviewTable decisions={decisions} evidence={evidence} currentUserId={currentUserId} linkUsers={linkUsers} />

      <p className="m-0 text-xs text-soft">
        Evidence comes from the audit log, the sign-in records and the forward-auth sessions, read when the page opens. Items nobody
        confirms stay as they are; completing the review records them as not reviewed.
      </p>

      <AppDialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={action ? ACTION_TEXT[action].title : ""}
        submitLabel={action ? ACTION_TEXT[action].label : ""}
        onSubmit={run}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">{action ? ACTION_TEXT[action].body : ""}</p>
      </AppDialog>
    </div>
  );
}
