// SPDX-License-Identifier: Elastic-2.0
/**
 * API consumers: who pays for requests, their keys, balance adjustments and
 * the self-service portal link.
 *
 * Licensing: creating a consumer, any change that is not only disabling it,
 * creating keys, adjusting balances and issuing portal links need
 * "api_monetization". Disabling or deleting a consumer, revoking a key and
 * turning the portal link off never do. Nothing at request time checks it.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationConsumers, monetizationKeys, monetizationPlans } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { config } from "@/src/lib/config";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { refreshConsumer, reloadMonetization } from "./engine";
import { monetizationBalanceStore, type LiveCounters } from "./balance-store";
import { effectiveBilling, postpaidViews, switchBilling } from "./postpaid";
import { listPayments } from "./stripe-payments";
import { parseBillingMode } from "./plans";
import { generateConsumerKey, generatePortalToken } from "./keys";
import { MAX_AMOUNT_MICROS } from "./money";
import {
  isRecord,
  parseAmount,
  parseInteger,
  parseName,
  parseOptionalText,
  rejectUnknownKeys,
  requireRecord,
} from "./http";
import {
  CONSUMER_STATUSES,
  FEATURE,
  MAX_KEYS_PER_CONSUMER,
  PORTAL_PATH,
  type ConsumerDetailView,
  type ConsumerKeyView,
  type ConsumerStatus,
  type BillingMode,
  type ConsumerView,
  type LedgerEntryView,
  type PostpaidView,
} from "./types";
import { asc, first } from "@/src/lib/db/ops";

export const CONSUMER_NOT_FOUND = "Consumer not found";
export const KEY_NOT_FOUND = "API key not found";

const FIELDS = ["name", "email", "status", "planId", "overdraftAllowanceMicros", "billing"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ConsumerRow = typeof monetizationConsumers.$inferSelect;
type KeyRow = typeof monetizationKeys.$inferSelect;

type ParsedConsumer = {
  name: string;
  email: string | null;
  status: ConsumerStatus;
  planId: number | null;
  overdraftAllowanceMicros: number;
  /** The consumer's own billing; null: the plan's. */
  billing: BillingMode | null;
};

function parseStatus(value: unknown): ConsumerStatus {
  if (!(CONSUMER_STATUSES as readonly unknown[]).includes(value)) {
    throw new ApiValidationError(`status must be one of ${CONSUMER_STATUSES.join(", ")}`);
  }
  return value as ConsumerStatus;
}

function parseEmail(value: unknown): string | null {
  const email = parseOptionalText(value, "email", 254);
  if (email !== null && !EMAIL.test(email)) throw new ApiValidationError("email must be an e-mail address");
  return email;
}

async function parsePlanId(value: unknown): Promise<number | null> {
  if (value === null) return null;
  const id = parseInteger(value, "planId", 1, Number.MAX_SAFE_INTEGER);
  if (!await first(appDb.select({ id: monetizationPlans.id }).from(monetizationPlans).where(eq(monetizationPlans.id, id)).limit(1))) {
    throw new ApiValidationError("planId names no plan");
  }
  return id;
}

export async function parseConsumer(body: unknown, existing?: ConsumerRow): Promise<ParsedConsumer> {
  const record = requireRecord(body);
  rejectUnknownKeys(record, FIELDS);
  return {
    name: record.name === undefined && existing ? existing.name : parseName(record.name),
    email: record.email === undefined ? existing?.email ?? null : parseEmail(record.email),
    status:
      record.status === undefined ? ((existing?.status as ConsumerStatus | undefined) ?? "active") : parseStatus(record.status),
    planId: record.planId === undefined ? existing?.planId ?? null : await parsePlanId(record.planId),
    overdraftAllowanceMicros:
      record.overdraftAllowanceMicros === undefined
        ? existing?.overdraftAllowanceMicros ?? 0
        : parseAmount(record.overdraftAllowanceMicros, "overdraftAllowanceMicros"),
    billing:
      record.billing === undefined
        ? existing?.billing === "prepaid" || existing?.billing === "postpaid" ? existing.billing : null
        : record.billing === null ? null : parseBillingMode(record.billing),
  };
}

