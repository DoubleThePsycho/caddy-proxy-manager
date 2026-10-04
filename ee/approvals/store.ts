// SPDX-License-Identifier: Elastic-2.0
/**
 * Approval policies as stored, and the reads the guards use. Everything here
 * takes a database reader (the database or a transaction on it), so a check
 * and the write it guards can share one transaction. Nothing here looks at the license.
 */
import { eq } from "drizzle-orm";
import { appDb, toIso } from "@/src/lib/db";
import { approvalPolicies } from "@/src/lib/db/schema";
import { parseStoredTags } from "@/src/lib/host-tags";
import { readStoredWindows } from "./windows";
import {
  DEFAULT_REQUIRED_APPROVALS,
  MAX_REQUEST_TTL_HOURS,
  MAX_REQUIRED_APPROVALS,
  OPERATIONS,
  TARGET_TYPES,
  isOperation,
  isTargetType,
  type ApprovalPolicyView,
  type PolicyRule,
} from "./types";
import { asc } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

/** The database or a transaction on it, for reads. */
export type PolicyReader = Pick<DbExecutor, "select">;

export type PolicyRow = typeof approvalPolicies.$inferSelect;

export const POLICY_NOT_FOUND = "Approval policy not found";

// ── Reading ─────────────────────────────────────────────────────────

function parseStringList<T extends string>(raw: string, accept: (value: unknown) => value is T, order: readonly T[]): T[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const held = new Set(parsed.filter(accept));
    return order.filter((value) => held.has(value));
  } catch {
    return [];
  }
}

/**
 * A stored policy. Anything this release cannot read is read the most
 * protective way: an unreadable target, operation or tag list covers every
 * host and operation, and unreadable windows never open.
 */
export function parsePolicyRow(row: PolicyRow): ApprovalPolicyView {
  const targetTypes = parseStringList(row.targetTypes, isTargetType, TARGET_TYPES);
  const operations = parseStringList(row.operations, isOperation, OPERATIONS);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    enabled: row.enabled,
    targetTypes: targetTypes.length > 0 ? targetTypes : [...TARGET_TYPES],
    operations: operations.length > 0 ? operations : [...OPERATIONS],
    hostTags: parseStoredTags(row.hostTags),
    requiredApprovals: Math.min(MAX_REQUIRED_APPROVALS, Math.max(DEFAULT_REQUIRED_APPROVALS, row.requiredApprovals)),
    allowEmergency: row.allowEmergency,
    timeZone: row.timeZone || "UTC",
    windows: readStoredWindows(row.windows),
    requestTtlHours: Math.min(MAX_REQUEST_TTL_HOURS, Math.max(1, row.requestTtlHours)),
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

function toRule(view: ApprovalPolicyView): PolicyRule {
  return {
    id: view.id,
    name: view.name,
    enabled: view.enabled,
    targetTypes: view.targetTypes,
    operations: view.operations,
    hostTags: view.hostTags,
    requiredApprovals: view.requiredApprovals,
    allowEmergency: view.allowEmergency,
    timeZone: view.timeZone,
    windows: view.windows,
    requestTtlHours: view.requestTtlHours,
  };
}

/** The enabled policies (the guards read them inside write transactions). Never checks the license. */
export async function readEnabledPolicyRules(reader: PolicyReader = appDb): Promise<PolicyRule[]> {
  return (await reader
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.enabled, true))
    .orderBy(asc(approvalPolicies.id)))
    .map((row) => toRule(parsePolicyRow(row)));
}

/** Policies by id, enabled or not (to name the policies a request was made under). */
export async function readPolicyRulesById(ids: readonly number[], reader: PolicyReader = appDb): Promise<Map<number, PolicyRule>> {
  if (ids.length === 0) return new Map();
  const rows = await reader.select().from(approvalPolicies);
  return new Map(rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, toRule(parsePolicyRow(row))]));
}

