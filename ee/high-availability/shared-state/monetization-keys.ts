// SPDX-License-Identifier: Elastic-2.0
/**
 * Key names and lifetimes of the shared API monetization state (see
 * monetization-store.ts for what each key holds).
 */
import { createHash } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A consumer's keys live this long after their last use (the drain runs every few seconds). */
export const MZ_STATE_TTL_MS = 35 * DAY_MS;
/** Applied credit references are remembered this long (Stripe retries for 3 days; the ledger keeps them after that). */
export const MZ_REFERENCE_TTL_MS = 35 * DAY_MS;
export const MZ_DIRTY_TTL_MS = DAY_MS;
export const MZ_VERSION_TTL_MS = 35 * DAY_MS;

export function monetizationKeyNames(namespace: string) {
  const consumer = (id: number) => `${namespace}{mz:${id}}:`;
  return {
    consumer: (id: number) => `${consumer(id)}c`,
    credits: (id: number) => `${consumer(id)}cr`,
    reference: (id: number, reference: string) => `${consumer(id)}ref:${createHash("sha256").update(reference).digest("hex")}`,
    dirty: `${namespace}{mz}:dirty`,
    version: `${namespace}{mz}:version`,
    drain: `${namespace}{mz}:drain`,
    drainLock: `${namespace}{mz}:drain-lock`,
    rate: (bucket: string, windowStart: number) => `${namespace}{mz}:rl:${bucket}:${windowStart}`,
  };
}