/** A postpaid consumer needs a plan with a cap: it bounds what the consumer can owe. */
async function assertBillingPossible(input: ParsedConsumer): Promise<void> {
  const plan = input.planId === null ? null : await first(appDb.select().from(monetizationPlans).where(eq(monetizationPlans.id, input.planId)).limit(1));
  if (effectiveBilling(input, plan) === "postpaid" && !plan?.postpaidCapMicros) {
    throw new ApiValidationError("A postpaid consumer needs a plan with a postpaid cap: the cap bounds what it can owe");
  }
}

/** True when the body only disables the consumer (other fields repeat their stored values). */
export function isDisableOnlyUpdate(body: unknown, existing: ConsumerRow): boolean {
  if (!isRecord(body) || body.status !== "disabled") return false;
  const stored: Record<string, unknown> = {
    name: existing.name,
    email: existing.email,
    planId: existing.planId,
    overdraftAllowanceMicros: existing.overdraftAllowanceMicros,
    billing: existing.billing,
  };
  return Object.entries(body).every(([key, value]) => {
    if (key === "status") return true;
    if (!(key in stored)) return false;
    if (key === "email" && (value === "" || value === null)) return existing.email === null;
    return typeof value === "string" ? value.trim() === stored[key] : value === stored[key];
  });
}

type PlanInfo = { name: string; billing: string };

async function planInfo(): Promise<Map<number, PlanInfo>> {
  return new Map(
    (await appDb.select({ id: monetizationPlans.id, name: monetizationPlans.name, billing: monetizationPlans.billing }).from(monetizationPlans))
      .map((row) => [row.id, { name: row.name, billing: row.billing }])
  );
}

async function activeKeyCounts(): Promise<Map<number, number>> {
  const rows = await appDb
    .select({ consumerId: monetizationKeys.consumerId, total: count() })
    .from(monetizationKeys)
    .where(isNull(monetizationKeys.revokedAt))
    .groupBy(monetizationKeys.consumerId);
  return new Map(rows.map((row) => [row.consumerId, row.total]));
}

/**
 * Balances and free usage as the gate sees them: including what it counted
 * since the last write to SQLite, or the shared counters with high
 * availability shared state.
 */
export async function effectiveCounters(rows: ConsumerRow[]): Promise<Map<number, LiveCounters>> {
  if (rows.length === 0) return new Map();
  return (await monetizationBalanceStore()).liveCounters(rows);
}

