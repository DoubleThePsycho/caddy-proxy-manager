// SPDX-License-Identifier: Elastic-2.0
/**
 * SCIM Groups, mapped to forward-auth groups (src/lib/models/groups.ts).
 *
 * SCIM sees the groups it created and the ones an administrator handed to
 * it (scim_groups), and within them only the members it manages (SCIM
 * users): other members of an adopted group are neither shown nor changed.
 * A member must be a SCIM user; protected accounts (primary admin,
 * break-glass) are refused. Membership changes re-apply the group-to-role
 * mappings to the members concerned (role-sync.ts).
 *
 * Deleting a group SCIM created deletes it; deleting an adopted group only
 * removes the SCIM members and stops SCIM managing it.
 */
import { and, count, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import {
  forwardAuthAccess,
  groupMembers,
  groups,
  scimGroupMembers,
  scimGroups,
  scimRoleMappings,
  scimUsers,
  users,
} from "@/src/lib/db/schema";
import { auditScimEvents, type ScimActor, type ScimAuditEvent } from "./audit";
import { parseListFilter } from "./filter";
import { expandPathless, readPatchOperations, readScimString } from "./patch";
import {
  listResponse,
  projectResource,
  readPage,
  resourceLocation,
  ScimError,
  SCHEMA_GROUP,
} from "./protocol";
import { syncUserRole } from "./role-sync";
import { isProtectedUser, readScimSettings, type ScimWriter } from "./store";
import { asc, first, lowerEquals } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

type GroupRow = typeof groups.$inferSelect;
type ScimGroupRow = typeof scimGroups.$inferSelect;
type Joined = { group: GroupRow; scim: ScimGroupRow };

const NOT_FOUND = () => new ScimError(404, "Group not found");
const MAX_NAME_LENGTH = 200;
const MAX_MEMBERS_PER_REQUEST = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGroupId(raw: string): number {
  const id = parseRowId(raw);
  if (id === null) throw NOT_FOUND();
  return id;
}

async function loadManaged(tx: ScimWriter, groupId: number): Promise<Joined | null> {
  return await first(tx
    .select({ group: groups, scim: scimGroups })
    .from(scimGroups)
    .innerJoin(groups, eq(groups.id, scimGroups.groupId))
    .where(eq(scimGroups.groupId, groupId))
    .limit(1)) ?? null;
}

/** The SCIM users in each group. */
async function scimMembersOf(tx: ScimWriter, groupIds: readonly number[]): Promise<Map<number, { userId: number; display: string }[]>> {
  const result = new Map<number, { userId: number; display: string }[]>();
  if (groupIds.length === 0) return result;
  const rows = await tx
    .select({ groupId: groupMembers.groupId, userId: users.id, email: users.email, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .innerJoin(scimUsers, eq(scimUsers.userId, users.id))
    .where(and(inArray(groupMembers.groupId, [...groupIds]), isNull(scimUsers.deletedAt)))
    .orderBy(asc(users.id));
  for (const row of rows) {
    const list = result.get(row.groupId) ?? [];
    list.push({ userId: row.userId, display: row.name || row.email });
    result.set(row.groupId, list);
  }
  return result;
}

export function toScimGroup(row: Joined, members: { userId: number; display: string }[]): Record<string, unknown> {
  return {
    schemas: [SCHEMA_GROUP],
    id: String(row.group.id),
    ...(row.scim.externalId ? { externalId: row.scim.externalId } : {}),
    displayName: row.group.name,
    members: members.map((member) => ({
      value: String(member.userId),
      display: member.display,
      $ref: resourceLocation("Users", member.userId),
    })),
    meta: {
      resourceType: "Group",
      created: toIso(row.scim.createdAt),
      lastModified: toIso(row.scim.updatedAt),
      location: resourceLocation("Groups", row.group.id),
    },
  };
}

async function render(tx: ScimWriter, row: Joined): Promise<Record<string, unknown>> {
  return toScimGroup(row, (await scimMembersOf(tx, [row.group.id])).get(row.group.id) ?? []);
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function listScimGroups(params: URLSearchParams) {
  const page = readPage(params);
  const filter = parseListFilter(params.get("filter"), ["displayname", "externalid", "id"]);
  const conditions: SQL[] = [];
  if (filter) {
    if (typeof filter.value !== "string") return listResponse([], 0, page);
    if (filter.attribute === "displayname") conditions.push(lowerEquals(groups.name, filter.value.toLowerCase()));
    else if (filter.attribute === "externalid") conditions.push(eq(scimGroups.externalId, filter.value));
    else {
      const id = parseRowId(filter.value);
      if (id === null) return listResponse([], 0, page);
      conditions.push(eq(groups.id, id));
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const [{ value: total }] = await appDb
    .select({ value: count() })
    .from(scimGroups)
    .innerJoin(groups, eq(groups.id, scimGroups.groupId))
    .where(where);
  if (page.count === 0) return listResponse([], total, page);
  const rows = await appDb
    .select({ group: groups, scim: scimGroups })
    .from(scimGroups)
    .innerJoin(groups, eq(groups.id, scimGroups.groupId))
    .where(where)
    .orderBy(asc(groups.id))
    .limit(page.count)
    .offset(page.startIndex - 1);
  const excluded = (params.get("excludedAttributes") ?? "").toLowerCase().split(",").map((name) => name.trim());
  const members = excluded.includes("members") ? new Map() : await scimMembersOf(appDb, rows.map((row) => row.group.id));
  const resources = rows.map((row) => projectResource(toScimGroup(row, members.get(row.group.id) ?? []), params));
  return listResponse(resources, total, page);
}

export async function getScimGroup(rawId: string, params: URLSearchParams) {
  const row = await loadManaged(appDb, parseGroupId(rawId));
  if (!row) throw NOT_FOUND();
  return projectResource(await render(appDb, row), params);
}

// ── Writes ──────────────────────────────────────────────────────────────

function readDisplayName(value: unknown): string {
  const name = readScimString(value, "displayName", { required: true, max: MAX_NAME_LENGTH })!;
  return name.trim();
}

async function assertNameFree(tx: ScimWriter, name: string, exceptGroupId: number | null): Promise<void> {
  const existing = (await tx
    .select({ id: groups.id })
    .from(groups)
    .where(lowerEquals(groups.name, name.toLowerCase())))
    .find((row) => row.id !== exceptGroupId);
  if (!existing) return;
  const managed = await first(tx.select({ id: scimGroups.id }).from(scimGroups).where(eq(scimGroups.groupId, existing.id)).limit(1));
  throw new ScimError(
    409,
    managed
      ? "A group with this displayName already exists"
      : "A group with this name already exists and is not managed by SCIM. An administrator can let SCIM manage it on the Provisioning page.",
    "uniqueness"
  );
}

/** Member ids of a members value ([{value: "42"}, ...]); each must be a SCIM user that is not protected. */
async function readMemberIds(tx: ScimWriter, value: unknown): Promise<number[]> {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_MEMBERS_PER_REQUEST) {
    throw new ScimError(400, `At most ${MAX_MEMBERS_PER_REQUEST} members per request`, "tooMany");
  }
  const ids = new Set<number>();
  for (const entry of list) {
    const raw = isRecord(entry) ? entry.value : entry;
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new ScimError(400, "Each member needs a value (a user id)", "invalidValue");
    }
    ids.add(await resolveMember(tx, parseRowId(raw), String(raw)));
  }
  return [...ids];
}

async function resolveMember(tx: ScimWriter, id: number | null, raw: string): Promise<number> {
  const managed = id !== null
    ? await first(tx
        .select({ userId: scimUsers.userId })
        .from(scimUsers)
        .innerJoin(users, eq(users.id, scimUsers.userId))
        .where(and(eq(scimUsers.userId, id), isNull(scimUsers.deletedAt)))
        .limit(1))
    : undefined;
  if (!managed || id === null) throw new ScimError(400, `No SCIM user with id "${raw.slice(0, 40)}"`, "invalidValue");
  if (await isProtectedUser(tx, id)) {
    throw new ScimError(403, "The primary admin and break-glass accounts cannot be changed through SCIM");
  }
  return id;
}

async function currentScimMemberIds(tx: ScimWriter, groupId: number): Promise<number[]> {
  return ((await scimMembersOf(tx, [groupId])).get(groupId) ?? []).map((member) => member.userId);
}

/** The SCIM users the identity provider put in the group (what role mappings read). */
async function assertedMemberIds(tx: ScimWriter, groupId: number): Promise<number[]> {
  return (await tx.select({ userId: scimGroupMembers.userId }).from(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId)).orderBy(scimGroupMembers.userId))
    .map((row) => row.userId);
}

/**
 * Adds `add` to the group and removes `remove` from it, as forward-auth
 * memberships and as memberships the identity provider asserted. Other
 * members are left alone. Returns who was added and removed (either kind).
 */
async function setMembers(tx: ScimWriter, groupId: number, add: readonly number[], remove: readonly number[]): Promise<{ added: number[]; removed: number[] }> {
  const current = new Set(await currentScimMemberIds(tx, groupId));
  const asserted = new Set(await assertedMemberIds(tx, groupId));
  const added = add.filter((id) => !current.has(id) || !asserted.has(id));
  const removed = remove.filter((id) => (current.has(id) || asserted.has(id)) && !add.includes(id));
  for (const userId of removed) {
    if (await isProtectedUser(tx, userId)) {
      throw new ScimError(403, "The primary admin and break-glass accounts cannot be changed through SCIM");
    }
  }
  const now = nowIso();
  for (const userId of added) {
    await tx.insert(groupMembers).values({ groupId, userId, createdAt: now }).onConflictDoNothing();
    await tx.insert(scimGroupMembers).values({ groupId, userId, createdAt: now }).onConflictDoNothing();
  }
  if (removed.length > 0) {
    await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.userId, removed)));
    await tx.delete(scimGroupMembers).where(and(eq(scimGroupMembers.groupId, groupId), inArray(scimGroupMembers.userId, removed)));
  }
  return { added, removed };
}

