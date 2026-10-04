// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { ApiClientError } from "@/src/lib/api-errors";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { listApprovalPolicies } from "@/ee/approvals/policies";
import { getChangeRequest, listChangeRequests } from "@/ee/approvals/requests";
import { FEATURE, type ChangeRequestView } from "@/ee/approvals/types";
import { listAlertChannels } from "@/ee/alerting/channels";
import { listAlertRules } from "@/ee/alerting/rules";
import ApprovalsClient, { type ApprovalsTab } from "./ApprovalsClient";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Approvals" };

const DECIDED_PER_PAGE = 25;
const RECENT_SHOWN = 5;
const TABS: readonly ApprovalsTab[] = ["requests", "decided", "policies"];

interface PageProps {
  searchParams: Promise<{ tab?: string; page?: string; request?: string }>;
}

/** Names of the channels that enabled "change waiting for approval" rules notify. */
async function approvalAlertChannels(): Promise<string[]> {
  const [rules, channels] = await Promise.all([listAlertRules(), listAlertChannels()]);
  const names = new Map(channels.filter((channel) => channel.enabled).map((channel) => [channel.id, channel.name]));
  const ids = rules.filter((rule) => rule.enabled && rule.type === "approval_pending").flatMap((rule) => rule.channelIds);
  return [...new Set(ids.map((id) => names.get(id)).filter((name): name is string => Boolean(name)))];
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const { access } = await requirePermission("approvals:read");
  const { tab: tabParam, page: pageParam, request: requestParam } = await searchParams;
  const tab = TABS.find((candidate) => candidate === tabParam) ?? "requests";
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const requestedId = parseRowId(requestParam);

  // Change requests are limited to hosts the user can read (and their own); policies hold no secrets.
  const [open, decided, recent, policies, configurable, alertChannels] = await Promise.all([
    listChangeRequests(access, { status: "open", perPage: 100 }),
    listChangeRequests(access, { status: "closed", page, perPage: DECIDED_PER_PAGE }),
    listChangeRequests(access, { status: "closed", page: 1, perPage: RECENT_SHOWN }),
    listApprovalPolicies(),
    isFeatureConfigurable(FEATURE),
    can(access, "alerts:read") ? approvalAlertChannels() : Promise.resolve(null),
  ]);

  // The queue is oldest first.
  const queue = { ...open, requests: [...open.requests].reverse() };

  // A request named in the URL that is not open: loaded with the same visibility rules (404 otherwise).
  let selected: ChangeRequestView | null = null;
  if (requestedId !== null) {
    selected = queue.requests.find((request) => request.id === requestedId) ?? null;
    if (!selected) {
      selected = await getChangeRequest(access, requestedId).catch((error: unknown) => {
        if (error instanceof ApiClientError) return null;
        throw error;
      });
    }
  }

  return (
    <ApprovalsClient
      initialTab={tab}
      open={queue}
      recent={recent.requests}
      decided={decided}
      selected={selected}
      policies={policies}
      configurable={configurable}
      editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
      canManage={can(access, "approvals:manage")}
      alertChannels={alertChannels}
      now={new Date().toISOString()}
    />
  );
}
