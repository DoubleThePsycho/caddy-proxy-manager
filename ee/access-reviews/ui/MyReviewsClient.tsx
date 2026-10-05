// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { CampaignEvidence } from "../evidence";
import type { AssignmentView } from "../types";
import { CampaignStatusPill } from "./shared";
import { ConfirmPanel, ReviewProgress, ReviewTable, useReviewDecisions } from "./ReviewWorkspace";

type Props = {
  assignments: AssignmentView[];
  currentUserId: number;
  /** Evidence per campaign id; missing or null when it could not be read. */
  evidence?: Record<number, CampaignEvidence | null>;
  /** When the page was rendered, for "due in N days". */
  now?: string;
  /** The reviewer may open the campaign pages (access_reviews:read). */
  canOpenCampaigns?: boolean;
  /** Names link to Users and groups (users:read). */
  linkUsers?: boolean;
};

function AssignmentWorkspace({
  assignment,
  currentUserId,
  evidence,
  now,
  canOpenCampaigns,
  linkUsers,
}: {
  assignment: AssignmentView;
  currentUserId: number;
  evidence: CampaignEvidence | null;
  now?: string;
  canOpenCampaigns: boolean;
  linkUsers: boolean;
}) {
  const format = useFormat();
  const decisions = useReviewDecisions({
    campaignId: assignment.campaign.id,
    items: assignment.items,
    currentUserId,
    decidable: true,
    evidence,
  });
  const drafts = decisions.mine.length;
  const campaign = { status: "open" as const, dueAt: assignment.campaign.dueAt, overdue: assignment.campaign.overdue };
  const headingId = `review-${assignment.campaign.id}`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
          <h2 id={headingId} className="m-0 flex flex-wrap items-center gap-2.5 text-lg leading-7 font-semibold">
            {assignment.campaign.name}
            <CampaignStatusPill campaign={campaign} now={now} />
          </h2>
          <span className="text-[13px] text-soft">
            Due <span className="num">{format.dateTime(assignment.campaign.dueAt)}</span>
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {canOpenCampaigns && (
            <Button asChild variant="outline">
              <Link href={`/access-reviews/${assignment.campaign.id}`}>Open the review</Link>
            </Button>
          )}
          <Button onClick={() => decisions.setConfirming(true)} disabled={drafts === 0 || decisions.pending}>
            {drafts > 0 ? `Confirm ${drafts} decision${drafts === 1 ? "" : "s"}` : "Confirm decisions"}
          </Button>
        </div>
      </div>
      <div className="rounded-2xl border border-line bg-panel px-5 py-[18px]">
        <ReviewProgress items={decisions.items} />
      </div>
      <ConfirmPanel decisions={decisions} />
      <ReviewTable decisions={decisions} evidence={evidence} currentUserId={currentUserId} linkUsers={linkUsers} title={`Access to review in ${assignment.campaign.name}`} />
    </section>
  );
}

/** The access reviews the signed-in user was asked to decide. */
export default function MyReviewsClient({ assignments, currentUserId, evidence = {}, now, canOpenCampaigns = false, linkUsers = false }: Props) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <PageHeader
        className="mb-0"
        breadcrumb={["Identity", "My reviews"]}
        title="My reviews"
        count={assignments.length > 0 ? assignments.length : null}
        description="Choose keep or revoke for each item, then confirm."
      />
      {assignments.length === 0 ? (
        <section aria-label="My reviews" className="rounded-2xl border border-line bg-panel">
          <EmptyState icon={ClipboardCheck} title="Nothing to review" />
        </section>
      ) : (
        assignments.map((assignment) => (
          <AssignmentWorkspace
            key={assignment.campaign.id}
            assignment={assignment}
            currentUserId={currentUserId}
            evidence={evidence[assignment.campaign.id] ?? null}
            now={now}
            canOpenCampaigns={canOpenCampaigns}
            linkUsers={linkUsers}
          />
        ))
      )}
    </div>
  );
}
