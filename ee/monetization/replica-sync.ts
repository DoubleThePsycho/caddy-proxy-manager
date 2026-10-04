// SPDX-License-Identifier: Elastic-2.0
/**
 * API monetization and instance sync (replica-index.ts says what the
 * section is): the master builds it into every sync payload while replica
 * serving is on (options.ts), and a replica reads its stored copy for the
 * gate's index, the Caddy configuration and the balance store.
 *
 * Without a usable mode (off, or "shared" while this master's shared state
 * is off) there is no section: monetized hosts stay out of the payload and
 * replicas do not serve them, as before.
 */
import { eq, isNull } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  monetizationConsumers,
  monetizationHosts,
  monetizationKeys,
  monetizationPlans,
  proxyHosts,
  wafRuleExclusions,
} from "@/src/lib/db/schema";
import { config } from "@/src/lib/config";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/src/lib/secret";
import { readAllowedPlanIds } from "./host-guard";
import { getMonetizationOptions, replicaGateBaseUrl, replicaModeProblem } from "./options";
import { parseReplicaSection, REPLICA_INDEX_VERSION, REPLICA_SETTING_KEY, type ReplicaIndexValue } from "./replica-index";
import { readCurrency, readStoredPayments } from "./settings";
import { PORTAL_PATH } from "./types";

type ProxyHostRow = typeof proxyHosts.$inferSelect;
type ExclusionRow = typeof wafRuleExclusions.$inferSelect;

/**
 * The master's section for the sync payload, or null when replicas do not
 * serve monetized hosts. `rows` and `exclusions` are the payload's source
 * (live, or a fleet revision); the hosts are the ones monetized now. Key
 * digests are encrypted here, so the payload builder seals them like every
 * other secret in synced settings.
 */
export async function buildReplicaSection(rows: ProxyHostRow[], exclusions: ExclusionRow[]): Promise<ReplicaIndexValue | null> {
  const options = await getMonetizationOptions();
  if (options.replicaMode === "off") return null;
  if (await replicaModeProblem(options)) return null;
  // The monetized hosts of this payload's source: a fleet revision sends only its own.
  const sourceIds = new Set(rows.map((row) => row.id));
  const hosts = (await appDb.select().from(monetizationHosts).where(eq(monetizationHosts.enabled, true))).filter((host) => sourceIds.has(host.proxyHostId));
  if (hosts.length === 0) return null;
  const hostIds = new Set(hosts.map((host) => host.proxyHostId));
  let namespace: string | null = null;
  if (options.replicaMode === "shared") {
    const { resolveSharedState } = await import("@/ee/high-availability/shared-state/connection");
    const resolved = await resolveSharedState();
    if (resolved.status !== "on") return null;
    namespace = resolved.namespace;
  }
  const payments = await readStoredPayments();
  const plans = await appDb.select().from(monetizationPlans).orderBy(monetizationPlans.id);
  const consumers = await appDb.select().from(monetizationConsumers).orderBy(monetizationConsumers.id);
  const keys = await appDb.select().from(monetizationKeys).where(isNull(monetizationKeys.revokedAt)).orderBy(monetizationKeys.id);
  return {
    v: REPLICA_INDEX_VERSION,
    mode: options.replicaMode,
    namespace,
    gateUrl: options.replicaMode === "allowance" ? replicaGateBaseUrl(options) : null,
    currency: await readCurrency(payments),
    topUpUrl: typeof payments.topUpUrl === "string" && payments.topUpUrl ? payments.topUpUrl : `${config.baseUrl}${PORTAL_PATH}`,
    hosts: hosts.map((host) => ({ proxyHostId: host.proxyHostId, keyHeader: host.keyHeader, allowedPlanIds: readAllowedPlanIds(host.allowedPlanIds) })),
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceMicros: Math.max(0, plan.pricePerRequestMicros),
      includedPerMonth: Math.max(0, plan.includedRequestsPerMonth),
      perMinute: plan.requestsPerMinute && plan.requestsPerMinute > 0 ? plan.requestsPerMinute : null,
      billing: plan.billing === "postpaid" ? "postpaid" : "prepaid",
      capMicros: plan.postpaidCapMicros,
      creditFailed: plan.creditFailedAnswers,
    })),
    consumers: consumers.map((consumer) => ({
      id: consumer.id,
      active: consumer.status === "active",
      planId: consumer.planId,
      overdraftMicros: Math.max(0, consumer.overdraftAllowanceMicros),
      billing: consumer.billing === "prepaid" || consumer.billing === "postpaid" ? consumer.billing : null,
      hasCard: Boolean(consumer.paymentMethodId),
      cardExpMonth: consumer.cardExpMonth,
      cardExpYear: consumer.cardExpYear,
      suspended: consumer.suspendedAt ? consumer.suspendedReason ?? "payment_failed" : null,
    })),
    keys: keys.map((key) => ({ id: key.id, consumerId: key.consumerId, prefix: key.prefix, hash: encryptSecret(key.keyHash) })),
    proxyHosts: rows.filter((row) => hostIds.has(row.id)).map((row) => ({ ...row, ownerUserId: null })),
    wafRuleExclusions: exclusions
      .filter((row) => row.proxyHostId !== null && hostIds.has(row.proxyHostId))
      .map((row) => ({ ...row, createdBy: null })),
  };
}

/** The stored section of a replica, with the key digests decrypted; null without one. */
export async function readReplicaSection(): Promise<ReplicaIndexValue | null> {
  const { getSyncedSetting } = await import("@/src/lib/instance-sync");
  const section = parseReplicaSection(await getSyncedSetting<unknown>(REPLICA_SETTING_KEY));
  if (!section) return null;
  const keys = section.keys.flatMap((key) => {
    try {
      const hash = isEncryptedSecret(key.hash) ? decryptSecret(key.hash, "API monetization replica key digest") : key.hash;
      return /^[a-f0-9]{64}$/.test(hash) ? [{ ...key, hash }] : [];
    } catch {
      // A digest no key here decrypts: that key is refused (401) until the next sync.
      return [];
    }
  });
  return { ...section, keys };
}

// ── Telling replicas about changes ───────────────────────────────────

const DEBOUNCE_MS = 2_000;
const syncStore = globalThis as typeof globalThis & { __ingressiReplicaSyncTimer?: ReturnType<typeof setTimeout> | null };

/**
 * After a change to what replicas gate with (plans, consumers, keys, hosts,
 * the replica mode): pushes the configuration to the sync slaves soon
 * (debounced; pull replicas fetch it with their next poll). Does nothing
 * unless this instance is a master serving monetized hosts on replicas.
 */
export function announceReplicaIndexChange(): void {
  if (process.env.NODE_ENV === "test") return;
  if (syncStore.__ingressiReplicaSyncTimer) return;
  syncStore.__ingressiReplicaSyncTimer = setTimeout(() => {
    syncStore.__ingressiReplicaSyncTimer = null;
    void (async () => {
      const { getInstanceMode, syncInstances } = await import("@/src/lib/instance-sync");
      if ((await getInstanceMode()) !== "master") return;
      if ((await getMonetizationOptions()).replicaMode === "off") return;
      await syncInstances();
    })().catch((error: unknown) => {
      console.warn("[monetization] Sending gate changes to replicas failed; the periodic sync sends them:", error instanceof Error ? error.name : typeof error);
    });
  }, DEBOUNCE_MS);
  syncStore.__ingressiReplicaSyncTimer.unref?.();
}
