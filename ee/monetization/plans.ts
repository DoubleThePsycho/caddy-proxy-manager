// SPDX-License-Identifier: Elastic-2.0
/**
 * Plans: a price per request, optional free requests per calendar month, an
 * optional per-minute limit, how the plan's consumers pay (prepaid, or
 * postpaid up to a hard cap with a saved card), whether requests answered
 * with a 5xx are credited back, and whether key holders may pay with x402.
 *
 * Licensing: creating and changing a plan needs "api_monetization"; deleting
 * one never does (it is refused while consumers or hosts still use the plan).
 */
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationConsumers, monetizationHosts, monetizationPayments, monetizationPlans } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { reloadMonetization } from "./engine";
import { parseAmount, parseBoolean, parseInteger, parseName, rejectUnknownKeys, requireRecord } from "./http";
import { MAX_POSTPAID_CAP_MICROS } from "./billing-rules";
import { BILLING_MODES, FEATURE, type BillingMode, type PlanView } from "./types";
import { asc, first } from "@/src/lib/db/ops";

export const PLAN_NOT_FOUND = "Plan not found";
export const ANALYTICS_REQUIRED =
  "Failed-answer credits need ClickHouse analytics: the access-log pipeline is what records each request's answer. " +
  "Configure ClickHouse (CLICKHOUSE_PASSWORD) first";
const FIELDS = [
  "name",
  "pricePerRequestMicros",
  "includedRequestsPerMonth",
  "requestsPerMinute",
  "billing",
  "postpaidCapMicros",
  "postpaidThresholdMicros",
  "creditFailedAnswers",
  "acceptX402",
];
const MAX_INCLUDED = 1_000_000_000;
const MAX_PER_MINUTE = 1_000_000;

type PlanRow = typeof monetizationPlans.$inferSelect;

type ParsedPlan = {
  name: string;
  pricePerRequestMicros: number;
  includedRequestsPerMonth: number;
  requestsPerMinute: number | null;
  billing: BillingMode;
  postpaidCapMicros: number | null;
  postpaidThresholdMicros: number | null;
  creditFailedAnswers: boolean;
  acceptX402: boolean;
};

export function parseBillingMode(value: unknown, field = "billing"): BillingMode {
  if (!(BILLING_MODES as readonly unknown[]).includes(value)) throw new ApiValidationError(`${field} must be prepaid or postpaid`);
  return value as BillingMode;
}

function parseOptionalCap(value: unknown, field: string): number | null {
  if (value === null || value === 0) return null;
  return parseInteger(value, field, 1, MAX_POSTPAID_CAP_MICROS);
}

function parsePerMinute(value: unknown): number | null {
  if (value === null || value === 0) return null;
  return parseInteger(value, "requestsPerMinute", 1, MAX_PER_MINUTE);
}

export function parsePlan(body: unknown, existing?: PlanRow): ParsedPlan {
  const record = requireRecord(body);
  rejectUnknownKeys(record, FIELDS);
  if (!existing && record.pricePerRequestMicros === undefined) {
    throw new ApiClientError("pricePerRequestMicros is required", 400);
  }
  return {
    name: record.name === undefined && existing ? existing.name : parseName(record.name),
    pricePerRequestMicros:
      record.pricePerRequestMicros === undefined && existing
        ? existing.pricePerRequestMicros
        : parseAmount(record.pricePerRequestMicros, "pricePerRequestMicros"),
    includedRequestsPerMonth:
      record.includedRequestsPerMonth === undefined
        ? existing?.includedRequestsPerMonth ?? 0
        : parseInteger(record.includedRequestsPerMonth, "includedRequestsPerMonth", 0, MAX_INCLUDED),
    requestsPerMinute:
      record.requestsPerMinute === undefined ? existing?.requestsPerMinute ?? null : parsePerMinute(record.requestsPerMinute),
    billing: record.billing === undefined ? ((existing?.billing as BillingMode | undefined) === "postpaid" ? "postpaid" : "prepaid") : parseBillingMode(record.billing),
    postpaidCapMicros:
      record.postpaidCapMicros === undefined ? existing?.postpaidCapMicros ?? null : parseOptionalCap(record.postpaidCapMicros, "postpaidCapMicros"),
    postpaidThresholdMicros:
      record.postpaidThresholdMicros === undefined
        ? existing?.postpaidThresholdMicros ?? null
        : parseOptionalCap(record.postpaidThresholdMicros, "postpaidThresholdMicros"),
    creditFailedAnswers:
      record.creditFailedAnswers === undefined ? existing?.creditFailedAnswers ?? false : parseBoolean(record.creditFailedAnswers, "creditFailedAnswers"),
    acceptX402: record.acceptX402 === undefined ? existing?.acceptX402 ?? false : parseBoolean(record.acceptX402, "acceptX402"),
  };
}

