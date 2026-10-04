// SPDX-License-Identifier: Elastic-2.0
/**
 * Access reviews: shared types and constants. Safe to import from client
 * components (no server-only dependencies).
 */

export const FEATURE = "access_reviews" as const;

/**
 * What an item reviews:
 *  - account: the dashboard account itself (revoke: disable it);
 *  - role: the built-in admin role or a custom role (revoke: built-in viewer);
 *  - group: a forward-auth group membership (revoke: remove from the group);
 *  - api_token: an API token (revoke: delete it).
 */
export const ITEM_KINDS = ["account", "role", "group", "api_token"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  account: "Account",
  role: "Role",
  group: "Group",
  api_token: "API token",
};

export const DECISIONS = ["keep", "revoke"] as const;
export type Decision = (typeof DECISIONS)[number];

export type CampaignStatus = "open" | "completed" | "cancelled";

/**
 * What confirming a decision did: kept, revoked, unchanged (the access was
 * already gone or had changed since the campaign started), failed (a guard
 * refused it, e.g. the last administrator), not_reviewed (the campaign was
 * closed before anyone decided).
 */
export type ItemOutcome = "kept" | "revoked" | "unchanged" | "failed" | "not_reviewed";

export const SCOPE_ROLES = ["admin", "user", "viewer"] as const;

export type ReviewScope =
  | { type: "all" }
  | { type: "filter"; roles: (typeof SCOPE_ROLES)[number][]; customRoleIds: number[]; groupIds: number[] };

export type ReviewerView = { id: number; email: string | null; name: string | null };

export type CampaignCounts = {
  total: number;
  /** Not confirmed yet (with or without a draft decision). */
  pending: number;
  /** Pending items with a draft decision. */
  drafted: number;
  kept: number;
  revoked: number;
  unchanged: number;
  failed: number;
  notReviewed: number;
  /** Pending items whose user is the campaign's only reviewer: nobody can decide them. */
  unreviewable: number;
};

export type CampaignSummary = {
  id: number;
  name: string;
  status: CampaignStatus;
  /** Open and past its due date with items still pending. */
  overdue: boolean;
  scope: ReviewScope;
  reviewers: ReviewerView[];
  dueAt: string;
  startedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  scheduleId: number | null;
  createdBy: number | null;
  counts: CampaignCounts;
};

export type ReviewItemView = {
  id: number;
  campaignId: number;
  subjectUserId: number;
  subjectEmail: string;
  subjectName: string | null;
  kind: ItemKind;
  targetId: number | null;
  targetLabel: string;
  decision: Decision | null;
  comment: string | null;
  decidedBy: number | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  confirmedAt: string | null;
  outcome: ItemOutcome | null;
  outcomeDetail: string | null;
  /** Pending in an open campaign past its due date. */
  overdue: boolean;
};

export type CampaignDetail = CampaignSummary & { items: ReviewItemView[] };

export type ScheduleView = {
  id: number;
  name: string;
  enabled: boolean;
  scope: ReviewScope;
  reviewers: ReviewerView[];
  durationDays: number;
  intervalMonths: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastCampaignId: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A reviewer's open work: one entry per open campaign they review. */
export type AssignmentView = {
  campaign: { id: number; name: string; dueAt: string; overdue: boolean };
  items: (ReviewItemView & { ownAccess: boolean })[];
};
