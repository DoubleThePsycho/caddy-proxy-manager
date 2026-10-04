// SPDX-License-Identifier: Elastic-2.0
/**
 * Which policies cover a change. Pure functions, shared by the server (the
 * guards and change requests) and the host dialogs (the "protected" notice).
 *
 * A policy covers a change when it is enabled, names the target type, the
 * host carries one of its tags (or it has none: every host) and it lists one
 * of the operations the change performs. For an update the host's tags
 * before and after the change both count, so a protected tag can neither be
 * removed nor added without approval. Several covering policies combine to
 * the strictest: the most approvals, every window, the shortest expiry, and
 * no emergency change if any of them forbids it.
 */
import {
  DEFAULT_REQUEST_TTL_HOURS,
  DEFAULT_REQUIRED_APPROVALS,
  type Operation,
  type PolicyRule,
  type TargetType,
} from "./types";

export function policyCoversHost(policy: PolicyRule, targetType: TargetType, tags: readonly string[]): boolean {
  if (!policy.enabled || !policy.targetTypes.includes(targetType)) return false;
  return policy.hostTags.length === 0 || policy.hostTags.some((tag) => tags.includes(tag));
}

/** The policies that cover `operations` on a host of `targetType` carrying `tags`. */
export function policiesCovering(
  policies: readonly PolicyRule[],
  targetType: TargetType,
  tags: readonly string[],
  operations: readonly Operation[]
): PolicyRule[] {
  return policies.filter(
    (policy) => policyCoversHost(policy, targetType, tags) && operations.some((operation) => policy.operations.includes(operation))
  );
}

/**
 * The operations an update performs. `input` holds the fields being set
 * (undefined ones are left as they are); changing only `enabled` is enabling
 * or disabling, anything else is a change (plus enabling or disabling when
 * `enabled` changes too). `subResources` marks changes to forward-auth access
 * or mTLS access rules, which are changes of the host.
 */
export function updateOperations(
  input: Record<string, unknown>,
  currentEnabled: boolean,
  subResources = false
): { operation: Operation; operations: Operation[] } {
  const keys = Object.keys(input).filter((key) => input[key] !== undefined);
  const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;
  if (!subResources && enabled !== undefined && keys.every((key) => key === "enabled")) {
    const operation: Operation = enabled ? "enable" : "disable";
    return { operation, operations: [operation] };
  }
  const operations: Operation[] = ["update"];
  if (enabled !== undefined && enabled !== currentEnabled) operations.push(enabled ? "enable" : "disable");
  return { operation: "update", operations };
}

export function requiredApprovalsFor(policies: readonly PolicyRule[]): number {
  return Math.max(DEFAULT_REQUIRED_APPROVALS, ...policies.map((policy) => policy.requiredApprovals));
}

export function requestTtlHoursFor(policies: readonly PolicyRule[]): number {
  return policies.length === 0 ? DEFAULT_REQUEST_TTL_HOURS : Math.min(...policies.map((policy) => policy.requestTtlHours));
}

/** The covering policies that forbid emergency changes. */
export function policiesForbiddingEmergency(policies: readonly PolicyRule[]): PolicyRule[] {
  return policies.filter((policy) => !policy.allowEmergency);
}

/** "the change approval policy "Production"" / "the change approval policies "A", "B"". */
export function describePolicies(policies: readonly Pick<PolicyRule, "name">[]): string {
  const names = policies.map((policy) => `"${policy.name}"`);
  return names.length === 1 ? `the change approval policy ${names[0]}` : `the change approval policies ${names.join(", ")}`;
}