function toView(
  row: ConsumerRow,
  plans: Map<number, PlanInfo>,
  keyCount: number,
  counters: LiveCounters | undefined,
  postpaid: PostpaidView | null
): ConsumerView {
  const plan = row.planId === null ? undefined : plans.get(row.planId);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status === "disabled" ? "disabled" : "active",
    planId: row.planId,
    planName: plan?.name ?? null,
    billingOverride: row.billing === "prepaid" || row.billing === "postpaid" ? row.billing : null,
    billing: effectiveBilling(row, plan ?? null),
    postpaid,
    balanceMicros: counters?.balanceMicros ?? row.balanceMicros,
    includedRequestsUsed: counters?.includedRequestsUsed ?? 0,
    overdraftAllowanceMicros: row.overdraftAllowanceMicros,
    hasPortalLink: Boolean(row.portalTokenHash),
    activeKeyCount: keyCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toKeyView(row: KeyRow): ConsumerKeyView {
  return {
    id: row.id,
    consumerId: row.consumerId,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export async function listConsumers(): Promise<ConsumerView[]> {
  const plans = await planInfo();
  const keys = await activeKeyCounts();
  const rows = await appDb
    .select()
    .from(monetizationConsumers)
    .orderBy(asc(monetizationConsumers.name), asc(monetizationConsumers.id));
  const counters = await effectiveCounters(rows);
  const postpaid = await postpaidViews(rows, counters);
  return rows.map((row) => toView(row, plans, keys.get(row.id) ?? 0, counters.get(row.id), postpaid.get(row.id) ?? null));
}

export async function getConsumerRow(id: number): Promise<ConsumerRow | null> {
  return await first(appDb.select().from(monetizationConsumers).where(eq(monetizationConsumers.id, id)).limit(1)) ?? null;
}

async function requireConsumerRow(id: number): Promise<ConsumerRow> {
  const row = await getConsumerRow(id);
  if (!row) throw new ApiClientError(CONSUMER_NOT_FOUND, 404);
  return row;
}

export async function listKeyRows(consumerId: number): Promise<KeyRow[]> {
  return await appDb
    .select()
    .from(monetizationKeys)
    .where(eq(monetizationKeys.consumerId, consumerId))
    .orderBy(asc(monetizationKeys.id));
}

export async function getConsumer(id: number): Promise<ConsumerDetailView> {
  const row = await requireConsumerRow(id);
  const keys = await listKeyRows(id);
  const counters = await effectiveCounters([row]);
  const postpaid = await postpaidViews([row], counters);
  const view = toView(row, await planInfo(), keys.filter((key) => !key.revokedAt).length, counters.get(row.id), postpaid.get(row.id) ?? null);
  return { ...view, keys: keys.map(toKeyView), payments: await listPayments({ consumerId: id, limit: 20 }) };
}

function auditData(input: ParsedConsumer) {
  return { ...input, email: input.email ? "(set)" : null };
}

export async function createConsumer(body: unknown, actorUserId: number): Promise<ConsumerDetailView> {
  await requireFeature(FEATURE);
  const input = await parseConsumer(body);
  await assertBillingPossible(input);
  const stamp = nowIso();
  const row = (await first(appDb
    .insert(monetizationConsumers)
    .values({ ...input, createdBy: actorUserId, createdAt: stamp, updatedAt: stamp })
    .returning()))!;
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "monetization_consumer",
    entityId: row.id,
    summary: `Created API consumer ${row.name}`,
    data: auditData(input),
  });
  return getConsumer(row.id);
}

export async function updateConsumer(id: number, body: unknown, actorUserId: number): Promise<ConsumerDetailView> {
  const existing = await requireConsumerRow(id);
  if (!isDisableOnlyUpdate(body, existing)) await requireFeature(FEATURE);
  const input = await parseConsumer(body, existing);
  await assertBillingPossible(input);
  // A change of the billing in effect goes through switchBilling: under the consumer's charge lock,
  // the open amount charged first when it leaves postpaid.
  const planBefore = existing.planId === null ? null : await first(appDb.select().from(monetizationPlans).where(eq(monetizationPlans.id, existing.planId)).limit(1));
  const planAfter = input.planId === null ? null : await first(appDb.select().from(monetizationPlans).where(eq(monetizationPlans.id, input.planId)).limit(1));
  const from = effectiveBilling(existing, planBefore);
  const write = async () => {
    await appDb.update(monetizationConsumers).set({ ...input, updatedAt: nowIso() }).where(eq(monetizationConsumers.id, id));
    await refreshConsumer(id);
  };
  if (from !== effectiveBilling(input, planAfter)) await switchBilling(existing, from, write);
  else await write();
  // With shared state, every node refuses (or accepts) the consumer at once.
  if (input.status !== existing.status) await (await monetizationBalanceStore()).consumerStatusChanged(id, input.status === "active");
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "monetization_consumer",
    entityId: id,
    summary:
      input.status !== existing.status
        ? `${input.status === "disabled" ? "Disabled" : "Enabled"} API consumer ${input.name}`
        : `Updated API consumer ${input.name}`,
    data: auditData(input),
  });
  return getConsumer(id);
}

/**
 * Deletes the consumer and its keys. Its usage is written first; its ledger
 * rows are kept as the record of what was paid and used. Never needs a license.
 */
export async function deleteConsumer(id: number, actorUserId: number): Promise<void> {
  const existing = await requireConsumerRow(id);
  const store = await monetizationBalanceStore();
  await store.beforeConsumerDeleted(id);
  await appDb.transaction(async (tx) => {
    await tx.delete(monetizationKeys).where(eq(monetizationKeys.consumerId, id));
    await tx.delete(monetizationConsumers).where(eq(monetizationConsumers.id, id));
  });
  await store.consumerDeleted(id);
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "monetization_consumer",
    entityId: id,
    summary: `Deleted API consumer ${existing.name}`,
    data: { balanceMicros: existing.balanceMicros },
  });
}

