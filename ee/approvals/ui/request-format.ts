// SPDX-License-Identifier: Elastic-2.0
/**
 * Words and labels for the Approvals page: how a request, its status, the
 * policy that covers it and the decision taken are described. Pure functions,
 * safe on the server and the client.
 */
import {
  OPERATION_LABELS,
  OPERATIONS,
  STATUS_LABELS,
  TARGET_LABELS,
  TARGET_TYPES,
  type ApprovalPolicyView,
  type ChangeRequestView,
  type Operation,
  type RequestStatus,
  type TargetType,
} from "@/ee/approvals/types";
import { describeWindows } from "@/ee/approvals/windows";

export type PillTone = "warning" | "success" | "destructive" | "muted" | "info";

/** e.g. "Change proxy host “app”". */
export function describeRequest(request: Pick<ChangeRequestView, "operation" | "targetType" | "targetName">): string {
  return `${OPERATION_LABELS[request.operation]} ${TARGET_LABELS[request.targetType].toLowerCase()} “${request.targetName}”`;
}

/** e.g. "Change proxy host". */
export function operationLabel(request: Pick<ChangeRequestView, "operation" | "targetType">): string {
  return `${OPERATION_LABELS[request.operation]} ${TARGET_LABELS[request.targetType].toLowerCase()}`;
}

export const STATUS_TONE: Record<RequestStatus, PillTone> = {
  pending: "warning",
  approved: "success",
  applied: "success",
  rejected: "destructive",
  cancelled: "muted",
  expired: "muted",
  failed: "destructive",
};

/** The status dot colour of a decided request. */
export const STATUS_DOT: Record<RequestStatus, "ok" | "warn" | "bad" | "off"> = {
  pending: "warn",
  approved: "ok",
  applied: "ok",
  rejected: "bad",
  cancelled: "off",
  expired: "off",
  failed: "bad",
};

/** The short status of a request in the queue. */
export function shortStatus(request: Pick<ChangeRequestView, "status" | "impact">): string {
  if (request.status === "pending") return "Waiting";
  if (request.status === "approved") {
    return request.impact.schedule.state === "waiting" ? "Approved, waits for window" : "Approved, ready to apply";
  }
  return STATUS_LABELS[request.status];
}

/** The long status of a request in its detail. */
export function longStatus(request: Pick<ChangeRequestView, "status" | "impact" | "emergency">): string {
  if (request.status === "approved" && request.impact.schedule.state !== "waiting") return "Approved, ready to apply";
  if (request.status === "applied" && request.emergency) return "Applied as an emergency change";
  return STATUS_LABELS[request.status];
}

