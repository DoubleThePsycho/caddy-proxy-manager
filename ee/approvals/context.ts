// SPDX-License-Identifier: Elastic-2.0
/**
 * The approved (or emergency) change being applied right now, if any: set by
 * runApprovedChange (guard.ts) around the model calls of a change request, so
 * the model guard lets the change through and the audit log can name the
 * request that applied it (ee/config-history/links.ts). Free of database
 * imports so src/lib/audit-chain.ts can read it cheaply.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { TargetType } from "./types";

export type ApprovedChange = {
  targetType: TargetType;
  /** The host being changed; null for a create. */
  targetId: number | null;
  requestId: number;
};

const store = globalThis as typeof globalThis & {
  __ingressiApprovedChange?: AsyncLocalStorage<ApprovedChange>;
};

export const approvedChangeStorage: AsyncLocalStorage<ApprovedChange> = (store.__ingressiApprovedChange ??= new AsyncLocalStorage<ApprovedChange>());

/** The change request being applied in this async context, or null. */
export function currentApprovedChangeRequestId(): number | null {
  return approvedChangeStorage.getStore()?.requestId ?? null;
}