/**
 * Rules between fields: a postpaid plan needs a cap, the threshold stays
 * within it, and failed-answer credits need the access-log pipeline.
 */
function assertPlanConsistent(input: ParsedPlan, existing?: PlanRow): void {
  if (input.billing === "postpaid" && input.postpaidCapMicros === null) {
    throw new ApiValidationError("postpaidCapMicros is required for a postpaid plan: it caps the usage a consumer can run up unpaid");
  }
  if (input.postpaidThresholdMicros !== null && input.postpaidCapMicros !== null && input.postpaidThresholdMicros > input.postpaidCapMicros) {
    throw new ApiValidationError("postpaidThresholdMicros must not be above postpaidCapMicros");
  }
  // Turning the option on needs ClickHouse; a plan that has it keeps it (it pauses without ClickHouse).
  if (input.creditFailedAnswers && !existing?.creditFailedAnswers && !isAnalyticsEnabled()) {
    throw new ApiConflictError(ANALYTICS_REQUIRED);
  }
}

export function toPlanView(row: PlanRow, consumerCount: number): PlanView {
  return {
    id: row.id,
    name: row.name,
    pricePerRequestMicros: row.pricePerRequestMicros,
    includedRequestsPerMonth: row.includedRequestsPerMonth,
    requestsPerMinute: row.requestsPerMinute,
    billing: row.billing === "postpaid" ? "postpaid" : "prepaid",
    postpaidCapMicros: row.postpaidCapMicros,
    postpaidThresholdMicros: row.postpaidThresholdMicros,
    creditFailedAnswers: row.creditFailedAnswers,
    acceptX402: row.acceptX402,
    consumerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function consumerCounts(): Promise<Map<number, number>> {
  const rows = await appDb
    .select({ planId: monetizationConsumers.planId, total: count() })
    .from(monetizationConsumers)
    .groupBy(monetizationConsumers.planId);
  return new Map(rows.filter((row) => row.planId !== null).map((row) => [row.planId as number, row.total]));
}

export async function listPlans(): Promise<PlanView[]> {
  const counts = await consumerCounts();
  const rows = await appDb.select().from(monetizationPlans).orderBy(asc(monetizationPlans.name), asc(monetizationPlans.id));
  return rows.map((row) => toPlanView(row, counts.get(row.id) ?? 0));
}

export async function getPlanRow(id: number): Promise<PlanRow | null> {
  return await first(appDb.select().from(monetizationPlans).where(eq(monetizationPlans.id, id)).limit(1)) ?? null;
}

async function requirePlanRow(id: number): Promise<PlanRow> {
  const row = await getPlanRow(id);
  if (!row) throw new ApiClientError(PLAN_NOT_FOUND, 404);
  return row;
}

export async function getPlan(id: number): Promise<PlanView> {
  return toPlanView(await requirePlanRow(id), (await consumerCounts()).get(id) ?? 0);
}

async function assertNameFree(name: string, exceptId?: number): Promise<void> {
  const clash = (await appDb
    .select({ id: monetizationPlans.id })
    .from(monetizationPlans)
    .where(sql`lower(${monetizationPlans.name}) = lower(${name})`))
    .find((row) => row.id !== exceptId);
  if (clash) throw new ApiConflictError("A plan with this name already exists");
}

export async function createPlan(body: unknown, actorUserId: number): Promise<PlanView> {
  await requireFeature(FEATURE);
  const input = parsePlan(body);
  assertPlanConsistent(input);
  const stamp = nowIso();
  // The name check and the insert in one transaction: two plans never share a name.
  const row = await appDb.transaction(async (tx) => {
    await assertNameFree(input.name);
    return (await first(tx.insert(monetizationPlans).values({ ...input, createdAt: stamp, updatedAt: stamp }).returning()))!;
  });
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "monetization_plan",
    entityId: row.id,
    summary: `Created API plan ${row.name}`,
    data: input,
  });
  return toPlanView(row, 0);
}

