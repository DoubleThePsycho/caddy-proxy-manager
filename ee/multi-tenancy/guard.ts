// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: the invariants the models keep for every writer, provider
 * level included, so that rows never point across organisations:
 *
 *   - a proxy host only uses a certificate and an access list of its own
 *     organisation (or of the provider level when it is provider-level);
 *   - forward-auth access on a host only names users and groups of the host's
 *     organisation;
 *   - a group only has members of its own organisation;
 *   - an organisation never holds more proxy hosts or users than its limits.
 *
 * With no organisations every row is provider-level and all of this holds
 * trivially. Nothing here checks the license.
 */
import { count, eq, inArray } from "drizzle-orm";
import { accessLists, certificates, groups, proxyHosts, users } from "@/src/lib/db/schema";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { readOrganization, type TenantReader } from "./store";
import { first } from "@/src/lib/db/ops";

function sameTenant(a: number | null | undefined, b: number | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Refuses a host reference outside the host's organisation `organizationId`.
 * An organisation user gets "not found" (404), as for a missing row; a
 * provider-level user is told why (400).
 */
export async function assertHostReferencesInTenant(
  reader: TenantReader,
  organizationId: number | null,
  references: { certificateId?: number | null; accessListId?: number | null },
  actorOrganizationId: number | null
): Promise<void> {
  const refuse = (what: "Certificate" | "Access list") => {
    if (actorOrganizationId !== null) throw new ApiClientError(`${what} not found`, 404);
    throw new ApiValidationError(`The ${what.toLowerCase()} belongs to another organisation than the host`);
  };
  if (typeof references.certificateId === "number") {
    const row = await first(reader
      .select({ organizationId: certificates.organizationId })
      .from(certificates)
      .where(eq(certificates.id, references.certificateId))
      .limit(1));
    if (row && !sameTenant(row.organizationId, organizationId)) refuse("Certificate");
    if (!row && actorOrganizationId !== null) refuse("Certificate");
  }
  if (typeof references.accessListId === "number") {
    const row = await first(reader
      .select({ organizationId: accessLists.organizationId })
      .from(accessLists)
      .where(eq(accessLists.id, references.accessListId))
      .limit(1));
    if (row && !sameTenant(row.organizationId, organizationId)) refuse("Access list");
    if (!row && actorOrganizationId !== null) refuse("Access list");
  }
}

/**
 * Refuses forward-auth access on a host of `organizationId` that names a user
 * or group of another organisation. An organisation user gets "not found".
 */
export async function assertGrantsInTenant(
  reader: TenantReader,
  organizationId: number | null,
  grants: { userIds?: readonly number[]; groupIds?: readonly number[] },
  actorOrganizationId: number | null
): Promise<void> {
  const userIds = [...new Set(grants.userIds ?? [])];
  const groupIds = [...new Set(grants.groupIds ?? [])];
  const refuse = (what: "User" | "Group") => {
    if (actorOrganizationId !== null) throw new ApiClientError(`${what} not found`, 404);
    throw new ApiValidationError(`Forward-auth access can only name users and groups of the host's organisation`);
  };
  if (userIds.length > 0) {
    const rows = await reader.select({ id: users.id, organizationId: users.organizationId }).from(users).where(inArray(users.id, userIds));
    if (rows.length !== userIds.length && actorOrganizationId !== null) refuse("User");
    if (rows.some((row) => !sameTenant(row.organizationId, organizationId))) refuse("User");
  }
  if (groupIds.length > 0) {
    const rows = await reader.select({ id: groups.id, organizationId: groups.organizationId }).from(groups).where(inArray(groups.id, groupIds));
    if (rows.length !== groupIds.length && actorOrganizationId !== null) refuse("Group");
    if (rows.some((row) => !sameTenant(row.organizationId, organizationId))) refuse("Group");
  }
}

/** Refuses adding user `userId` to a group of another organisation. */
export async function assertMemberInTenant(
  reader: TenantReader,
  groupOrganizationId: number | null,
  userId: number,
  actorOrganizationId: number | null
): Promise<void> {
  const row = await first(reader.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, userId)).limit(1));
  if (!row) {
    if (actorOrganizationId !== null) throw new ApiClientError("User not found", 404);
    return; // The insert fails on its own, as before.
  }
  if (!sameTenant(row.organizationId, groupOrganizationId)) {
    if (actorOrganizationId !== null) throw new ApiClientError("User not found", 404);
    throw new ApiValidationError("A group can only have members of its own organisation");
  }
}

async function countIn(reader: TenantReader, table: typeof proxyHosts | typeof users, organizationId: number): Promise<number> {
  return (await first(reader.select({ value: count() }).from(table).where(eq(table.organizationId, organizationId)).limit(1)))?.value ?? 0;
}

/** Refuses (403) going over the organisation's proxy host limit by `adding` hosts. */
export async function assertProxyHostRoom(reader: TenantReader, organizationId: number | null, adding = 1): Promise<void> {
  if (organizationId === null || adding <= 0) return;
  const limit = (await readOrganization(reader, organizationId))?.maxProxyHosts ?? null;
  if (limit === null) return;
  if (await countIn(reader, proxyHosts, organizationId) + adding > limit) {
    throw new ApiClientError(`The organisation's limit of ${limit} proxy hosts is reached`, 403);
  }
}

/** Refuses (403) going over the organisation's user limit by `adding` users. */
export async function assertUserRoom(reader: TenantReader, organizationId: number | null, adding = 1): Promise<void> {
  if (organizationId === null || adding <= 0) return;
  const limit = (await readOrganization(reader, organizationId))?.maxUsers ?? null;
  if (limit === null) return;
  if (await countIn(reader, users, organizationId) + adding > limit) {
    throw new ApiClientError(`The organisation's limit of ${limit} users is reached`, 403);
  }
}
