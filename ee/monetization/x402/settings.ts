// SPDX-License-Identifier: Elastic-2.0
/**
 * x402 settings (settings key "monetization_x402"), on Stripe's machine
 * payments (docs.stripe.com/payments/machine/x402):
 *
 *  - enabled, and the price of a request in US cents (Stripe records USDC as
 *    USD; at least 1 cent, as Stripe needs). A host may set its own price.
 *  - network: Base (eip155:8453), the only network Stripe's x402 supports.
 *  - the Coinbase Developer Platform API key id and secret that authenticate
 *    the CDP facilitator (it verifies and settles payments on chain); the
 *    secret is stored with encryptSecret and never returned.
 *  - the Stripe crypto deposit address payments go to, created through the
 *    operator's Stripe key when x402 is turned on, and kept with the account
 *    it belongs to, its mode and a digest of that key. Stripe custodies what
 *    is paid to it and credits the operator's balance. x402 is offered only
 *    while that same live key is set: x402 takes real payments on Base
 *    mainnet, and a key of another account or mode would record nothing.
 *    Saving another Stripe key, or removing it, turns x402 off and clears
 *    the address (detachX402FromStripe, called by payments.ts).
 *  - whether Stripe said "Stablecoins and Crypto" is not enabled on the
 *    account, shown on the x402 tab until a later call succeeds.
 *
 * Licensing: saving needs "api_monetization"; removing (which turns x402 off)
 * never does. Paying never checks it.
 */
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { nowIso } from "@/src/lib/db";
import { requireFeature } from "@/ee/licensing/store";
import { parseBoolean, parseInteger, rejectUnknownKeys, requireRecord } from "../http";
import { readSettingRow, readStripeSecrets, writeSettingRow } from "../settings";
import { FEATURE } from "../types";
import { createDepositAddress, isLiveStripeKey, readAccountId, StripeCryptoError, stripeKeyFingerprint, StripeUnavailableError } from "./stripe-crypto";

export const X402_SETTING_KEY = "monetization_x402";
/** The networks x402 is offered on: Base only (Stripe's x402 supports USDC on Base). */
export const X402_NETWORKS = [{ id: "eip155:8453", stripe: "base", label: "Base" }] as const;
export type X402Network = (typeof X402_NETWORKS)[number]["id"];
export const DEFAULT_X402_NETWORK: X402Network = "eip155:8453";
export const MIN_X402_PRICE_CENTS = 1;
export const MAX_X402_PRICE_CENTS = 100_000;
export const DEFAULT_X402_PRICE_CENTS = 1;

/** What the x402 tab shows when Stripe says the crypto payment method is not enabled. */
export const NOT_ENABLED_MESSAGE =
  "Stripe has not enabled Stablecoins and Crypto on this account. Request it under Settings, Payment methods in the Stripe Dashboard; " +
  "Stripe reviews each request. Outside the US, the account owner must email machine-payments@stripe.com with the Stripe account ID to request access.";

const CDP_KEY_ID = /^[A-Za-z0-9/_.:-]{8,256}$/;

type StoredX402 = {
  enabled?: boolean;
  priceCents?: number;
  network?: string;
  cdpKeyId?: string | null;
  /** encryptSecret: the CDP API key secret. */
  cdpKeySecret?: string | null;
  depositAddress?: {
    id: string;
    address: string;
    livemode: boolean;
    /** The Stripe account (GET /v1/account); null when the key may not read it. */
    accountId?: string | null;
    /** stripeKeyFingerprint of the key the address was created with. */
    keyFingerprint?: string;
  } | null;
  /** When Stripe last refused for the crypto payment method not being enabled; null once a call succeeds. */
  notEnabledAt?: string | null;
};

/** The settings as the gate uses them (the secret left out: readCdpKeySecret). */
export type X402Config = {
  enabled: boolean;
  priceCents: number;
  network: X402Network;
  cdpKeyId: string | null;
  depositAddress: string | null;
  notEnabledAt: string | null;
  /** The Stripe key set now is live and the one the deposit address was created with. */
  stripeReady: boolean;
};

export type X402SettingsView = Omit<X402Config, "depositAddress"> & {
  /** Turned on, with CDP credentials, a deposit address and its live Stripe key: x402 can be offered. */
  configured: boolean;
  hasCdpKeySecret: boolean;
  depositAddress: { address: string; livemode: boolean; accountId: string | null } | null;
  /** Stripe's secret key is set (it creates the deposit address and records payments). */
  stripeConfigured: boolean;
  /** The Stripe key's mode, from its prefix; null without one. x402 needs a live key. */
  stripeMode: "live" | "test" | null;
  networks: Array<{ id: string; label: string }>;
  notEnabledMessage: string | null;
};