export async function updatePlan(id: number, body: unknown, actorUserId: number): Promise<PlanView> {
  const existing = await requirePlanRow(id);
  await requireFeature(FEATURE);
  const input = parsePlan(body, existing);
  assertPlanConsistent(input, existing);
  await assertPlanBillingChangeable(existing, input);
  const row = await appDb.transaction(async (tx) => {
    await assertNameFree(input.name, id);
    return (await first(tx
      .update(monetizationPlans)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(monetizationPlans.id, id))
      .returning()))!;
  });
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "monetization_plan",
    entityId: id,
    summary: `Updated API plan ${row.name}`,
    data: input,
  });
  return toPlanView(row, (await consumerCounts()).get(id) ?? 0);
}

/**
 * Switching between prepaid and postpaid settles first: consumers whose
 * billing would change (those on the plan without billing of their own) must
 * owe nothing (no negative balance) and have no charge on its way, and no
 * replica may gate with this master's shared state; a plan that consumers
 * use postpaid keeps a cap. 409 otherwise.
 */
async function assertPlanBillingChangeable(existing: PlanRow, input: ParsedPlan): Promise<void> {
  if (input.postpaidCapMicros === null) {
    const postpaidConsumers = await first(appDb
      .select({ total: count() })
      .from(monetizationConsumers)
      .where(and(eq(monetizationConsumers.planId, existing.id), eq(monetizationConsumers.billing, "postpaid"))));
    if ((postpaidConsumers?.total ?? 0) > 0 && input.billing === "prepaid") {
      throw new ApiConflictError("Consumers on this plan pay postpaid: the plan needs a cap (postpaidCapMicros)");
    }
  }
  if ((existing.billing === "postpaid" ? "postpaid" : "prepaid") === input.billing) return;
  const affected = await appDb
    .select({ id: monetizationConsumers.id, balance: monetizationConsumers.balanceMicros })
    .from(monetizationConsumers)
    .where(and(eq(monetizationConsumers.planId, existing.id), isNull(monetizationConsumers.billing)));
  if (affected.length === 0) return;
  // Replicas sharing this master's state would keep the old billing until their next sync.
  const { assertNoSharedReplicas } = await import("./postpaid");
  await assertNoSharedReplicas();
  const { effectiveCounters } = await import("./consumers");
  const rows = await appDb.select().from(monetizationConsumers).where(inArray(monetizationConsumers.id, affected.map((row) => row.id)));
  const counters = await effectiveCounters(rows);
  const owing = rows.filter((row) => (counters.get(row.id)?.balanceMicros ?? row.balanceMicros) < 0).length;
  const pending = await first(appDb
    .select({ total: count() })
    .from(monetizationPayments)
    .where(and(inArray(monetizationPayments.consumerId, affected.map((row) => row.id)), inArray(monetizationPayments.status, ["pending", "requires_action"]))));
  if (owing > 0 || (pending?.total ?? 0) > 0) {
    throw new ApiConflictError(
      `Switching between prepaid and postpaid settles first: ${owing + (pending?.total ?? 0)} consumer(s) on this plan owe an amount or ` +
        "have a charge in progress. Settle them (charge or adjust the open amount) or give them billing of their own first"
    );
  }
}

/** Never needs a license. Refused while a consumer is on the plan or a host lists it. */
export async function deletePlan(id: number, actorUserId: number): Promise<void> {
  // The checks and the delete in one transaction: no consumer or host takes the plan in between.
  const existing = await appDb.transaction(async (tx) => {
    const existing = await requirePlanRow(id);
    const consumers = (await consumerCounts()).get(id) ?? 0;
    if (consumers > 0) {
      throw new ApiConflictError(`${consumers} consumer(s) are on this plan; move them to another plan first`);
    }
    const hosts = (await tx
      .select({ allowed: monetizationHosts.allowedPlanIds })
      .from(monetizationHosts))
      .filter((row) => {
        try {
          const ids: unknown = JSON.parse(row.allowed);
          return Array.isArray(ids) && ids.includes(id);
        } catch {
          return false;
        }
      }).length;
    if (hosts > 0) {
      throw new ApiConflictError(`${hosts} monetized host(s) allow this plan; remove it from their allowed plans first`);
    }
    await tx.delete(monetizationPlans).where(eq(monetizationPlans.id, id));
    return existing;
  });
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "monetization_plan",
    entityId: id,
    summary: `Deleted API plan ${existing.name}`,
  });
}
