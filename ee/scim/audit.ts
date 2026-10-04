// SPDX-License-Identifier: Elastic-2.0
/**
 * Audit events of SCIM requests. No dashboard user acts, so the event has no
 * userId; the token that made the change is named in the summary and in the
 * data (scimTokenId, scimTokenName), which the hash chain covers.
 */
import { logAuditEvent } from "@/src/lib/audit";
import { revokeForwardAuthSessionsOfUsers, revokeForwardAuthSessionsWithoutAccess } from "@/src/lib/models/forward-auth";

export type ScimActor = { id: number; name: string };

export type ScimAuditEvent = {
  action: string;
  entityType: "user" | "group";
  entityId: number | null;
  summary: string;
  data?: Record<string, unknown>;
};

export async function auditScim(token: ScimActor, event: ScimAuditEvent): Promise<void> {
  await logAuditEvent({
    userId: null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: `SCIM token "${token.name}": ${event.summary}`,
    data: { source: "scim", scimTokenId: token.id, scimTokenName: token.name, ...(event.data ?? {}) },
  });
}

export async function auditScimEvents(token: ScimActor, events: readonly ScimAuditEvent[]): Promise<void> {
  for (const event of events) await auditScim(token, event);
  endSharedForwardAuthSessions(events);
}

function userIdsIn(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
}

/**
 * After a committed SCIM change: deactivated and deleted accounts lose their
 * forward-auth sessions, and members taken out of a group lose the sessions
 * that group allowed, in a shared store (high availability) on every node
 * too. The SQLite rows went in the change's own transaction. SCIM handlers
 * are synchronous, so this runs right after them without holding the answer.
 */
function endSharedForwardAuthSessions(events: readonly ScimAuditEvent[]): void {
  const ended: number[] = [];
  const shrunk: number[] = [];
  for (const event of events) {
    if (event.entityType === "user" && event.entityId && (event.action === "scim_user_deactivate" || event.action === "scim_user_delete")) {
      ended.push(event.entityId);
    } else if (event.action === "scim_group_members") {
      shrunk.push(...userIdsIn(event.data?.removed));
    } else if (event.action === "scim_group_delete") {
      shrunk.push(...userIdsIn(event.data?.removedMembers));
    }
  }
  const report = (error: unknown) =>
    console.error("[scim] Ending shared forward-auth sessions failed:", error instanceof Error ? error.name : typeof error);
  if (ended.length > 0) revokeForwardAuthSessionsOfUsers(ended).catch(report);
  if (shrunk.length > 0) revokeForwardAuthSessionsWithoutAccess({ userIds: shrunk }).catch(report);
}
