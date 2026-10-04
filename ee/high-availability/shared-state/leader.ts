// SPDX-License-Identifier: Elastic-2.0
/**
 * Which web node writes shared state back to the database (the drain of
 * API monetization usage and credits into the ledger).
 *
 * With several web nodes (high availability phase 2), one leader holds the
 * database and the standbys serve request paths from a read-only copy. By
 * default a process started as a standby (HA_ROLE=standby) never drains, and
 * any other process that is not a sync slave does; the phase 2 leader lease
 * can register a stricter check with setSharedStateLeaderCheck. The drain
 * also takes a short lock in the shared state, so two nodes that both
 * believe they lead never drain at the same time, and the drain itself is
 * idempotent (see monetization-drain.ts).
 */
import { getInstanceMode } from "@/src/lib/instance-sync";

type LeaderCheck = () => boolean | Promise<boolean>;

const store = globalThis as typeof globalThis & { __ingressiSharedStateLeader?: LeaderCheck };

async function defaultCheck(): Promise<boolean> {
  if (process.env.HA_ROLE === "standby") return false;
  return (await getInstanceMode()) !== "slave";
}

/** Registers how this process knows it is the leader (phase 2); null restores the default. */
export function setSharedStateLeaderCheck(check: LeaderCheck | null): void {
  store.__ingressiSharedStateLeader = check ?? undefined;
}

/** Whether this node writes shared state back to the database. Never throws. */
export async function isSharedStateLeader(): Promise<boolean> {
  try {
    return await (store.__ingressiSharedStateLeader ?? defaultCheck)();
  } catch {
    return false;
  }
}