async function membershipEvents(
  tx: ScimWriter,
  row: Pick<GroupRow, "id" | "name">,
  change: { added: number[]; removed: number[] }
): Promise<ScimAuditEvent[]> {
  if (change.added.length === 0 && change.removed.length === 0) return [];
  const events: ScimAuditEvent[] = [{
    action: "scim_group_members",
    entityType: "group",
    entityId: row.id,
    summary: `changed members of group ${row.id} (${row.name}): ${change.added.length} added, ${change.removed.length} removed`,
    data: { added: change.added, removed: change.removed },
  }];
  const settings = await readScimSettings(tx);
  for (const userId of [...change.added, ...change.removed]) {
    const event = await syncUserRole(tx, userId, settings);
    if (event) events.push(event);
  }
  return events;
}

export async function createScimGroup(token: ScimActor, body: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(body)) throw new ScimError(400, "The request body must be a JSON object", "invalidSyntax");
  const name = readDisplayName(body.displayName);
  const externalId = readScimString(body.externalId, "externalId");
  const { row, events } = await appDb.transaction(async (tx) => {
    await assertNameFree(tx, name, null);
    const memberIds = await readMemberIds(tx, body.members);
    const now = nowIso();
    const group = (await first(tx
      .insert(groups)
      .values({ name, description: null, createdBy: null, createdAt: now, updatedAt: now })
      .returning()))!;
    await tx.insert(scimGroups)
      .values({ groupId: group.id, externalId, origin: "scim", createdByTokenId: token.id, createdAt: now, updatedAt: now });
    const change = await setMembers(tx, group.id, memberIds, []);
    const events: ScimAuditEvent[] = [
      {
        action: "scim_group_create",
        entityType: "group",
        entityId: group.id,
        summary: `created group ${group.id} (${name})`,
        data: { displayName: name, externalId },
      },
      ...await membershipEvents(tx, group, change),
    ];
    return { row: (await loadManaged(tx, group.id))!, events };
  });
  await auditScimEvents(token, events);
  return await render(appDb, row);
}