// ── Keys ─────────────────────────────────────────────────────────────

export async function listConsumerKeys(consumerId: number): Promise<ConsumerKeyView[]> {
  await requireConsumerRow(consumerId);
  return (await listKeyRows(consumerId)).map(toKeyView);
}

/** Returns the key once; only its SHA-256 and public prefix are stored. */
export async function createConsumerKey(
  consumerId: number,
  body: unknown,
  actorUserId: number
): Promise<{ key: ConsumerKeyView; rawKey: string }> {
  const consumer = await requireConsumerRow(consumerId);
  await requireFeature(FEATURE);
  const record = body === undefined || body === null ? {} : requireRecord(body);
  rejectUnknownKeys(record, ["name"]);
  const name = parseOptionalText(record.name, "name", 100);
  // The limit, the prefix check and the insert in one transaction: they hold under concurrent requests.
  const { row, generated } = await appDb.transaction(async (tx) => {
    const active = (await listKeyRows(consumerId)).filter((key) => !key.revokedAt).length;
    if (active >= MAX_KEYS_PER_CONSUMER) {
      throw new ApiConflictError(`A consumer can have at most ${MAX_KEYS_PER_CONSUMER} active keys; revoke one first`);
    }
    let generated = generateConsumerKey();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const clash = await first(tx.select({ id: monetizationKeys.id }).from(monetizationKeys).where(eq(monetizationKeys.prefix, generated.prefix)).limit(1));
      if (!clash) break;
      generated = generateConsumerKey();
    }
    const row = (await first(tx
      .insert(monetizationKeys)
      .values({ consumerId, name, prefix: generated.prefix, keyHash: generated.hash, createdAt: nowIso() })
      .returning()))!;
    return { row, generated };
  });
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "monetization_key",
    entityId: row.id,
    summary: `Created API key ${row.prefix} for consumer ${consumer.name}`,
    data: { consumerId, name, prefix: row.prefix },
  });
  return { key: toKeyView(row), rawKey: generated.raw };
}

/** Never needs a license. Revoking a revoked key changes nothing. */
export async function revokeConsumerKey(consumerId: number, keyId: number, actorUserId: number): Promise<void> {
  const consumer = await requireConsumerRow(consumerId);
  const key = await first(appDb
    .select()
    .from(monetizationKeys)
    .where(and(eq(monetizationKeys.id, keyId), eq(monetizationKeys.consumerId, consumerId)))
    .limit(1));
  if (!key) throw new ApiClientError(KEY_NOT_FOUND, 404);
  if (key.revokedAt) return;
  await appDb.update(monetizationKeys).set({ revokedAt: nowIso() }).where(eq(monetizationKeys.id, keyId));
  await reloadMonetization();
  // With shared state, every node refuses the key at once.
  await (await monetizationBalanceStore()).keyRevoked(consumerId, keyId);
  await logAuditEvent({
    userId: actorUserId,
    action: "revoke",
    entityType: "monetization_key",
    entityId: keyId,
    summary: `Revoked API key ${key.prefix} of consumer ${consumer.name}`,
    data: { consumerId, prefix: key.prefix },
  });
}

// ── Balance ──────────────────────────────────────────────────────────

const REFERENCE = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * A manual balance change with a reason ({amountMicros, reason, reference?}).
 * A reference makes the call safe to retry: the same reference again is a 409.
 */