/** Two letters for an avatar: "j.moretti" → "JM", "Alice Admin" → "AA", "admin" → "AD". */
export function initials(name: string): string {
  const parts = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const GERUNDS: Record<Operation, string> = {
  create: "creating",
  update: "changing",
  delete: "deleting",
  enable: "enabling",
  disable: "disabling",
};

function hostNoun(types: readonly TargetType[]): string {
  const both = TARGET_TYPES.every((type) => types.includes(type));
  if (both || types.length === 0) return "host";
  return types[0] === "proxy_host" ? "proxy host" : "L4 proxy host";
}

/** What a policy asks for, in one sentence. */
export function policySentence(policy: Pick<ApprovalPolicyView, "operations" | "targetTypes" | "hostTags" | "requiredApprovals">): string {
  const noun = hostNoun(policy.targetTypes);
  const allOperations = OPERATIONS.every((operation) => policy.operations.includes(operation));
  const tagged = policy.hostTags.length > 0 ? `${noun}s tagged ${joinWords(policy.hostTags)}` : null;
  const subject = allOperations
    ? `Any change to ${tagged ?? `a ${noun}`}`
    : `${capitalize(joinWords(policy.operations.map((operation) => GERUNDS[operation])))} ${tagged ?? `any ${noun}`}`;
  const approvers = plural(policy.requiredApprovals, "approver");
  return `${subject} needs ${approvers} who ${policy.requiredApprovals === 1 ? "is" : "are"} not the requester.`;
}

/** Short facts about a policy, shown as chips. */
export function policyFacts(policy: ApprovalPolicyView): string[] {
  const operations = capitalize(policy.operations.map((operation) => OPERATION_LABELS[operation].toLowerCase()).join(", "));
  const both = TARGET_TYPES.every((type) => policy.targetTypes.includes(type));
  const targets = both ? "Proxy and L4 hosts" : `${TARGET_LABELS[policy.targetTypes[0] ?? "proxy_host"]}s`;
  const scope = policy.hostTags.length > 0 ? `${targets} tagged ${policy.hostTags.join(", ")}` : `Every ${both ? "proxy and L4 host" : TARGET_LABELS[policy.targetTypes[0] ?? "proxy_host"].toLowerCase()}`;
  return [
    operations,
    scope,
    describeWindows(policy.windows, policy.timeZone) ?? "No change window",
    policy.allowEmergency ? "Emergency changes allowed" : "No emergency changes",
    `Requests expire after ${plural(policy.requestTtlHours, "hour")}`,
  ];
}

/** One line per enabled policy for the strip under the header. */
export function policySummary(policy: ApprovalPolicyView): string[] {
  const parts = [policy.hostTags.length > 0 ? `tag ${policy.hostTags.join(", ")}` : `every ${hostNoun(policy.targetTypes)}`];
  parts.push(plural(policy.requiredApprovals, "approver"));
  parts.push(describeWindows(policy.windows, policy.timeZone) ?? "any time");
  return parts;
}

/** Who decided a closed request and how, for the decided list. */
export function decisionOf(request: ChangeRequestView): { text: string; comment: string | null } {
  const approvers = request.reviews.filter((review) => review.decision === "approve").map((review) => review.userName);
  const rejection = [...request.reviews].reverse().find((review) => review.decision === "reject");
  switch (request.status) {
    case "applied": {
      if (request.emergency) {
        return { text: `Emergency change by ${request.emergencyBy?.name ?? "an administrator"}`, comment: request.emergencyReason };
      }
      const by = approvers.length > 0 ? `Approved by ${approvers.join(", ")}` : "Approved";
      const applied = request.appliedBy ? `applied by ${request.appliedBy.name}` : "applied by the scheduler";
      return { text: `${by}, ${applied}`, comment: null };
    }
    case "rejected":
      return { text: `Rejected by ${rejection?.userName ?? "an approver"}`, comment: rejection?.comment ?? null };
    case "cancelled":
      return { text: "Cancelled", comment: null };
    case "expired": {
      const hours = Math.round((Date.parse(request.expiresAt) - Date.parse(request.createdAt)) / 3_600_000);
      return { text: Number.isFinite(hours) && hours > 0 ? `No approval within ${plural(hours, "hour")}` : "No approval in time", comment: null };
    }
    case "failed":
      return { text: approvers.length > 0 ? `Approved by ${approvers.join(", ")}, applying failed` : "Applying failed", comment: request.error };
    default:
      return { text: `${request.approvals} of ${request.requiredApprovals} approvals`, comment: null };
  }
}

/** When a request was closed (or last changed). */
export function decidedAt(request: ChangeRequestView): string {
  return request.appliedAt ?? request.decidedAt ?? request.updatedAt;
}

/** What happened after an action, in one sentence, and how it should look. */
export function outcomeMessage(
  request: ChangeRequestView,
  verb: string,
  formatTime: (iso: string) => string
): { tone: "ok" | "info" | "warn" | "bad"; text: string } {
  switch (request.status) {
    case "applied":
      if (request.error) return { tone: "warn", text: `${verb}; ${request.error}` };
      return { tone: "ok", text: `${verb} and applied: ${describeRequest(request)}.` };
    case "approved":
      return {
        tone: "ok",
        text: `${verb}. It will be applied when the change window opens${request.window.nextOpenAt ? ` (${formatTime(request.window.nextOpenAt)})` : ""}.`,
      };
    case "pending":
      return { tone: "ok", text: `${verb}: ${request.approvals} of ${request.requiredApprovals} approvals.` };
    case "failed":
      return { tone: "bad", text: `${verb}, but applying it failed: ${request.error ?? "unknown error"}` };
    case "rejected":
      return { tone: "info", text: `${verb} #${request.id}. ${request.requestedBy.name} sees your reason on the request and in the audit log; nothing changed on ${request.targetName}.` };
    case "cancelled":
      return { tone: "info", text: `${verb} #${request.id}. Nothing changed on ${request.targetName}.` };
    default:
      return { tone: "info", text: `${verb}.` };
  }
}