function readStored(stored: StoredX402 | null, stripeKey: string | null): X402Config {
  const price = stored?.priceCents;
  const address = stored?.depositAddress;
  return {
    enabled: stored?.enabled === true,
    priceCents: Number.isSafeInteger(price) && (price as number) >= MIN_X402_PRICE_CENTS && (price as number) <= MAX_X402_PRICE_CENTS ? (price as number) : DEFAULT_X402_PRICE_CENTS,
    network: DEFAULT_X402_NETWORK,
    cdpKeyId: typeof stored?.cdpKeyId === "string" && stored.cdpKeyId ? stored.cdpKeyId : null,
    depositAddress: typeof stored?.depositAddress?.address === "string" ? stored.depositAddress.address : null,
    notEnabledAt: typeof stored?.notEnabledAt === "string" ? stored.notEnabledAt : null,
    stripeReady: Boolean(
      stripeKey &&
        isLiveStripeKey(stripeKey) &&
        address?.livemode === true &&
        typeof address.keyFingerprint === "string" &&
        address.keyFingerprint === stripeKeyFingerprint(stripeKey)
    ),
  };
}

export async function readX402Config(): Promise<X402Config> {
  return readStored(await readSettingRow<StoredX402>(X402_SETTING_KEY), (await readStripeSecrets()).secretKey);
}

/** On, with the CDP key id, a deposit address and the live Stripe key it was created with (the CDP secret is checked where it is read). */
export function isX402Configured(config: X402Config): boolean {
  return Boolean(config.enabled && config.cdpKeyId && config.depositAddress && config.stripeReady);
}

/** The CDP API key secret, or null. */
export async function readCdpKeySecret(): Promise<string | null> {
  const stored = await readSettingRow<StoredX402>(X402_SETTING_KEY);
  if (typeof stored?.cdpKeySecret !== "string" || !stored.cdpKeySecret) return null;
  try {
    return decryptSecret(stored.cdpKeySecret, "x402 CDP API key secret") || null;
  } catch {
    return null;
  }
}

export async function getX402SettingsView(): Promise<X402SettingsView> {
  const stored = await readSettingRow<StoredX402>(X402_SETTING_KEY);
  const { secretKey } = await readStripeSecrets();
  const current = readStored(stored, secretKey);
  const hasCdpKeySecret = typeof stored?.cdpKeySecret === "string" && stored.cdpKeySecret.length > 0;
  const address = stored?.depositAddress;
  return {
    ...current,
    configured: isX402Configured(current) && hasCdpKeySecret,
    hasCdpKeySecret,
    depositAddress: address ? { address: address.address, livemode: address.livemode, accountId: typeof address.accountId === "string" ? address.accountId : null } : null,
    stripeConfigured: Boolean(secretKey),
    stripeMode: secretKey ? (isLiveStripeKey(secretKey) ? "live" : "test") : null,
    networks: X402_NETWORKS.map((network) => ({ id: network.id, label: network.label })),
    notEnabledMessage: current.notEnabledAt ? NOT_ENABLED_MESSAGE : null,
  };
}

/** Notes (or clears) Stripe's "not enabled" answer; the gate and the jobs call it too. */
export async function noteCryptoNotEnabled(notEnabled: boolean): Promise<void> {
  const stored = (await readSettingRow<StoredX402>(X402_SETTING_KEY)) ?? {};
  if (Boolean(stored.notEnabledAt) === notEnabled) return;
  await writeSettingRow(X402_SETTING_KEY, { ...stored, notEnabledAt: notEnabled ? nowIso() : null });
}

/**
 * {enabled?, priceCents?, network?, cdpKeyId?, cdpKeySecret?}. Fields left
 * out keep their values; an omitted or empty secret keeps the stored one.
 * Turning x402 on creates the Stripe deposit address when there is none yet.
 */