export async function adjustConsumerBalance(
  consumerId: number,
  body: unknown,
  actorUserId: number
): Promise<{ entry: LedgerEntryView; balanceMicros: number }> {
  const consumer = await requireConsumerRow(consumerId);
  await requireFeature(FEATURE);
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["amountMicros", "reason", "reference"]);
  const amount = parseInteger(record.amountMicros, "amountMicros", -MAX_AMOUNT_MICROS, MAX_AMOUNT_MICROS);
  if (amount === 0) throw new ApiValidationError("amountMicros must not be 0");
  const reason = parseOptionalText(record.reason, "reason", 500);
  if (!reason) throw new ApiValidationError("reason is required");
  let reference: string | null = null;
  if (record.reference !== undefined && record.reference !== null) {
    if (typeof record.reference !== "string" || !REFERENCE.test(record.reference)) {
      throw new ApiValidationError("reference must be 1-100 letters, digits or . _ : -");
    }
    reference = `adjustment:${record.reference}`;
  }
  const store = await monetizationBalanceStore();
  const result = await store.credit({
    consumerId,
    type: "adjustment",
    amountMicros: amount,
    reference,
    description: reason,
    createdBy: actorUserId,
  });
  if (result.status === "duplicate") throw new ApiConflictError("An adjustment with this reference was already made");
  if (result.status === "unknown_consumer") throw new ApiClientError(CONSUMER_NOT_FOUND, 404);
  await logAuditEvent({
    userId: actorUserId,
    action: "adjust_balance",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `Adjusted the balance of API consumer ${consumer.name} by ${amount} micro-units`,
    data: { amountMicros: amount, reason, reference, balanceMicros: result.balanceMicros },
  });
  const counters = await store.liveCounters([await requireConsumerRow(consumerId)]);
  return {
    entry: result.entry ?? pendingLedgerEntry(consumerId, consumer.name, amount, reason, reference, actorUserId),
    balanceMicros: counters.get(consumerId)?.balanceMicros ?? result.balanceMicros,
  };
}

/**
 * An adjustment applied to the shared balances (high availability) that the
 * leader has not written to the ledger yet: id 0 until it is.
 */
function pendingLedgerEntry(
  consumerId: number,
  consumerName: string,
  amountMicros: number,
  description: string,
  reference: string | null,
  createdBy: number
): LedgerEntryView {
  const stamp = nowIso();
  return {
    id: 0,
    consumerId,
    consumerName,
    type: "adjustment",
    amountMicros,
    balanceAfterMicros: 0,
    requests: 0,
    freeRequests: 0,
    reference,
    description,
    createdBy,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// ── Portal link ──────────────────────────────────────────────────────

export function portalUrl(token: string): string {
  return `${config.baseUrl}${PORTAL_PATH}/${token}`;
}

/** Issues a new portal link (the previous one stops working). Shown once. */
export async function rotatePortalLink(consumerId: number, actorUserId: number): Promise<{ url: string; token: string }> {
  const consumer = await requireConsumerRow(consumerId);
  await requireFeature(FEATURE);
  const { token, hash } = generatePortalToken();
  await appDb.update(monetizationConsumers).set({ portalTokenHash: hash, updatedAt: nowIso() }).where(eq(monetizationConsumers.id, consumerId));
  await logAuditEvent({
    userId: actorUserId,
    action: consumer.portalTokenHash ? "rotate_portal_link" : "create_portal_link",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `${consumer.portalTokenHash ? "Rotated" : "Created"} the portal link of API consumer ${consumer.name}`,
  });
  return { url: portalUrl(token), token };
}

/** Turns the portal link off. Never needs a license. */
export async function revokePortalLink(consumerId: number, actorUserId: number): Promise<void> {
  const consumer = await requireConsumerRow(consumerId);
  if (!consumer.portalTokenHash) return;
  await appDb.update(monetizationConsumers).set({ portalTokenHash: null, updatedAt: nowIso() }).where(eq(monetizationConsumers.id, consumerId));
  await logAuditEvent({
    userId: actorUserId,
    action: "revoke_portal_link",
    entityType: "monetization_consumer",
    entityId: consumerId,
    summary: `Turned off the portal link of API consumer ${consumer.name}`,
  });
}

/** The consumer behind a portal token (SHA-256 lookup), or null. */
export async function consumerByPortalTokenHash(hash: string): Promise<ConsumerRow | null> {
  return await first(appDb.select().from(monetizationConsumers).where(eq(monetizationConsumers.portalTokenHash, hash)).limit(1)) ?? null;
}
