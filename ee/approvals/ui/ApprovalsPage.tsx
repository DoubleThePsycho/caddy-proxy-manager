// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { ApiClientError } from "@/src/lib/api-errors";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { listApprovalPolicies } from "@/ee/approvals/policies";
import { getChangeRequest, listChangeRequests } from "@/ee/approvals/requests";
import { FEATURE, type ChangeRequestPage, type ChangeRequestView } from "@/ee/approvals/types";
import { listAlertChannels } from "@/ee/alerting/channels";
import { listAlertRules } from "@/ee/alerting/rules";
import ApprovalsClient, { type ApprovalsTab } from "./ApprovalsClient";
import { parseRowId } from "@/src/lib/row-ids";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/src/lib/pagination";

export const metadata = { title: "Approvals" };

const DECIDED_PER_PAGE = DEFAULT_PAGE_SIZE;
const QUEUE_PER_PAGE = DEFAULT_PAGE_SIZE;
const RECENT_SHOWN = 5;
const TABS: readonly ApprovalsTab[] = ["requests", "decided", "policies"];

interface PageProps {
  searchParams: Promise<{ tab?: string; page?: string; queue?: string; request?: string }>;
}

type Access = Parameters<typeof listChangeRequests>[0];

/**
 * A page of the open requests, oldest first (clamped to the last page).
 * The store lists newest first, so the page is cut from the one or two
 * newest-first pages that hold it.
 */
async function openQueue(access: Access, requested: number): Promise<ChangeRequestPage> {
  const perPage = QUEUE_PER_PAGE;
  const newest = await listChangeRequests(access, { status: "open", page: 1, perPage });
  const total = newest.total;
  const page = Math.min(requested, Math.max(1, Math.ceil(total / perPage)));
  // Oldest first, page p holds the newest-first positions [end - perPage, end).
  const end = total - (page - 1) * perPage;
  if (end <= 0) return { requests: [], total, page, perPage };
  const start = Math.max(0, end - perPage);
  const first = Math.floor(start / perPage) + 1;
  const last = Math.floor((end - 1) / perPage) + 1;
  const pages = await Promise.all(
    Array.from({ length: last - first + 1 }, (_, index) =>
      first + index === 1 ? Promise.resolve(newest) : listChangeRequests(access, { status: "open", page: first + index, perPage })
    )
  );
  const offset = (first - 1) * perPage;
  const requests = pages.flatMap((result) => result.requests).slice(start - offset, end - offset).reverse();
  return { requests, total, page, perPage };
}

/** A page of the decided requests, newest first, clamped to the last page. */
async function decidedPage(access: Access, requested: number) {
  const result = await listChangeRequests(access, { status: "closed", page: requested, perPage: DECIDED_PER_PAGE });
  const pageCount = Math.max(1, Math.ceil(result.total / DECIDED_PER_PAGE));
  if (requested <= pageCount) return result;
  return listChangeRequests(access, { status: "closed", page: pageCount, perPage: DECIDED_PER_PAGE });
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
  const { tab: tabParam, page: pageParam, queue: queueParam, request: requestParam } = await searchParams;
  const tab = TABS.find((candidate) => candidate === tabParam) ?? "requests";
  const requestedId = parseRowId(requestParam);

  // Change requests are limited to hosts the user can read (and their own); policies hold no secrets.
  const [queue, decided, recent, policies, configurable, alertChannels] = await Promise.all([
    openQueue(access, parsePageParam(queueParam)),
    decidedPage(access, parsePageParam(pageParam)),
    listChangeRequests(access, { status: "closed", page: 1, perPage: RECENT_SHOWN }),
    listApprovalPolicies(),
    isFeatureConfigurable(FEATURE),
    can(access, "alerts:read") ? approvalAlertChannels() : Promise.resolve(null),
  ]);

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
