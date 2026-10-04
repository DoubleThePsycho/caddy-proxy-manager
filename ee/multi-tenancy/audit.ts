// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: which organisation's audit log shows an event. An event
 * about a proxy host, certificate, access list, group or user belongs to that
 * row's organisation (whoever made the change, the provider included);
 * anything else belongs to the organisation of the user who acted, and
 * provider-level actions to the provider level only. Provider-level readers
 * see every event.
 *
 * The attribution is stored with the event (audit_events.organizationId) and
 * is not part of the hash chain. Events recorded before multi-tenancy, or
 * before a row moved to another organisation, keep their attribution.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { accessLists, certificates, groups, proxyHosts, users } from "@/src/lib/db/schema";
import { userOrganizationId } from "./store";
import { first, recoverable } from "@/src/lib/db/ops";

/** Entity types whose entityId names a row with an organisation. */
const ENTITY_TABLES = {
  proxy_host: proxyHosts,
  // entityId is the proxy host.
  forward_auth_access: proxyHosts,
  certificate: certificates,
  access_list: accessLists,
  group: groups,
  // entityId is the group.
  group_member: groups,
  user: users,
} as const;

type EntityType = keyof typeof ENTITY_TABLES;

function isEntityType(value: string): value is EntityType {
  return Object.prototype.hasOwnProperty.call(ENTITY_TABLES, value);
}

/**
 * The organisation an audit event belongs to (null: the provider level only).
 * Never throws: an event is recorded even when this cannot be worked out.
 */
export async function auditEventOrganization(event: {
  userId?: number | null;
  entityType: string;
  entityId?: number | null;
}): Promise<number | null> {
  try {
    // In a savepoint inside a transaction: a failed read leaves the event's transaction going.
    return await recoverable(async () => {
      if (isEntityType(event.entityType) && typeof event.entityId === "number") {
        const table = ENTITY_TABLES[event.entityType];
        const row = await first(appDb
          .select({ organizationId: table.organizationId })
          .from(table)
          .where(eq(table.id, event.entityId))
          .limit(1));
        if (row) return row.organizationId ?? null;
      }
      return typeof event.userId === "number" ? await userOrganizationId(appDb, event.userId) : null;
    });
  } catch {
    return null;
  }
}
