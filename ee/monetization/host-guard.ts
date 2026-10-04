// SPDX-License-Identifier: Elastic-2.0
/**
 * The proxy host side of "monetization is an authentication mode": checks
 * that src/lib/models/proxy-hosts.ts runs when a host edit touches forward
 * auth or the access list, and the cleanup when a host is deleted. Kept apart
 * from hosts.ts so that the proxy host model does not import itself back.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationHosts } from "@/src/lib/db/schema";
import { ApiValidationError } from "@/src/lib/api-errors";
import { brandName } from "@/ee/white-label/store";
import { reloadMonetization } from "./engine";
import { first } from "@/src/lib/db/ops";

type HostRow = typeof monetizationHosts.$inferSelect;
type Toggle = { enabled?: boolean } | null | undefined;
/** The authentication settings of a proxy host (its view or its stored meta). */
export type HostAuth = { accessListId: number | null; authentik?: Toggle; forwardAuth?: Toggle; ingressiForwardAuth?: Toggle };

export async function getHostRow(proxyHostId: number): Promise<HostRow | null> {
  return await first(appDb.select().from(monetizationHosts).where(eq(monetizationHosts.proxyHostId, proxyHostId)).limit(1)) ?? null;
}

export function readAllowedPlanIds(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

/** Authentication modes on the host that rule out monetization. */
export function hostAuthConflicts(host: HostAuth): string[] {
  const conflicts: string[] = [];
  if (host.ingressiForwardAuth?.enabled) conflicts.push(`${brandName()} forward auth`);
  if (host.authentik?.enabled) conflicts.push("Authentik forward auth");
  if (host.forwardAuth?.enabled) conflicts.push("generic forward auth");
  if (host.accessListId) conflicts.push("a basic-auth access list");
  return conflicts;
}

export async function isHostMonetized(proxyHostId: number): Promise<boolean> {
  return (await getHostRow(proxyHostId))?.enabled === true;
}

/** Refuses (400) a proxy host change that would combine another authentication mode with monetization. */
export async function assertProxyHostAuthCompatible(proxyHostId: number, next: HostAuth): Promise<void> {
  if (!await isHostMonetized(proxyHostId)) return;
  const conflicts = hostAuthConflicts(next);
  if (conflicts.length > 0) {
    throw new ApiValidationError(
      `API monetization is on for this host and cannot be combined with ${conflicts.join(" and ")}; ` +
        "turn monetization off first (API Monetization → Hosts)"
    );
  }
}

/** Removes the settings of a deleted proxy host (foreign keys are not enforced). */
export async function forgetDeletedProxyHost(proxyHostId: number): Promise<void> {
  // One statement: whether there was a row is what it deleted.
  const removed = await appDb
    .delete(monetizationHosts)
    .where(eq(monetizationHosts.proxyHostId, proxyHostId))
    .returning({ proxyHostId: monetizationHosts.proxyHostId });
  if (removed.length > 0) await reloadMonetization();
}