export async function saveX402Settings(body: unknown, actorUserId: number): Promise<X402SettingsView> {
  await requireFeature(FEATURE);
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["enabled", "priceCents", "network", "cdpKeyId", "cdpKeySecret"]);
  const stored = (await readSettingRow<StoredX402>(X402_SETTING_KEY)) ?? {};
  const next: StoredX402 = { ...stored };
  if (record.enabled !== undefined) next.enabled = parseBoolean(record.enabled, "enabled");
  if (record.priceCents !== undefined) next.priceCents = parseInteger(record.priceCents, "priceCents", MIN_X402_PRICE_CENTS, MAX_X402_PRICE_CENTS);
  if (record.network !== undefined && !X402_NETWORKS.some((network) => network.id === record.network)) {
    throw new ApiValidationError(`network must be ${X402_NETWORKS.map((network) => network.id).join(" or ")} (Base: the only network Stripe's x402 supports)`);
  }
  if (record.cdpKeyId !== undefined) {
    if (record.cdpKeyId === null || record.cdpKeyId === "") next.cdpKeyId = null;
    else if (typeof record.cdpKeyId !== "string" || !CDP_KEY_ID.test(record.cdpKeyId.trim())) throw new ApiValidationError("cdpKeyId must be a Coinbase Developer Platform API key id");
    else next.cdpKeyId = record.cdpKeyId.trim();
  }
  if (record.cdpKeySecret !== undefined && record.cdpKeySecret !== null && record.cdpKeySecret !== "") {
    // A base64 Ed25519 secret, or an EC private key in PEM (several lines).
    if (typeof record.cdpKeySecret !== "string" || record.cdpKeySecret.length > 4096 || record.cdpKeySecret.includes("\0")) {
      throw new ApiValidationError("cdpKeySecret must be a CDP API key secret of at most 4096 characters");
    }
    const secret = record.cdpKeySecret.trim();
    // Signs the facilitator's tokens here, without sending them: a secret that cannot sign is refused now, not on the first payment.
    try {
      // Loaded here only: the engine reads these settings on every load and needs none of the SDK. cdp-env first.
      await import("./cdp-env");
      const { createFacilitatorConfig } = await import("@coinbase/x402");
      await createFacilitatorConfig(next.cdpKeyId ?? "unchecked-key-id", secret).createAuthHeaders?.();
    } catch {
      throw new ApiValidationError("cdpKeySecret must be a CDP API key secret: a base64 Ed25519 key, or an EC private key in PEM");
    }
    next.cdpKeySecret = encryptSecret(secret);
  }
  const { secretKey } = await readStripeSecrets();
  const result = readStored(next, secretKey);
  if (result.enabled && (!result.cdpKeyId || !next.cdpKeySecret)) {
    throw new ApiValidationError("x402 needs a Coinbase Developer Platform API key id and secret (the CDP facilitator settles payments) before it is turned on");
  }
  let createdAddress = false;
  if (result.enabled && !result.stripeReady) {
    // Created here, when the operator turns x402 on: never on the request path.
    if (!secretKey) throw new ApiConflictError("Set up Stripe first: x402 payments go to a Stripe deposit address and are recorded in your Stripe balance");
    if (!isLiveStripeKey(secretKey)) {
      throw new ApiConflictError("x402 takes real payments in USDC on Base mainnet: it needs a live Stripe secret key (sk_live_… or rk_live_…), not a test key");
    }
    try {
      const accountId = await readAccountId(secretKey);
      const address = await createDepositAddress(secretKey);
      if (!address.livemode) throw new StripeCryptoError("Stripe created a test-mode deposit address with a live key", false, null);
      next.depositAddress = { ...address, accountId, keyFingerprint: stripeKeyFingerprint(secretKey) };
      next.notEnabledAt = null;
      createdAddress = true;
    } catch (error) {
      if (error instanceof StripeCryptoError && error.notEnabled) {
        await writeSettingRow(X402_SETTING_KEY, { ...stored, notEnabledAt: nowIso() });
        throw new ApiConflictError(NOT_ENABLED_MESSAGE);
      }
      if (error instanceof StripeCryptoError) throw new ApiConflictError(`${error.message}${error.code ? ` (${error.code})` : ""}`);
      if (error instanceof StripeUnavailableError) throw new ApiConflictError("Stripe could not be reached to create the deposit address; try again");
      throw error;
    }
  }
  await writeSettingRow(X402_SETTING_KEY, next);
  const { reloadMonetization } = await import("../engine");
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "monetization_x402",
    summary: createdAddress ? "Updated the x402 settings of API monetization and created the Stripe deposit address" : "Updated the x402 settings of API monetization",
    data: {
      enabled: result.enabled,
      priceCents: result.priceCents,
      network: result.network,
      cdpKeyId: result.cdpKeyId,
      cdpKeySecretChanged: typeof record.cdpKeySecret === "string" && record.cdpKeySecret.length > 0,
      depositAddress: next.depositAddress?.address ?? null,
      stripeAccountId: next.depositAddress?.accountId ?? null,
    },
  });
  return await getX402SettingsView();
}

/**
 * The Stripe secret key was replaced or removed: x402 is turned off and its
 * deposit address cleared (it belongs to the old key's account and mode;
 * payments to it would never be recorded with the new one). Turning x402 on
 * again creates an address with the new key. Payments already settled to the
 * old address stay in the attention list until they are recorded. Returns
 * whether anything changed. Never needs a license.
 */
export async function detachX402FromStripe(actorUserId: number, reason: "key_replaced" | "key_removed"): Promise<boolean> {
  const stored = await readSettingRow<StoredX402>(X402_SETTING_KEY);
  if (!stored || (!stored.enabled && !stored.depositAddress)) return false;
  await writeSettingRow(X402_SETTING_KEY, { ...stored, enabled: false, depositAddress: null, notEnabledAt: null });
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "monetization_x402",
    summary:
      reason === "key_removed"
        ? "Turned x402 off and cleared its Stripe deposit address: the Stripe secret key was removed"
        : "Turned x402 off and cleared its Stripe deposit address: the Stripe secret key was replaced",
    data: { reason, depositAddress: stored.depositAddress?.address ?? null, stripeAccountId: stored.depositAddress?.accountId ?? null },
  });
  return true;
}

/** Turns x402 off and removes the CDP credentials (the deposit address is kept). Never needs a license. */
export async function removeX402Settings(actorUserId: number): Promise<X402SettingsView> {
  const stored = (await readSettingRow<StoredX402>(X402_SETTING_KEY)) ?? {};
  await writeSettingRow(X402_SETTING_KEY, { ...stored, enabled: false, cdpKeySecret: null });
  const { reloadMonetization } = await import("../engine");
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "monetization_x402",
    summary: "Turned x402 off and removed the CDP credentials",
  });
  return await getX402SettingsView();
}
