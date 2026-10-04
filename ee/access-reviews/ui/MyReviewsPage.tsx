// SPDX-License-Identifier: Elastic-2.0
import { getSessionAccess, requireUser } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { listAssignments } from "@/ee/access-reviews/decisions";
import { getCampaignEvidence, type CampaignEvidence } from "@/ee/access-reviews/evidence";
import MyReviewsClient from "@/ee/access-reviews/ui/MyReviewsClient";

export const metadata = { title: "My reviews" };

/**
 * The access reviews the signed-in user was named a reviewer of, with the
 * evidence for each item. Being named is the authorization (no permission
 * needed); every other user sees an empty page. Never checks the license.
 */
export default async function MyReviewsPage() {
  const session = await requireUser();
  const userId = Number(session.user.id);
  const access = await getSessionAccess(session);
  const assignments = await listAssignments(userId);
  const evidence: Record<number, CampaignEvidence | null> = {};
  for (const assignment of assignments) {
    try {
      evidence[assignment.campaign.id] = await getCampaignEvidence(assignment.campaign.id);
    } catch (error) {
      console.error("[access-reviews] Failed to read the evidence:", error instanceof Error ? error.name : typeof error);
      evidence[assignment.campaign.id] = null;
    }
  }
  return (
    <MyReviewsClient
      assignments={assignments}
      currentUserId={userId}
      evidence={evidence}
      now={new Date().toISOString()}
      canOpenCampaigns={can(access, "access_reviews:read")}
      linkUsers={can(access, "users:read")}
    />
  );
}
