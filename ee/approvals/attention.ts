// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention provider: change requests waiting for approval or for their
 * change window, among those the reader may see.
 */
import type { AttentionProvider } from "@/src/lib/attention/types";
import { listChangeRequests } from "./requests";
import { TARGET_LABELS, OPERATION_LABELS } from "./types";

export const approvalsAttentionProvider: AttentionProvider = {
  id: "approvals",
  label: "Approvals",
  permissions: ["approvals:read"],
  async collect({ access, now }) {
    const page = await listChangeRequests(access, { status: "open", perPage: 100 }, now);
    return page.requests.map((request) => {
      const what = `${OPERATION_LABELS[request.operation].toLowerCase()} ${TARGET_LABELS[request.targetType].toLowerCase()} ${request.targetName}`;
      const review = [{ label: "Review", route: "/approvals" }];
      if (request.status === "approved") {
        return {
          id: String(request.id),
          severity: "info" as const,
          title: `Change request #${request.id} is approved and waits for its change window`,
          detail: `${what}. ${request.impact.schedule.description}`,
          actions: review,
          at: request.updatedAt,
        };
      }
      if (request.viewer.canApprove) {
        return {
          id: String(request.id),
          severity: "warning" as const,
          title: `Change request #${request.id} waits for your approval`,
          detail: `${request.requestedBy.name} asks to ${what}: ${request.approvals} of ${request.requiredApprovals} approvals. Expires ${request.expiresAt.slice(0, 16).replace("T", " ")} UTC.`,
          actions: review,
          at: request.createdAt,
        };
      }
      return {
        id: String(request.id),
        severity: "info" as const,
        title: request.viewer.isRequester ? `Your change request #${request.id} waits for approval` : `Change request #${request.id} waits for approval`,
        detail: `${what}: ${request.approvals} of ${request.requiredApprovals} approvals.`,
        actions: review,
        at: request.createdAt,
      };
    });
  },
};
