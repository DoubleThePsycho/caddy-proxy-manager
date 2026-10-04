// SPDX-License-Identifier: Elastic-2.0
/**
 * Links between audit events and configuration history versions, so the
 * audit log can show a configuration change as a before/after diff and the
 * history can title a version with the changes that produced it.
 *
 * An audit event about a configuration entity (configEntityOf), recorded
 * while history is on, gets:
 *
 * - configBeforeId: the newest version when the event was recorded; and
 * - configAfterId: the version recorded by the apply that followed. Until
 *   then the event is "pending"; insertSnapshotInTx links every pending
 *   event to the version it stores, and an apply that finds the
 *   configuration unchanged closes pending events with after = before.
 *
 * Most changes are recorded before Caddy is applied (the model functions).
 * Some are recorded after the apply that already stored their version
 * (settings saves, restores, imports): when the newest version is an
 * automatic one from the last few minutes, changed this event's entity and
 * has no event for that entity yet, the event is linked to it directly.
 *
 * changeRequestId names the change request (ee/approvals) whose approved
 * change recorded the event. The links are not covered by the hash chain,
 * like organizationId. Events recorded before this existed, or while
 * history is off, have none. Nothing here throws into the audit log.
 */
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { auditEvents, configSnapshots, settings } from "@/src/lib/db/schema";
import type { DbTransaction } from "@/src/lib/config-content";
import { currentApprovedChangeRequestId } from "@/ee/approvals/context";
import { changesTouchEntity, configEntityOf, parseVersionChanges } from "./changes";
import { desc, first } from "@/src/lib/db/ops";

const HISTORY_SETTING_KEY = "config_history";
/** How long after its version an event recorded after the apply is still matched to it. */
export const LATE_EVENT_WINDOW_MS = 5 * 60 * 1000;

export type ConfigLinks = { configBeforeId: number | null; configAfterId: number | null; changeRequestId: number | null };

type Reader = Pick<DbTransaction, "select">;

async function historyEnabled(tx: Reader): Promise<boolean> {
  const row = await first(tx.select({ value: settings.value }).from(settings).where(eq(settings.key, HISTORY_SETTING_KEY)).limit(1));
  if (!row) return false;
  try {
    const value = JSON.parse(row.value) as { enabled?: unknown };
    return value?.enabled === true;
  } catch {
    return false;
  }
}

/** The links of an event about to be inserted (inside the audit log's transaction). */
export async function configLinksForEvent(
  tx: Reader,
  event: { action: string; entityType: string; entityId: number | null },
  now: Date = new Date()
): Promise<ConfigLinks> {
  const changeRequestId = currentApprovedChangeRequestId();
  const none: ConfigLinks = { configBeforeId: null, configAfterId: null, changeRequestId };
  const entity = configEntityOf(event);
  if (!entity || !await historyEnabled(tx)) return none;
  const latest = await first(tx
    .select({
      id: configSnapshots.id,
      reason: configSnapshots.reason,
      createdAt: configSnapshots.createdAt,
      previousId: configSnapshots.previousId,
      changes: configSnapshots.changes,
    })
    .from(configSnapshots)
    .orderBy(desc(configSnapshots.id))
    .limit(1));
  if (!latest) return none;
  const age = now.getTime() - Date.parse(latest.createdAt);
  if (latest.reason === "auto" && latest.previousId !== null && age >= 0 && age <= LATE_EVENT_WINDOW_MS) {
    const changes = parseVersionChanges(latest.changes);
    if (changes && changesTouchEntity(changes, entity)) {
      const linked = await first(tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.configAfterId, latest.id),
            eq(auditEvents.entityType, event.entityType),
            event.entityId === null ? isNull(auditEvents.entityId) : eq(auditEvents.entityId, event.entityId)
          )
        )
        .limit(1));
      if (!linked) return { configBeforeId: latest.previousId, configAfterId: latest.id, changeRequestId };
    }
  }
  return { configBeforeId: latest.id, configAfterId: null, changeRequestId };
}

type Writer = Pick<DbTransaction, "update">;

/** Links every pending event to the version just stored (in the snapshot's transaction). */
export async function linkPendingEventsInTx(tx: Writer, snapshotId: number): Promise<void> {
  await tx.update(auditEvents)
    .set({ configAfterId: snapshotId })
    .where(and(isNotNull(auditEvents.configBeforeId), isNull(auditEvents.configAfterId), lt(auditEvents.configBeforeId, snapshotId)));
}

/** An apply found the configuration unchanged: pending events after `latestId` changed nothing. */
export async function closePendingEventsInTx(tx: Writer, latestId: number): Promise<void> {
  await tx.update(auditEvents)
    .set({ configAfterId: latestId })
    .where(and(eq(auditEvents.configBeforeId, latestId), isNull(auditEvents.configAfterId)));
}

/** Recording stopped: pending events will never get a version after them. */
export async function dropPendingEventsInTx(tx: Writer): Promise<void> {
  await tx.update(auditEvents)
    .set({ configBeforeId: null })
    .where(and(isNotNull(auditEvents.configBeforeId), isNull(auditEvents.configAfterId)));
}
