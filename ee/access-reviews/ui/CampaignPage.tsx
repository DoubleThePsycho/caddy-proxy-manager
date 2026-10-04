// SPDX-License-Identifier: Elastic-2.0
import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { listGroups } from "@/src/lib/models/groups";
import { getUserById } from "@/src/lib/models/user";
import { appDb } from "@/src/lib/db";
import { listRoles } from "@/ee/custom-roles/service";
import { readCampaign } from "@/ee/access-reviews/campaigns";
import { reviewsOpenCampaign } from "@/ee/access-reviews/decisions";
import { getCampaignEvidence, type CampaignEvidence } from "@/ee/access-reviews/evidence";
import CampaignClient from "@/ee/access-reviews/ui/CampaignClient";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Access review" };

/** One campaign with the evidence for each item. A reviewer of the open campaign decides its items here too. */
export default async function AccessReviewCampaignPage({ params }: { params: Promise<{ id?: string }> }) {
  const session = await requirePermission("access_reviews:read");
  const { id } = await params;
  const campaignId = parseRowId(id);
  const campaign = campaignId === null ? null : await readCampaign(appDb, campaignId);
  if (!campaign) notFound();
  const userId = Number(session.user.id);
  const [groups, roles, creator] = await Promise.all([
    listGroups(),
    listRoles(),
    campaign.createdBy !== null ? getUserById(campaign.createdBy) : Promise.resolve(null),
  ]);
  let evidence: CampaignEvidence | null = null;
  try {
    evidence = await getCampaignEvidence(campaign.id);
  } catch (error) {
    console.error("[access-reviews] Failed to read the evidence:", error instanceof Error ? error.name : typeof error);
  }
  return (
    <CampaignClient
      campaign={campaign}
      canWrite={can(session.access, "access_reviews:write")}
      customRoles={roles.map((role) => ({ id: role.id, name: role.name }))}
      groups={groups.map((group) => ({ id: group.id, name: group.name }))}
      isReviewer={await reviewsOpenCampaign(userId, campaign.id)}
      currentUserId={userId}
      evidence={evidence}
      startedBy={creator ? creator.name || creator.email : null}
      now={new Date().toISOString()}
      linkUsers={can(session.access, "users:read")}
    />
  );
}
