// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { listUsers } from "@/src/lib/models/user";
import { listGroups } from "@/src/lib/models/groups";
import { listRoles } from "@/ee/custom-roles/service";
import { listCampaigns } from "@/ee/access-reviews/campaigns";
import { pendingReviewSummary } from "@/ee/access-reviews/decisions";
import { listSchedules } from "@/ee/access-reviews/schedules";
import AccessReviewsClient from "@/ee/access-reviews/ui/AccessReviewsClient";

export const metadata = { title: "Access reviews" };

export default async function AccessReviewsPage() {
  const session = await requirePermission("access_reviews:read");
  const [users, groups, roles] = await Promise.all([listUsers(), listGroups(), listRoles()]);
  return (
    <AccessReviewsClient
      campaigns={await listCampaigns()}
      schedules={await listSchedules()}
      users={users.filter((user) => user.status === "active").map((user) => ({ id: user.id, email: user.email, name: user.name }))}
      customRoles={roles.map((role) => ({ id: role.id, name: role.name }))}
      groups={groups.map((group) => ({ id: group.id, name: group.name }))}
      canWrite={can(session.access, "access_reviews:write")}
      myPending={(await pendingReviewSummary(Number(session.user.id))).pending}
      now={new Date().toISOString()}
    />
  );
}
