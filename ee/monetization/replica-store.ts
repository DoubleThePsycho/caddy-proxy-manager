// SPDX-License-Identifier: Elastic-2.0
/**
 * The balance store of a sync replica (or fleet pull replica) serving
 * monetized hosts with its master's balances (replica-index.ts):
 *
 *  - "shared": the shared-state store over the Redis or Valkey settings that
 *    reached this replica with the configuration, in the master's namespace.
 *    It never seeds a consumer (it has no balances): a consumer the master's
 *    leader has not seeded yet is refused (503) for those seconds.
 *  - "allowance": allowances from the master's gate (replica-allowance.ts),
 *    with the allowance credential derived from the replica's sync secret:
 *    a pull replica's at the master URL it polls, a pushed slave's at the
 *    (https) URL the master sent.
 *
 * Whatever cannot be reached refuses requests (503); nothing is ever let
 * through uncharged.
 */
import { getPullReplicaConfig, pullFingerprintToken } from "@/ee/fleet/pull-config";
import { getSlaveMasterToken, isHttpSyncAllowed } from "@/src/lib/instance-sync";
import type { MonetizationBalanceStore } from "./balance-store";
import type { ReplicaMeta } from "./engine";
import { createAllowanceStore, deriveAllowanceCredential, httpTransport } from "./replica-allowance";
import { isGateUrlAllowed } from "./replica-index";

const REPORT_EVERY_MS = 2_000;
const ALLOWANCE_REPORT_EVERY_MS = 10_000;

type Cached = { key: string; store: MonetizationBalanceStore; timer: ReturnType<typeof setInterval> | null };
const cacheStore = globalThis as typeof globalThis & { __ingressiReplicaStore?: Cached | null };

function stopCached(): void {
  const cached = cacheStore.__ingressiReplicaStore;
  if (cached?.timer) clearInterval(cached.timer);
  cacheStore.__ingressiReplicaStore = null;
}

async function sharedStore(namespace: string, local: MonetizationBalanceStore): Promise<MonetizationBalanceStore> {
  const { getReplicaSharedState } = await import("@/ee/high-availability/shared-state/connection");
  const { createRedisMonetizationStore, takeTouchedConsumers } = await import("@/ee/high-availability/shared-state/monetization-store");
  const { reportTouchedConsumers } = await import("@/ee/high-availability/shared-state/monetization-drain");
  const state = await getReplicaSharedState(namespace);
  const key = `shared:${namespace}`;
  const cached = cacheStore.__ingressiReplicaStore;
  if (cached?.key === key) return cached.store;
  stopCached();
  const store = createRedisMonetizationStore(state, { replica: true });
  // The master's leader drains the consumers this replica charged first (every consumer once a minute anyway).
  const timer = process.env.NODE_ENV === "test" ? null : setInterval(() => {
    void reportTouchedConsumers(state, takeTouchedConsumers()).catch(() => undefined);
  }, REPORT_EVERY_MS);
  timer?.unref?.();
  cacheStore.__ingressiReplicaStore = { key, store: { ...store, allowCall: (bucket, limit, windowMs) => local.allowCall(bucket, limit, windowMs) }, timer };
  return cacheStore.__ingressiReplicaStore.store;
}

/**
 * Where this replica asks for allowances, and with what: a pull replica asks
 * the master URL it polls; a pushed slave asks the gate URL its master sent,
 * https only (http only with INSTANCE_SYNC_ALLOW_HTTP, as for the sync
 * itself). Either way with the allowance credential derived from its sync
 * secret, never the secret itself (replica-allowance.ts).
 */
async function allowanceCredential(meta: ReplicaMeta): Promise<{ url: string; credential: string } | null> {
  const pull = getPullReplicaConfig();
  if (pull.mode === "pull") return pull.ok ? { url: pull.masterUrl, credential: deriveAllowanceCredential(pullFingerprintToken(pull.credential)) } : null;
  const token = await getSlaveMasterToken();
  if (!token || !meta.gateUrl || !isGateUrlAllowed(meta.gateUrl, isHttpSyncAllowed())) return null;
  return { url: meta.gateUrl, credential: deriveAllowanceCredential(token) };
}

async function allowanceStore(meta: ReplicaMeta, local: MonetizationBalanceStore): Promise<MonetizationBalanceStore> {
  const credential = await allowanceCredential(meta);
  if (!credential) throw new Error("This replica has no credential for its master's gate");
  const key = `allowance:${credential.url}:${credential.credential.length}:${credential.credential.slice(-6)}`;
  const cached = cacheStore.__ingressiReplicaStore;
  if (cached?.key === key) return cached.store;
  stopCached();
  const store = createAllowanceStore(httpTransport(credential.url, credential.credential), local);
  const timer = process.env.NODE_ENV === "test" ? null : setInterval(() => {
    void store.reportExpired().catch(() => undefined);
  }, ALLOWANCE_REPORT_EVERY_MS);
  timer?.unref?.();
  cacheStore.__ingressiReplicaStore = { key, store, timer };
  return store;
}

/** The store of this replica for its master's balances. Throws when it cannot be used (the gate then refuses, 503). */
export async function replicaBalanceStore(meta: ReplicaMeta, local: MonetizationBalanceStore): Promise<MonetizationBalanceStore> {
  if (meta.mode === "shared") {
    if (!meta.namespace) throw new Error("No shared-state namespace reached this replica");
    return await sharedStore(meta.namespace, local);
  }
  return await allowanceStore(meta, local);
}

/** Tests only. */
export function resetReplicaStoreForTests(): void {
  stopCached();
}
