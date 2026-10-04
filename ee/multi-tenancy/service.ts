// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: the provider's actions on organisations, shared by the REST
 * API and the dashboard: create, change, disable and delete organisations,
 * and move proxy hosts, certificates, access lists, groups and users between
 * organisations and the provider level.
 *
 * License (feature "multi_tenancy"): creating an organisation, changing one
 * (other than disabling it) and moving rows into an organisation need it.
 * Disabling or deleting an organisation and moving rows out to the provider
 * level never do, and nothing on the request path looks at it: isolation
 * stays enforced when the license lapses.
 *
 * Moves keep the invariants of guard.ts and domains.ts in one transaction: a
 * host and the certificate and access list it uses end up in the same
 * organisation (or the move is refused), domains stay unique across
 * organisations, and access that would cross organisations (group members,
 * forward-auth grants, forward-auth sessions) is removed, never widened.
 */
import { and, count, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { revokeForwardAuthSessionsOfUsers, revokeForwardAuthSessionsWithoutAccess } from "@/src/lib/models/forward-auth";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { appDb, nowIso } from "@/src/lib/db";
import {
  accessLists,
  certificates,
  forwardAuthAccess,
  forwardAuthExchanges,
  forwardAuthSessions,
  groupMembers,
  groups,
  organizations,
  proxyHosts,
  sessions,
  users,
} from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { isOrganizationPermission, ORGANIZATION_ADMIN_ROLE, type Access } from "@/src/lib/permissions";
import { requireFeature } from "@/ee/licensing/store";
import { readCustomRole } from "@/ee/custom-roles/store";
import { assertActiveAdminRemains } from "@/ee/custom-roles/escalation";
import { assertBreakGlassAdminRemains } from "@/ee/sso/enforcement-store";
import { isProtectedUser } from "@/ee/scim/store";
import {
  FEATURE,
  listOrganizationRows,
  readOrganization,
  readOrganizationBySlug,
  type Organization,
  type TenantWriter,
} from "./store";
import { normalizeAllowedUpstreams } from "./upstreams";
import { assertNamesFreeAcrossOrganizations, certificatePemNames } from "./domains";
import { assertProxyHostRoom, assertUserRoom } from "./guard";
import { first } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

export const ORGANIZATION_NOT_FOUND = "Organisation not found";

const MAX_NAME_LENGTH = 100;
const MAX_NOTES_LENGTH = 1000;
const MAX_LIMIT = 1_000_000;
const MAX_MOVE = 500;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type OrganizationCounts = {
  proxyHosts: number;
  certificates: number;
  accessLists: number;
  groups: number;
  users: number;
};

export type OrganizationView = Organization & { counts: OrganizationCounts };

type Reader = Pick<TenantWriter, "select">;

async function countOwned(reader: Reader, organizationId: number): Promise<OrganizationCounts> {
  const owned = async (table: typeof proxyHosts | typeof certificates | typeof accessLists | typeof groups | typeof users) =>
    (await first(reader.select({ value: count() }).from(table).where(eq(table.organizationId, organizationId)).limit(1)))?.value ?? 0;
  return {
    proxyHosts: await owned(proxyHosts),
    certificates: await owned(certificates),
    accessLists: await owned(accessLists),
    groups: await owned(groups),
    users: await owned(users),
  };
}

async function toView(reader: Reader, organization: Organization): Promise<OrganizationView> {
  return { ...organization, counts: await countOwned(reader, organization.id) };
}

export async function listOrganizations(): Promise<OrganizationView[]> {
  const organizations = await listOrganizationRows(appDb);
  return Promise.all(organizations.map((organization) => toView(appDb, organization)));
}

export async function getOrganization(id: number): Promise<OrganizationView> {
  const organization = await readOrganization(appDb, id);
  if (!organization) throw new ApiClientError(ORGANIZATION_NOT_FOUND, 404);
  return await toView(appDb, organization);
}

/** Parses an organisation id from a route parameter; 404 otherwise. */
export function parseOrganizationId(raw: string): number {
  const id = parseRowId(raw);
  if (id === null) throw new ApiClientError(ORGANIZATION_NOT_FOUND, 404);
  return id;
}

// ── Validation ────────────────────────────────────────────────────────

type OrganizationFields = {
  name: string;
  slug: string;
  enabled: boolean;
  maxProxyHosts: number | null;
  maxUsers: number | null;
  allowedUpstreams: string[];
  notes: string | null;
};

const FIELD_KEYS = new Set(["name", "slug", "enabled", "maxProxyHosts", "maxUsers", "allowedUpstreams", "notes"]);

function hasControlCharacters(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function readLimit(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_LIMIT) {
    throw new ApiValidationError(`${field} must be null or a whole number from 0 to ${MAX_LIMIT}`);
  }
  return value;
}

/** A slug from a name: lowercase letters, digits and hyphens. */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function readFields(input: unknown, current: OrganizationFields | null): OrganizationFields {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiValidationError("Organisation must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((key) => !FIELD_KEYS.has(key));
  if (unknownKey) throw new ApiValidationError(`Unknown organisation field: ${unknownKey.slice(0, 40)}`);

  let name = current?.name ?? "";
  if (body.name !== undefined || !current) {
    if (typeof body.name !== "string" || !body.name.trim()) throw new ApiValidationError("name is required");
    name = body.name.trim();
    if (name.length > MAX_NAME_LENGTH) throw new ApiValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`);
    if (hasControlCharacters(name)) throw new ApiValidationError("name must not contain control characters");
  }

  let slug = current?.slug ?? "";
  if (body.slug !== undefined && body.slug !== null && body.slug !== "") {
    if (typeof body.slug !== "string") throw new ApiValidationError("slug must be a string");
    slug = body.slug.trim().toLowerCase();
  } else if (!current) {
    slug = slugFromName(name);
  }
  if (!SLUG.test(slug)) {
    throw new ApiValidationError("slug must be 1 to 64 lowercase letters, digits and hyphens, starting and ending with a letter or digit");
  }

  let enabled = current?.enabled ?? true;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new ApiValidationError("enabled must be a boolean");
    enabled = body.enabled;
  }

  const maxProxyHosts = body.maxProxyHosts !== undefined ? readLimit(body.maxProxyHosts, "maxProxyHosts") : current?.maxProxyHosts ?? null;
  const maxUsers = body.maxUsers !== undefined ? readLimit(body.maxUsers, "maxUsers") : current?.maxUsers ?? null;
  const allowedUpstreams =
    body.allowedUpstreams !== undefined ? normalizeAllowedUpstreams(body.allowedUpstreams) : current?.allowedUpstreams ?? [];

  let notes = current?.notes ?? null;
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== "string") throw new ApiValidationError("notes must be a string or null");
    const text = typeof body.notes === "string" ? body.notes.trim() : "";
    if (text.length > MAX_NOTES_LENGTH) throw new ApiValidationError(`notes must be at most ${MAX_NOTES_LENGTH} characters`);
    notes = text || null;
  }

  return { name, slug, enabled, maxProxyHosts, maxUsers, allowedUpstreams, notes };
}

async function assertSlugFree(reader: Reader, slug: string, exceptId: number | null): Promise<void> {
  const existing = await readOrganizationBySlug(reader, slug);
  if (existing && existing.id !== exceptId) throw new ApiConflictError("An organisation with this slug already exists");
}

function describe(fields: OrganizationFields) {
  return {
    name: fields.name,
    slug: fields.slug,
    enabled: fields.enabled,
    maxProxyHosts: fields.maxProxyHosts,
    maxUsers: fields.maxUsers,
    allowedUpstreams: fields.allowedUpstreams,
  };
}

// ── Organisations ─────────────────────────────────────────────────────

export async function createOrganization(actor: Access, input: unknown): Promise<OrganizationView> {
  await requireFeature(FEATURE);
  const fields = readFields(input, null);
  const now = nowIso();
  const organization = await appDb.transaction(async (tx) => {
    await assertSlugFree(tx, fields.slug, null);
    const row = (await first(tx
      .insert(organizations)
      .values({
        name: fields.name,
        slug: fields.slug,
        enabled: fields.enabled,
        maxProxyHosts: fields.maxProxyHosts,
        maxUsers: fields.maxUsers,
        allowedUpstreams: JSON.stringify(fields.allowedUpstreams),
        notes: fields.notes,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: organizations.id })))!;
    return (await readOrganization(tx, row.id))!;
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "create",
    entityType: "organization",
    entityId: organization.id,
    summary: `Created organisation ${organization.name}`,
    data: describe(fields),
    organizationId: organization.id,
  });
  return await toView(appDb, organization);
}

/**
 * Changes an organisation. Disabling it (only `enabled: false`) needs no
 * license and ends its users' sessions; any other change does.
 */
export async function updateOrganization(actor: Access, id: number, input: unknown): Promise<OrganizationView> {
  const existing = await readOrganization(appDb, id);
  if (!existing) throw new ApiClientError(ORGANIZATION_NOT_FOUND, 404);
  const fields = readFields(input, existing);
  const before = describe({ ...existing });
  const after = describe(fields);
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
    (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])
  );
  const notesChanged = (fields.notes ?? null) !== (existing.notes ?? null);
  const onlyDisabling = !notesChanged && changed.length === 1 && changed[0] === "enabled" && fields.enabled === false;
  if (!onlyDisabling && (changed.length > 0 || notesChanged)) await requireFeature(FEATURE);

  const now = nowIso();
  const organization = await appDb.transaction(async (tx) => {
    await assertSlugFree(tx, fields.slug, id);
    await tx.update(organizations)
      .set({
        name: fields.name,
        slug: fields.slug,
        enabled: fields.enabled,
        maxProxyHosts: fields.maxProxyHosts,
        maxUsers: fields.maxUsers,
        allowedUpstreams: JSON.stringify(fields.allowedUpstreams),
        notes: fields.notes,
        updatedAt: now,
      })
      .where(eq(organizations.id, id));
    if (existing.enabled && !fields.enabled) await endMemberSessions(tx, id);
    return (await readOrganization(tx, id))!;
  });
  if (existing.enabled && !fields.enabled) {
    // The same for shared forward-auth sessions (high availability), on every node.
    const members = await appDb.select({ id: users.id }).from(users).where(eq(users.organizationId, id));
    await revokeForwardAuthSessionsOfUsers(members.map((member) => member.id));
  }
  await logAuditEvent({
    userId: actor.userId,
    action: "update",
    entityType: "organization",
    entityId: id,
    summary:
      existing.enabled !== fields.enabled
        ? `${fields.enabled ? "Enabled" : "Disabled"} organisation ${organization.name}`
        : `Updated organisation ${organization.name}`,
    data: { before, after },
    organizationId: id,
  });
  return await toView(appDb, organization);
}

/** Ends the dashboard and forward-auth sessions of an organisation's users. */
async function endMemberSessions(tx: TenantWriter, organizationId: number): Promise<void> {
  const members = tx.select({ id: users.id }).from(users).where(eq(users.organizationId, organizationId));
  await tx.delete(sessions).where(inArray(sessions.userId, members));
  const faSessions = tx.select({ id: forwardAuthSessions.id }).from(forwardAuthSessions).where(inArray(forwardAuthSessions.userId, members));
  await tx.delete(forwardAuthExchanges).where(inArray(forwardAuthExchanges.sessionId, faSessions));
  await tx.delete(forwardAuthSessions).where(inArray(forwardAuthSessions.userId, members));
}

/**
 * Deletes an organisation. Refused (409) while it owns proxy hosts,
 * certificates, access lists, groups or users: move or delete them first.
 * Never needs a license. Its audit events stay, for the provider level.
 */
export async function deleteOrganization(actor: Access, id: number): Promise<void> {
  const existing = await readOrganization(appDb, id);
  if (!existing) throw new ApiClientError(ORGANIZATION_NOT_FOUND, 404);
  await appDb.transaction(async (tx) => {
    const counts = await countOwned(tx, id);
    const owned = Object.entries(counts).filter(([, value]) => value > 0);
    if (owned.length > 0) {
      throw new ApiConflictError(
        `The organisation still owns ${owned.map(([key, value]) => `${value} ${RESOURCE_LABELS[key as keyof OrganizationCounts]}`).join(", ")}; move or delete them first`
      );
    }
    await tx.delete(organizations).where(eq(organizations.id, id));
  });
  await logAuditEvent({
    userId: actor.userId,
    action: "delete",
    entityType: "organization",
    entityId: id,
    summary: `Deleted organisation ${existing.name}`,
    data: { name: existing.name, slug: existing.slug },
    organizationId: null,
  });
}

const RESOURCE_LABELS: Record<keyof OrganizationCounts, string> = {
  proxyHosts: "proxy host(s)",
  certificates: "certificate(s)",
  accessLists: "access list(s)",
  groups: "group(s)",
  users: "user(s)",
};

/** An organisation's users (the provider-level view of its members). */
export async function listMembers(id: number) {
  if (!await readOrganization(appDb, id)) throw new ApiClientError(ORGANIZATION_NOT_FOUND, 404);
  return await appDb
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      username: users.username,
      role: users.role,
      customRoleId: users.customRoleId,
      status: users.status,
      organizationId: users.organizationId,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.organizationId, id))
    .orderBy(users.email, users.id);
}

// ── Moving rows ───────────────────────────────────────────────────────

export type MoveRequest = {
  /** The destination: an organisation id, or null for the provider level. */
  organizationId: number | null;
  proxyHostIds: number[];
  certificateIds: number[];
  accessListIds: number[];
  groupIds: number[];
  userIds: number[];
};

export type MoveResult = { [K in keyof Omit<MoveRequest, "organizationId">]: number } & {
  organizationId: number | null;
  removedGrants: number;
  removedMemberships: number;
};

const MOVE_KEYS = ["proxyHostIds", "certificateIds", "accessListIds", "groupIds", "userIds"] as const;

function readIds(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiValidationError(`${field} must be an array of ids`);
  const ids = new Set<number>();
  for (const item of value) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new ApiValidationError(`${field} must be an array of ids`);
    }
    ids.add(item);
  }
  return [...ids];
}

export function readMoveRequest(input: unknown, organizationId?: number | null): MoveRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApiValidationError("The move must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set<string>([...MOVE_KEYS, "organizationId"]);
  const unknownKey = Object.keys(body).find((key) => !allowed.has(key));
  if (unknownKey) throw new ApiValidationError(`Unknown field: ${unknownKey.slice(0, 40)}`);
  let destination: number | null;
  if (organizationId !== undefined) {
    destination = organizationId;
  } else if (body.organizationId === null) {
    destination = null;
  } else if (typeof body.organizationId === "number" && Number.isSafeInteger(body.organizationId) && body.organizationId > 0) {
    destination = body.organizationId;
  } else {
    throw new ApiValidationError("organizationId must be an organisation id, or null for the provider level");
  }
  const request = {
    organizationId: destination,
    proxyHostIds: readIds(body.proxyHostIds, "proxyHostIds"),
    certificateIds: readIds(body.certificateIds, "certificateIds"),
    accessListIds: readIds(body.accessListIds, "accessListIds"),
    groupIds: readIds(body.groupIds, "groupIds"),
    userIds: readIds(body.userIds, "userIds"),
  };
  const total = MOVE_KEYS.reduce((sum, key) => sum + request[key].length, 0);
  if (total === 0) throw new ApiValidationError("Name at least one proxy host, certificate, access list, group or user to move");
  if (total > MAX_MOVE) throw new ApiValidationError(`At most ${MAX_MOVE} rows can be moved at once`);
  return request;
}

function tenantKey(column: AnySQLiteColumn) {
  return sql`coalesce(${column}, 0)`;
}

function sameTenantAs(column: AnySQLiteColumn, organizationId: number | null) {
  return organizationId === null ? isNull(column) : eq(column, organizationId);
}

function otherTenantThan(column: AnySQLiteColumn, organizationId: number | null) {
  return ne(tenantKey(column), organizationId ?? 0);
}

/** The role a moved user gets: never more than they had, and one that fits the destination. */
async function roleAfterMove(
  tx: TenantWriter,
  user: { role: string; customRoleId: number | null; organizationId: number | null },
  destination: number | null
): Promise<{ role: string; customRoleId: number | null }> {
  if (destination === null) {
    // Out of an organisation: nothing is carried over to the provider level.
    if (user.organizationId !== null) return { role: "viewer", customRoleId: null };
    return { role: user.role, customRoleId: user.customRoleId };
  }
  if (user.customRoleId !== null) {
    const role = await readCustomRole(tx, user.customRoleId);
    if (role && role.permissions.every(isOrganizationPermission)) return { role: "viewer", customRoleId: role.id };
    return { role: "viewer", customRoleId: null };
  }
  if (user.role === "admin") return { role: ORGANIZATION_ADMIN_ROLE, customRoleId: null };
  return { role: user.role, customRoleId: null };
}

function namesOfHost(domains: string): string[] {
  try {
    const value = JSON.parse(domains);
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function namesOfCertificate(row: { domainNames: string; type: string; certificatePem: string | null }): string[] {
  return [...namesOfHost(row.domainNames), ...(row.type === "imported" ? certificatePemNames(row.certificatePem) : [])];
}

type MovedRow = { kind: "proxy_host" | "certificate" | "access_list" | "group" | "user"; id: number; name: string; from: number | null };

/**
 * Moves rows to an organisation or to the provider level, in one transaction,
 * as described at the top of this file. Moving rows into an organisation
 * needs the license; moving them out never does.
 */
export async function moveResources(actor: Access, input: MoveRequest): Promise<MoveResult> {
  const destination = input.organizationId;
  if (destination !== null) {
    if (!await readOrganization(appDb, destination)) throw new ApiClientError(ORGANIZATION_NOT_FOUND, 404);
    await requireFeature(FEATURE);
  }
  if (input.userIds.includes(actor.userId)) throw new ApiValidationError("You cannot move your own account");

  const moved: MovedRow[] = [];
  let removedGrants = 0;
  let removedMemberships = 0;
  const now = nowIso();

  await appDb.transaction(async (tx) => {
    const notFound = (what: string, ids: number[], found: number) => {
      if (found !== ids.length) throw new ApiClientError(`${what} not found`, 404);
    };

    // ── Read and check what moves.
    const hostRows = input.proxyHostIds.length
      ? await tx.select({ id: proxyHosts.id, name: proxyHosts.name, organizationId: proxyHosts.organizationId }).from(proxyHosts).where(inArray(proxyHosts.id, input.proxyHostIds))
      : [];
    notFound("Proxy host", input.proxyHostIds, hostRows.length);
    const certRows = input.certificateIds.length
      ? await tx.select({ id: certificates.id, name: certificates.name, organizationId: certificates.organizationId }).from(certificates).where(inArray(certificates.id, input.certificateIds))
      : [];
    notFound("Certificate", input.certificateIds, certRows.length);
    // The global Blocked sources list applies to every host and never moves.
    const listRows = input.accessListIds.length
      ? await tx.select({ id: accessLists.id, name: accessLists.name, organizationId: accessLists.organizationId }).from(accessLists).where(and(inArray(accessLists.id, input.accessListIds), isNull(accessLists.systemKey)))
      : [];
    notFound("Access list", input.accessListIds, listRows.length);
    const groupRows = input.groupIds.length
      ? await tx.select({ id: groups.id, name: groups.name, organizationId: groups.organizationId }).from(groups).where(inArray(groups.id, input.groupIds))
      : [];
    notFound("Group", input.groupIds, groupRows.length);
    const userRows = input.userIds.length
      ? await tx
          .select({ id: users.id, email: users.email, role: users.role, customRoleId: users.customRoleId, organizationId: users.organizationId })
          .from(users)
          .where(inArray(users.id, input.userIds))
      : [];
    notFound("User", input.userIds, userRows.length);

    const arriving = <T extends { organizationId: number | null }>(rows: T[]) =>
      rows.filter((row) => (row.organizationId ?? null) !== destination);
    const hosts = arriving(hostRows);
    const certs = arriving(certRows);
    const lists = arriving(listRows);
    const movedGroups = arriving(groupRows);
    const movedUsers = arriving(userRows);

    // ── Limits of the destination, counting only what arrives.
    await assertProxyHostRoom(tx, destination, hosts.length);
    await assertUserRoom(tx, destination, movedUsers.length);

    // ── Users: protected accounts stay where they are; roles shrink to fit.
    for (const user of movedUsers) {
      if (await isProtectedUser(tx, user.id)) {
        throw new ApiValidationError(`User ${user.email} is the primary administrator or a break-glass account and cannot be moved`);
      }
      const next = await roleAfterMove(tx, { ...user, organizationId: user.organizationId ?? null }, destination);
      await assertActiveAdminRemains(tx, { userId: user.id, role: next.role });
      await assertBreakGlassAdminRemains(tx, { userId: user.id, role: next.role });
      await tx.update(users)
        .set({ organizationId: destination, role: next.role, customRoleId: next.customRoleId, updatedAt: now })
        .where(eq(users.id, user.id));
      moved.push({ kind: "user", id: user.id, name: user.email, from: user.organizationId ?? null });
    }

    // ── Rows.
    for (const host of hosts) {
      await tx.update(proxyHosts).set({ organizationId: destination, updatedAt: now }).where(eq(proxyHosts.id, host.id));
      moved.push({ kind: "proxy_host", id: host.id, name: host.name, from: host.organizationId ?? null });
    }
    for (const cert of certs) {
      await tx.update(certificates).set({ organizationId: destination, updatedAt: now }).where(eq(certificates.id, cert.id));
      moved.push({ kind: "certificate", id: cert.id, name: cert.name, from: cert.organizationId ?? null });
    }
    for (const list of lists) {
      await tx.update(accessLists).set({ organizationId: destination, updatedAt: now }).where(eq(accessLists.id, list.id));
      moved.push({ kind: "access_list", id: list.id, name: list.name, from: list.organizationId ?? null });
    }
    for (const group of movedGroups) {
      const clash = await first(tx
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.name, group.name), sameTenantAs(groups.organizationId, destination), ne(groups.id, group.id)))
        .limit(1));
      if (clash) throw new ApiConflictError(`The destination already has a group named ${group.name}`);
      await tx.update(groups).set({ organizationId: destination, updatedAt: now }).where(eq(groups.id, group.id));
      moved.push({ kind: "group", id: group.id, name: group.name, from: group.organizationId ?? null });
    }

    // ── A host and what it uses stay in one organisation.
    const touchedHostIds = new Set<number>(hosts.map((host) => host.id));
    const touchedCertIds = certs.map((cert) => cert.id);
    const touchedListIds = lists.map((list) => list.id);
    if (touchedCertIds.length > 0) {
      for (const row of await tx.select({ id: proxyHosts.id }).from(proxyHosts).where(inArray(proxyHosts.certificateId, touchedCertIds))) {
        touchedHostIds.add(row.id);
      }
    }
    if (touchedListIds.length > 0) {
      for (const row of await tx.select({ id: proxyHosts.id }).from(proxyHosts).where(inArray(proxyHosts.accessListId, touchedListIds))) {
        touchedHostIds.add(row.id);
      }
    }
    if (touchedHostIds.size > 0) {
      const rows = await tx
        .select({
          name: proxyHosts.name,
          organizationId: proxyHosts.organizationId,
          certificateOrganizationId: certificates.organizationId,
          certificateRowId: certificates.id,
          accessListOrganizationId: accessLists.organizationId,
          accessListRowId: accessLists.id,
        })
        .from(proxyHosts)
        .leftJoin(certificates, eq(certificates.id, proxyHosts.certificateId))
        .leftJoin(accessLists, eq(accessLists.id, proxyHosts.accessListId))
        .where(inArray(proxyHosts.id, [...touchedHostIds]))
        .orderBy(proxyHosts.id);
      for (const row of rows) {
        const tenant = row.organizationId ?? null;
        if (row.certificateRowId !== null && (row.certificateOrganizationId ?? null) !== tenant) {
          throw new ApiConflictError(
            `Proxy host ${row.name} and its certificate would end up in different organisations; move them together`
          );
        }
        if (row.accessListRowId !== null && (row.accessListOrganizationId ?? null) !== tenant) {
          throw new ApiConflictError(
            `Proxy host ${row.name} and its access list would end up in different organisations; move them together`
          );
        }
      }
    }

    // ── Domains stay unique across organisations.
    for (const host of hosts) {
      const row = await first(tx.select({ domains: proxyHosts.domains }).from(proxyHosts).where(eq(proxyHosts.id, host.id)).limit(1));
      await assertNamesFreeAcrossOrganizations(tx, destination, namesOfHost(row?.domains ?? "[]"), { proxyHostId: host.id });
    }
    for (const cert of certs) {
      const row = await first(tx
        .select({ domainNames: certificates.domainNames, type: certificates.type, certificatePem: certificates.certificatePem })
        .from(certificates)
        .where(eq(certificates.id, cert.id))
        .limit(1));
      if (row) await assertNamesFreeAcrossOrganizations(tx, destination, namesOfCertificate(row), { certificateId: cert.id });
    }

    // ── Access that would cross organisations is removed, never widened.
    const movedHostIds = hosts.map((host) => host.id);
    const movedGroupIds = movedGroups.map((group) => group.id);
    const movedUserIds = movedUsers.map((user) => user.id);
    const foreignUsers = (organizationId: number | null) =>
      tx.select({ id: users.id }).from(users).where(otherTenantThan(users.organizationId, organizationId));
    const foreignGroups = (organizationId: number | null) =>
      tx.select({ id: groups.id }).from(groups).where(otherTenantThan(groups.organizationId, organizationId));
    const foreignHosts = (organizationId: number | null) =>
      tx.select({ id: proxyHosts.id }).from(proxyHosts).where(otherTenantThan(proxyHosts.organizationId, organizationId));

    if (movedHostIds.length > 0) {
      removedGrants += (await tx
        .delete(forwardAuthAccess)
        .where(and(
          inArray(forwardAuthAccess.proxyHostId, movedHostIds),
          or(inArray(forwardAuthAccess.userId, foreignUsers(destination)), inArray(forwardAuthAccess.groupId, foreignGroups(destination)))
        ))
        .returning({ id: forwardAuthAccess.id })).length;
    }
    if (movedGroupIds.length > 0) {
      removedMemberships += (await tx
        .delete(groupMembers)
        .where(and(inArray(groupMembers.groupId, movedGroupIds), inArray(groupMembers.userId, foreignUsers(destination))))
        .returning({ id: groupMembers.id })).length;
      removedGrants += (await tx
        .delete(forwardAuthAccess)
        .where(and(inArray(forwardAuthAccess.groupId, movedGroupIds), inArray(forwardAuthAccess.proxyHostId, foreignHosts(destination))))
        .returning({ id: forwardAuthAccess.id })).length;
    }
    if (movedUserIds.length > 0) {
      removedMemberships += (await tx
        .delete(groupMembers)
        .where(and(inArray(groupMembers.userId, movedUserIds), inArray(groupMembers.groupId, foreignGroups(destination))))
        .returning({ id: groupMembers.id })).length;
      removedGrants += (await tx
        .delete(forwardAuthAccess)
        .where(and(inArray(forwardAuthAccess.userId, movedUserIds), inArray(forwardAuthAccess.proxyHostId, foreignHosts(destination))))
        .returning({ id: forwardAuthAccess.id })).length;
      // Forward-auth sign-ins of moved users end; the dashboard picks up the
      // new organisation on the next request.
      const faSessions = tx.select({ id: forwardAuthSessions.id }).from(forwardAuthSessions).where(inArray(forwardAuthSessions.userId, movedUserIds));
      await tx.delete(forwardAuthExchanges).where(inArray(forwardAuthExchanges.sessionId, faSessions));
      await tx.delete(forwardAuthSessions).where(inArray(forwardAuthSessions.userId, movedUserIds));
    }
    if (movedHostIds.length > 0) {
      // Sessions on moved hosts of users who can no longer pass them.
      const stale = tx
        .select({ id: forwardAuthSessions.id })
        .from(forwardAuthSessions)
        .where(and(inArray(forwardAuthSessions.proxyHostId, movedHostIds), notInArray(forwardAuthSessions.userId, tx.select({ id: users.id }).from(users).where(sameTenantAs(users.organizationId, destination)))));
      await tx.delete(forwardAuthExchanges).where(inArray(forwardAuthExchanges.sessionId, stale));
      await tx.delete(forwardAuthSessions).where(inArray(forwardAuthSessions.id, stale));
    }
  });

  // Shared forward-auth sessions (high availability) follow on every node:
  // moved users' sessions end, and every other session is checked again
  // against the grants and memberships the move removed.
  if (moved.length > 0) {
    await revokeForwardAuthSessionsOfUsers(moved.filter((row) => row.kind === "user").map((row) => row.id));
    await revokeForwardAuthSessionsWithoutAccess({ all: true });
  }

  // ── One event in the organisation a row leaves and one in the one it joins.
  const label = async (organizationId: number | null) =>
    organizationId === null ? "the provider level" : `organisation ${(await readOrganization(appDb, organizationId))?.name ?? organizationId}`;
  for (const row of moved) {
    const what = `${row.kind.replace(/_/g, " ")} ${row.name}`;
    await logAuditEvent({
      userId: actor.userId,
      action: "organization_move_out",
      entityType: row.kind,
      entityId: row.id,
      summary: `Moved ${what} out of ${row.from === null ? "the provider level" : "this organisation"}`,
      organizationId: row.from,
    });
    await logAuditEvent({
      userId: actor.userId,
      action: "organization_move_in",
      entityType: row.kind,
      entityId: row.id,
      summary: `Moved ${what} into ${await label(destination)}`,
      organizationId: destination,
    });
  }
  if (moved.length > 0) {
    // The provider level sees every move, whichever organisations it involved.
    await logAuditEvent({
      userId: actor.userId,
      action: "organization_move",
      entityType: "organization",
      entityId: destination,
      summary: `Moved ${moved.length} row(s) to ${await label(destination)}`,
      data: { organizationId: destination, moved: moved.map(({ kind, id, from }) => ({ kind, id, from })), removedGrants, removedMemberships },
      organizationId: null,
    });
  }

  const countOf = (kind: MovedRow["kind"]) => moved.filter((row) => row.kind === kind).length;
  return {
    organizationId: destination,
    proxyHostIds: countOf("proxy_host"),
    certificateIds: countOf("certificate"),
    accessListIds: countOf("access_list"),
    groupIds: countOf("group"),
    userIds: countOf("user"),
    removedGrants,
    removedMemberships,
  };
}

/** Every row that can move between organisations, for the Organisations page's move dialog. */
export async function listMovableRows(): Promise<import("./types").MovableRows> {
  const parse = (raw: string) => {
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.map(String).join(", ") : null;
    } catch {
      return null;
    }
  };
  return {
    proxyHosts: (await appDb
      .select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains, organizationId: proxyHosts.organizationId })
      .from(proxyHosts)
      .orderBy(proxyHosts.name, proxyHosts.id))
      .map((row) => ({ id: row.id, label: row.name, detail: parse(row.domains), organizationId: row.organizationId ?? null })),
    certificates: (await appDb
      .select({ id: certificates.id, name: certificates.name, domainNames: certificates.domainNames, organizationId: certificates.organizationId })
      .from(certificates)
      .orderBy(certificates.name, certificates.id))
      .map((row) => ({ id: row.id, label: row.name, detail: parse(row.domainNames), organizationId: row.organizationId ?? null })),
    accessLists: (await appDb
      .select({ id: accessLists.id, name: accessLists.name, organizationId: accessLists.organizationId })
      .from(accessLists)
      .orderBy(accessLists.name, accessLists.id))
      .map((row) => ({ id: row.id, label: row.name, detail: null, organizationId: row.organizationId ?? null })),
    groups: (await appDb
      .select({ id: groups.id, name: groups.name, organizationId: groups.organizationId })
      .from(groups)
      .orderBy(groups.name, groups.id))
      .map((row) => ({ id: row.id, label: row.name, detail: null, organizationId: row.organizationId ?? null })),
    users: (await appDb
      .select({ id: users.id, email: users.email, role: users.role, organizationId: users.organizationId })
      .from(users)
      .orderBy(users.email, users.id))
      .map((row) => ({ id: row.id, label: row.email, detail: row.role, organizationId: row.organizationId ?? null })),
  };
}
