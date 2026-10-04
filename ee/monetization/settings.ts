// SPDX-License-Identifier: Elastic-2.0
/**
 * Stored settings of API monetization, in the settings table:
 *
 *  - "monetization_gate": the per-install gate token (encryptSecret) that the
 *    generated Caddy configuration sends with every gate subrequest, and the
 *    install id written into Stripe Checkout metadata so that a Stripe account
 *    shared by several installs only credits its own sessions.
 *  - "monetization_payments": the customer's Stripe secret key and webhook
 *    signing secret (both encryptSecret, never returned), the currency, the
 *    top-up amounts offered to consumers and an optional top-up URL.
 *
 * Secret rotation re-encrypts both rows like every other encrypted string in
 * a settings value (src/lib/secret-rotation.ts). Neither key is part of
 * configuration export or instance sync: monetization is master-only.
 *
 * The gate's in-memory state reloads from these in one read-only transaction
 * (ee/monetization/engine.ts).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { settings } from "@/src/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { DEFAULT_CURRENCY, isCurrencyCode } from "./money";
import { first } from "@/src/lib/db/ops";

export const GATE_SETTING_KEY = "monetization_gate";
export const PAYMENTS_SETTING_KEY = "monetization_payments";

export type GateSecret = { token: string; installId: string };

export type StoredPayments = {
  secretKey?: string;
  webhookSecret?: string;
  currency?: string;
  topUpAmountsMicros?: number[];
  topUpUrl?: string | null;
  /** Stripe Tax on Checkout Sessions (the operator's option). */
  automaticTax?: boolean;
};

export async function readSettingRow<T>(key: string): Promise<T | null> {
  const row = await first(appDb.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1));
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function writeSettingRow(key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value);
  const updatedAt = nowIso();
  await appDb.insert(settings)
    .values({ key, value: payload, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value: payload, updatedAt } });
}

export async function deleteSettingRow(key: string): Promise<void> {
  await appDb.delete(settings).where(eq(settings.key, key));
}

function decryptOrNull(value: unknown, context: string): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return decryptSecret(value, context) || null;
  } catch {
    return null;
  }
}

/** The stored gate secret, or null when there is none or no key decrypts it. */
export async function readGateSecret(): Promise<GateSecret | null> {
  const stored = await readSettingRow<{ token?: unknown; installId?: unknown }>(GATE_SETTING_KEY);
  if (!stored) return null;
  const token = decryptOrNull(stored.token, "API monetization gate token");
  if (!token || typeof stored.installId !== "string" || !stored.installId) return null;
  return { token, installId: stored.installId };
}

/**
 * The gate secret, generated on first use. A token no key decrypts (a
 * SESSION_SECRET change without SESSION_SECRET_PREVIOUS) is replaced: only
 * Caddy and this process use it, and the next configuration apply sends Caddy
 * the new one. The install id is kept whenever it can be read.
 */
export async function ensureGateSecret(): Promise<GateSecret> {
  // Every Caddy configuration build asks for the secret: read it first, so
  // that only a missing or undecryptable one opens a writing transaction
  // (which takes the database's write lock).
  const stored = await readGateSecret();
  if (stored) return stored;
  // Read again and create in one transaction: two callers never create two secrets.
  return await appDb.transaction(async () => {
    const existing = await readGateSecret();
    if (existing) return existing;
    const stored = await readSettingRow<{ installId?: unknown }>(GATE_SETTING_KEY);
    const installId = typeof stored?.installId === "string" && stored.installId ? stored.installId : randomUUID();
    const token = randomBytes(32).toString("hex");
    await writeSettingRow(GATE_SETTING_KEY, { token: encryptSecret(token), installId });
    return { token, installId };
  }, { behavior: "immediate" });
}

export async function readStoredPayments(): Promise<StoredPayments> {
  return await readSettingRow<StoredPayments>(PAYMENTS_SETTING_KEY) ?? {};
}

export async function readCurrency(given?: StoredPayments): Promise<string> {
  const stored = given ?? (await readStoredPayments());
  return isCurrencyCode(stored.currency) ? stored.currency : DEFAULT_CURRENCY;
}

/** Decrypted Stripe secrets for the payment paths; null fields when missing or undecryptable. */
export async function readStripeSecrets(given?: StoredPayments): Promise<{
  secretKey: string | null;
  webhookSecret: string | null;
}> {
  const stored = given ?? (await readStoredPayments());
  return {
    secretKey: decryptOrNull(stored.secretKey, "API monetization Stripe secret key"),
    webhookSecret: decryptOrNull(stored.webhookSecret, "API monetization Stripe webhook secret"),
  };
}
