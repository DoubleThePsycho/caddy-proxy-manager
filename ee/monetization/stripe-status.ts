// SPDX-License-Identifier: Elastic-2.0
/**
 * Whether Stripe refused the operator's secret key (HTTP 401 or 403) the
 * last time a postpaid charge was sent: a revoked, expired or under-scoped
 * key. Such a charge never reached Stripe's payment processing, so it stays
 * pending (counted as on its way, so the cap still holds), is sent again
 * once the key works, and suspends nobody. The operator is told once by an
 * audit event and, until a charge goes through or the Stripe settings are
 * saved again, by an item on the overview's "Needs attention"
 * (attention.ts). Settings key "monetization_stripe_status"; not synced.
 */
import { logAuditEvent } from "@/src/lib/audit";
import { nowIso } from "@/src/lib/db";
import { deleteSettingRow, readSettingRow, writeSettingRow } from "./settings";

export const STRIPE_STATUS_SETTING_KEY = "monetization_stripe_status";
/** The failure code a charge refused for the key keeps while it waits. */
export const STRIPE_KEY_REJECTED = "stripe_key_rejected";

export type StripeKeyRejection = { rejectedAt: string; httpStatus: number };

export async function readStripeKeyRejection(): Promise<StripeKeyRejection | null> {
  const stored = await readSettingRow<Partial<StripeKeyRejection>>(STRIPE_STATUS_SETTING_KEY);
  return stored && typeof stored.rejectedAt === "string" && typeof stored.httpStatus === "number"
    ? { rejectedAt: stored.rejectedAt, httpStatus: stored.httpStatus }
    : null;
}

/** Stripe refused the key: noted once (audit event, attention item). */
export async function noteStripeKeyRejected(httpStatus: number): Promise<void> {
  if (await readStripeKeyRejection()) return;
  await writeSettingRow(STRIPE_STATUS_SETTING_KEY, { rejectedAt: nowIso(), httpStatus });
  console.warn(`[monetization] Stripe refused the secret key (HTTP ${httpStatus}); postpaid charges wait until it works`);
  await logAuditEvent({
    userId: null,
    action: "stripe_key_rejected",
    entityType: "monetization_stripe",
    summary: `Stripe refused the secret key (HTTP ${httpStatus}): postpaid charges wait until it works, and no consumer is suspended`,
    data: { httpStatus },
  });
}

/** Stripe accepted the key again, or the settings were saved: the note goes. */
export async function clearStripeKeyRejection(): Promise<void> {
  if (await readStripeKeyRejection()) await deleteSettingRow(STRIPE_STATUS_SETTING_KEY);
}
