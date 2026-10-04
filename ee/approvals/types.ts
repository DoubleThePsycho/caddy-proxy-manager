// SPDX-License-Identifier: Elastic-2.0
/**
 * Change approvals: shared types and constants. Safe to import from client
 * components (no server-only dependencies).
 */
import type { Weekday } from "@/ee/backups/types";
import type { ChangeImpact } from "./impact";

export const FEATURE = "approvals" as const;

export const TARGET_TYPES = ["proxy_host", "l4_proxy_host"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const TARGET_LABELS: Record<TargetType, string> = {
  proxy_host: "Proxy host",
  l4_proxy_host: "L4 proxy host",
};

/** What a policy can cover. An update that also turns a host on or off performs both operations. */
export const OPERATIONS = ["create", "update", "delete", "enable", "disable"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const OPERATION_LABELS: Record<Operation, string> = {
  create: "Create",
  update: "Change",
  delete: "Delete",
  enable: "Enable",
  disable: "Disable",
};

export const REQUEST_STATUSES = ["pending", "approved", "applied", "rejected", "cancelled", "expired", "failed"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Requests that can still be applied. */
export const OPEN_STATUSES: readonly RequestStatus[] = ["pending", "approved"];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: "Waiting for approval",
  approved: "Approved, waiting for a change window",
  applied: "Applied",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
};

export const DEFAULT_REQUIRED_APPROVALS = 1;
export const MAX_REQUIRED_APPROVALS = 10;
export const DEFAULT_REQUEST_TTL_HOURS = 72;
export const MAX_REQUEST_TTL_HOURS = 30 * 24;
export const MAX_WINDOWS = 14;
export const MIN_EMERGENCY_REASON_LENGTH = 10;
export const MAX_COMMENT_LENGTH = 2000;

/** A time range on some weekdays, in the policy's time zone. end ≤ start runs past midnight into the next day. */
export type ChangeWindow = { days: Weekday[]; start: string; end: string };

/** What matching a change against a policy needs (also sent to the host dialogs). */
export type PolicyRule = {
  id: number;
  name: string;
  enabled: boolean;
  targetTypes: TargetType[];
  operations: Operation[];
  /** Empty: every host of the target types. */
  hostTags: string[];
  requiredApprovals: number;
  allowEmergency: boolean;
  timeZone: string;
  /** Empty: changes may be applied at any time. */
  windows: ChangeWindow[];
  requestTtlHours: number;
};

export type ApprovalPolicyView = PolicyRule & {
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A field-level difference, as in configuration history diffs. */
export type ChangeField = {
  path: string;
  before?: unknown;
  after?: unknown;
  /** The value is secret: only the fact that it changes is shown. */
  secret?: true;
};

export type ReviewView = {
  id: number;
  userId: number;
  userName: string;
  decision: "approve" | "reject" | "comment";
  comment: string | null;
  createdAt: string;
};

export type WindowStatus = {
  /** A covering policy limits when the change may be applied. */
  restricted: boolean;
  /** The change may be applied now. */
  open: boolean;
  /** When every covering policy's window is next open; null when open now, unrestricted or never. */
  nextOpenAt: string | null;
  description: string | null;
};

export type ChangeRequestView = {
  id: number;
  targetType: TargetType;
  targetId: number | null;
  targetName: string;
  operation: Operation;
  operations: Operation[];
  status: RequestStatus;
  requestedBy: { id: number; name: string };
  note: string | null;
  emergency: boolean;
  emergencyReason: string | null;
  emergencyBy: { id: number; name: string } | null;
  requiredApprovals: number;
  approvals: number;
  policies: { id: number; name: string }[];
  tags: string[];
  /** The change as it will be applied (the validated input). */
  input: Record<string, unknown>;
  /** What changes, field by field (requested values against the host as it was when requested). */
  changes: ChangeField[];
  reviews: ReviewView[];
  window: WindowStatus;
  expiresAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
  appliedBy: { id: number; name: string } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the caller may do with it. */
  viewer: { isRequester: boolean; canApprove: boolean; canReject: boolean; canCancel: boolean; canApply: boolean; canEmergency: boolean };
  /** Hosts affected, whether and where Caddy reloads, and when it applies (impact.ts). */
  impact: ChangeImpact;
};

export type ChangeRequestPage = { requests: ChangeRequestView[]; total: number; page: number; perPage: number };

/** Passed to the host dialogs: the enabled policies and whether the user may make emergency changes. */
export type HostApprovalContext = { policies: PolicyRule[]; canEmergency: boolean };

export function isTargetType(value: unknown): value is TargetType {
  return typeof value === "string" && (TARGET_TYPES as readonly string[]).includes(value);
}

export function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && (OPERATIONS as readonly string[]).includes(value);
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === "string" && (REQUEST_STATUSES as readonly string[]).includes(value);
}