function renameEvents(row: Joined, name: string, externalId: string | null): ScimAuditEvent[] {
  const fields: string[] = [];
  if (name !== row.group.name) fields.push("displayName");
  if (externalId !== row.scim.externalId) fields.push("externalId");
  if (fields.length === 0) return [];
  return [{
    action: "scim_group_update",
    entityType: "group",
    entityId: row.group.id,
    summary: `updated group ${row.group.id} (${name}): ${fields.join(", ")}`,
    data: { fields, ...(name !== row.group.name ? { previousName: row.group.name, displayName: name } : {}) },
  }];
}

async function writeGroupFields(tx: ScimWriter, row: Joined, name: string, externalId: string | null): Promise<void> {
  const now = nowIso();
  if (name !== row.group.name) {
    await assertNameFree(tx, name, row.group.id);
    await tx.update(groups).set({ name, updatedAt: now }).where(eq(groups.id, row.group.id));
  }
  await tx.update(scimGroups).set({ externalId, updatedAt: now }).where(eq(scimGroups.groupId, row.group.id));
}

/** PUT: displayName, externalId and the SCIM members are replaced; members left out means none. */
export async function replaceScimGroup(token: ScimActor, rawId: string, body: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(body)) throw new ScimError(400, "The request body must be a JSON object", "invalidSyntax");
  const groupId = parseGroupId(rawId);
  const { row, events } = await appDb.transaction(async (tx) => {
    const current = await loadManaged(tx, groupId);
    if (!current) throw NOT_FOUND();
    const name = readDisplayName(body.displayName);
    const externalId = readScimString(body.externalId, "externalId");
    const wanted = await readMemberIds(tx, body.members);
    await writeGroupFields(tx, current, name, externalId);
    const change = await setMembers(tx, groupId, wanted, [...await currentScimMemberIds(tx, groupId), ...await assertedMemberIds(tx, groupId)]);
    const events = [...renameEvents(current, name, externalId), ...await membershipEvents(tx, { id: groupId, name }, change)];
    return { row: (await loadManaged(tx, groupId))!, events };
  });
  await auditScimEvents(token, events);
  return await render(appDb, row);
}

