// SPDX-License-Identifier: Elastic-2.0
/**
 * Approval policies: validation, storage and the administrator actions on
 * them.
 *
 * Licensing: creating a policy, and any change that leaves it enabled or
 * changes its rules, needs "approvals". Disabling and deleting a policy never
 * do, and neither does reading. Enforcement never checks the license
 * (guard.ts, requests.ts): a policy keeps protecting its hosts after the
 * license lapses, until an administrator disables or deletes it.
 *
 * Policies are master-only and not part of instance sync or configuration
 * export: a replica receives the configuration the master applied.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { approvalPolicies } from "@/src/lib/db/schema";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { normalizeTags } from "@/src/lib/host-tags";
import { requireFeature } from "@/ee/licensing/store";
import { parsePolicyRow, POLICY_NOT_FOUND, type PolicyRow } from "./store";
import { parseTimeZone, parseWindows } from "./windows";
import {
  DEFAULT_REQUEST_TTL_HOURS,
  DEFAULT_REQUIRED_APPROVALS,
  FEATURE,
  MAX_REQUEST_TTL_HOURS,
  MAX_REQUIRED_APPROVALS,
  OPERATIONS,
  TARGET_TYPES,
  isOperation,
  isTargetType,
  type ApprovalPolicyView,
  type Operation,
  type TargetType,
} from "./types";
import { asc, first } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

export { POLICY_NOT_FOUND };

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const FIELDS = [
  "name",
  "description",
  "enabled",
  "targetTypes",
  "operations",
  "hostTags",
  "requiredApprovals",
  "allowEmergency",
  "timeZone",
  "windows",
  "requestTtlHours",
];

export async function listApprovalPolicies(): Promise<ApprovalPolicyView[]> {
  const rows = await appDb.select().from(approvalPolicies).orderBy(asc(approvalPolicies.name), asc(approvalPolicies.id));
  return rows.map(parsePolicyRow);
}

async function getRow(id: number): Promise<PolicyRow> {
  const row = await first(appDb.select().from(approvalPolicies).where(eq(approvalPolicies.id, id)).limit(1));
  if (!row) throw new ApiClientError(POLICY_NOT_FOUND, 404);
  return row;
}

export async function getApprovalPolicy(id: number): Promise<ApprovalPolicyView> {
  return parsePolicyRow(await getRow(id));
}

// ── Validation ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("name is required");
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) throw new ApiValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`);
  if (/\p{Cc}/u.test(name)) throw new ApiValidationError("name must not contain control characters");
  return name;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiValidationError("description must be a string");
  const text = value.trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    throw new ApiValidationError(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return text || null;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
  return value;
}

function parseInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiValidationError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function parseChoices<T extends string>(value: unknown, field: string, all: readonly T[], accept: (v: unknown) => v is T): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiValidationError(`${field} must list at least one of: ${all.join(", ")}`);
  }
  for (const item of value) {
    if (!accept(item)) throw new ApiValidationError(`${field} must only contain: ${all.join(", ")}`);
  }
  const held = new Set(value as T[]);
  return all.filter((item) => held.has(item));
}

type PolicyValues = {
  name: string;
  description: string | null;
  enabled: boolean;
  targetTypes: TargetType[];
  operations: Operation[];
  hostTags: string[];
  requiredApprovals: number;
  allowEmergency: boolean;
  timeZone: string;
  windows: ReturnType<typeof parseWindows>;
  requestTtlHours: number;
};

/** Validates a full policy (create) or a partial one merged over `base` (update). */
function parsePolicyInput(raw: unknown, base: PolicyValues | null): PolicyValues {
  if (!isRecord(raw)) throw new ApiValidationError("Body must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!FIELDS.includes(key)) throw new ApiValidationError(`Unknown field "${key}"`);
  }
  const has = (key: string) => raw[key] !== undefined;
  return {
    name: has("name") || !base ? parseName(raw.name) : base.name,
    description: has("description") ? parseDescription(raw.description) : base?.description ?? null,
    enabled: has("enabled") ? parseBoolean(raw.enabled, "enabled") : base?.enabled ?? true,
    targetTypes: has("targetTypes")
      ? parseChoices(raw.targetTypes, "targetTypes", TARGET_TYPES, isTargetType)
      : base?.targetTypes ?? [...TARGET_TYPES],
    operations: has("operations")
      ? parseChoices(raw.operations, "operations", OPERATIONS, isOperation)
      : base?.operations ?? [...OPERATIONS],
    hostTags: has("hostTags") ? normalizeTags(raw.hostTags) : base?.hostTags ?? [],
    requiredApprovals: has("requiredApprovals")
      ? parseInteger(raw.requiredApprovals, "requiredApprovals", 1, MAX_REQUIRED_APPROVALS)
      : base?.requiredApprovals ?? DEFAULT_REQUIRED_APPROVALS,
    allowEmergency: has("allowEmergency") ? parseBoolean(raw.allowEmergency, "allowEmergency") : base?.allowEmergency ?? true,
    timeZone: has("timeZone") ? parseTimeZone(raw.timeZone) : base?.timeZone ?? "UTC",
    windows: has("windows") ? parseWindows(raw.windows) : base?.windows ?? [],
    requestTtlHours: has("requestTtlHours")
      ? parseInteger(raw.requestTtlHours, "requestTtlHours", 1, MAX_REQUEST_TTL_HOURS)
      : base?.requestTtlHours ?? DEFAULT_REQUEST_TTL_HOURS,
  };
}

function toColumns(values: PolicyValues) {
  return {
    name: values.name,
    description: values.description,
    enabled: values.enabled,
    targetTypes: JSON.stringify(values.targetTypes),
    operations: JSON.stringify(values.operations),
    hostTags: JSON.stringify(values.hostTags),
    requiredApprovals: values.requiredApprovals,
    allowEmergency: values.allowEmergency,
    timeZone: values.timeZone,
    windows: JSON.stringify(values.windows),
    requestTtlHours: values.requestTtlHours,
  };
}

async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  const wanted = name.toLowerCase();
  const clash = (await appDb
    .select({ id: approvalPolicies.id, name: approvalPolicies.name })
    .from(approvalPolicies))
    .find((row) => row.id !== exceptId && row.name.toLowerCase() === wanted);
  if (clash) throw new ApiConflictError(`An approval policy named "${name}" already exists`);
}

/** What the audit log records about a policy (no secrets in a policy). */
function auditData(values: PolicyValues | ApprovalPolicyView) {
  return {
    enabled: values.enabled,
    targetTypes: values.targetTypes,
    operations: values.operations,
    hostTags: values.hostTags,
    requiredApprovals: values.requiredApprovals,
    allowEmergency: values.allowEmergency,
    timeZone: values.timeZone,
    windows: values.windows,
    requestTtlHours: values.requestTtlHours,
  };
}

// ── Actions ─────────────────────────────────────────────────────────

/** Creates a policy. Needs the license. */
export async function createApprovalPolicy(input: unknown, userId: number): Promise<ApprovalPolicyView> {
  await requireFeature(FEATURE);
  const values = parsePolicyInput(input, null);
  const now = nowIso();
  // The name check and the insert in one transaction: two policies never share a name.
  const row = await appDb.transaction(async (tx) => {
    await assertNameFree(values.name, null);
    return (await first(tx
      .insert(approvalPolicies)
      .values({ ...toColumns(values), createdBy: userId, createdAt: now, updatedAt: now })
      .returning()))!;
  });
  await logAuditEvent({
    userId,
    action: "create",
    entityType: "approval_policy",
    entityId: row.id,
    summary: `Created approval policy "${values.name}"`,
    data: auditData(values),
  });
  return parsePolicyRow(row);
}

/** True when the body only turns the policy off ({"enabled": false}). */
function isDisableOnly(input: unknown): boolean {
  return isRecord(input) && Object.keys(input).length === 1 && input.enabled === false;
}

/**
 * Updates a policy; fields left out keep their values. Disabling it
 * ({"enabled": false}) never needs the license; any other change does.
 */
export async function updateApprovalPolicy(id: number, input: unknown, userId: number): Promise<ApprovalPolicyView> {
  const current = parsePolicyRow(await getRow(id));
  if (!isDisableOnly(input)) await requireFeature(FEATURE);
  const values = parsePolicyInput(input, current);
  const row = await appDb.transaction(async (tx) => {
    if (values.name.toLowerCase() !== current.name.toLowerCase()) await assertNameFree(values.name, id);
    return (await first(tx
      .update(approvalPolicies)
      .set({ ...toColumns(values), updatedAt: nowIso() })
      .where(eq(approvalPolicies.id, id))
      .returning()))!;
  });
  await logAuditEvent({
    userId,
    action: values.enabled === current.enabled ? "update" : values.enabled ? "enable" : "disable",
    entityType: "approval_policy",
    entityId: id,
    summary: `${values.enabled === current.enabled ? "Updated" : values.enabled ? "Enabled" : "Disabled"} approval policy "${values.name}"`,
    data: { before: auditData(current), after: auditData(values) },
  });
  return parsePolicyRow(row);
}

/** Deletes a policy. Never needs the license. Requests made under it stay as they are. */
export async function deleteApprovalPolicy(id: number, userId: number): Promise<void> {
  const current = parsePolicyRow(await getRow(id));
  await appDb.delete(approvalPolicies).where(eq(approvalPolicies.id, id));
  await logAuditEvent({
    userId,
    action: "delete",
    entityType: "approval_policy",
    entityId: id,
    summary: `Deleted approval policy "${current.name}"`,
    data: auditData(current),
  });
}

/** Parses a policy id from a route parameter; 404 otherwise. */
export function parsePolicyId(raw: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(POLICY_NOT_FOUND, 404);
  return id;
}