export async function patchScimGroup(token: ScimActor, rawId: string, body: unknown): Promise<Record<string, unknown>> {
  const operations = readPatchOperations(body).flatMap(expandPathless);
  const groupId = parseGroupId(rawId);
  const { row, events } = await appDb.transaction(async (tx) => {
    const current = await loadManaged(tx, groupId);
    if (!current) throw NOT_FOUND();
    let name = current.group.name;
    let externalId = current.scim.externalId;
    const add = new Set<number>();
    const remove = new Set<number>();
    for (const { op, path, value } of operations) {
      switch (path!.attribute) {
        case "displayname":
          if (op === "remove") throw new ScimError(400, "displayName cannot be removed", "mutability");
          name = readDisplayName(value);
          break;
        case "externalid":
          externalId = op === "remove" ? null : readScimString(value, "externalId");
          break;
        case "members": {
          if (path!.filter) {
            // members[value eq "42"] (Entra ID and Okta removals).
            if (path!.filter.attribute !== "value" || op !== "remove") {
              throw new ScimError(400, 'Only remove with members[value eq "<id>"] is supported', "invalidPath");
            }
            const raw = path!.filter.value;
            const id = parseRowId(raw);
            if (id !== null) {
              remove.add(id);
              add.delete(id);
            }
            break;
          }
          if (op === "remove") {
            const ids = value === undefined || value === null
              ? [...await currentScimMemberIds(tx, groupId), ...await assertedMemberIds(tx, groupId)]
              : (Array.isArray(value) ? value : [value]).map((entry) => {
                  const raw = isRecord(entry) ? entry.value : entry;
                  return parseRowId(raw);
                }).filter((id): id is number => id !== null);
            for (const id of ids) {
              remove.add(id);
              add.delete(id);
            }
            break;
          }
          const ids = await readMemberIds(tx, value);
          if (op === "replace") {
            for (const id of [...await currentScimMemberIds(tx, groupId), ...await assertedMemberIds(tx, groupId)]) remove.add(id);
            add.clear();
          }
          for (const id of ids) {
            add.add(id);
            remove.delete(id);
          }
          break;
        }
        default:
          // id, meta, schemas and attributes this server does not keep.
          break;
      }
    }
    await writeGroupFields(tx, current, name, externalId);
    const change = await setMembers(tx, groupId, [...add], [...remove]);
    const events = [...renameEvents(current, name, externalId), ...await membershipEvents(tx, { id: groupId, name }, change)];
    return { row: (await loadManaged(tx, groupId))!, events };
  });
  await auditScimEvents(token, events);
  return await render(appDb, row);
}

/** DELETE: a group SCIM created is deleted; an adopted group loses its SCIM members and is no longer managed. */
export async function deleteScimGroup(token: ScimActor, rawId: string): Promise<void> {
  const groupId = parseGroupId(rawId);
  const events = await appDb.transaction(async (tx) => {
    const current = await loadManaged(tx, groupId);
    if (!current) throw NOT_FOUND();
    const scimMemberIds = [...new Set([...await currentScimMemberIds(tx, groupId), ...await assertedMemberIds(tx, groupId)])];
    for (const userId of scimMemberIds) {
      if (await isProtectedUser(tx, userId)) {
        throw new ScimError(403, "The primary admin and break-glass accounts cannot be changed through SCIM");
      }
    }
    await tx.delete(scimRoleMappings).where(eq(scimRoleMappings.groupId, groupId));
    await tx.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    await tx.delete(scimGroups).where(eq(scimGroups.groupId, groupId));
    let summary: string;
    if (current.scim.origin === "adopted") {
      if (scimMemberIds.length > 0) {
        await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.userId, scimMemberIds)));
      }
      summary = `removed ${scimMemberIds.length} SCIM member(s) from group ${groupId} (${current.group.name}); SCIM no longer manages it`;
    } else {
      await tx.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
      await tx.delete(forwardAuthAccess).where(eq(forwardAuthAccess.groupId, groupId));
      await tx.delete(groups).where(eq(groups.id, groupId));
      summary = `deleted group ${groupId} (${current.group.name})`;
    }
    const events: ScimAuditEvent[] = [{
      action: "scim_group_delete",
      entityType: "group",
      entityId: groupId,
      summary,
      data: { displayName: current.group.name, origin: current.scim.origin, removedMembers: scimMemberIds },
    }];
    const settings = await readScimSettings(tx);
    for (const userId of scimMemberIds) {
      const event = await syncUserRole(tx, userId, settings);
      if (event) events.push(event);
    }
    return events;
  });
  await auditScimEvents(token, events);
}
