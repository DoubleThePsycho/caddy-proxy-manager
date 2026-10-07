import { appDb, nowIso, toIso } from "../db";
import { logAuditEvent } from "../audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "../api-errors";
import { forwardAuthAccess, groups, groupMembers, users, scimGroups, scimGroupMembers, scimRoleMappings } from "../db/schema";
import { and, eq, inArray, count } from "drizzle-orm";
import { revokeForwardAuthSessionsWithoutAccess } from "./forward-auth";
import { asc, first } from "@/src/lib/db/ops";

export type Group = {
  id: number;
  name: string;
  description: string | null;
  members: GroupMember[];
  createdAt: string;
  updatedAt: string;
};

export type GroupMember = {
  userId: number;
  email: string;
  name: string | null;
  createdAt: string;
};

export type GroupInput = {
  name: string;
  description?: string | null;
};

const NOT_FOUND = "Group not found";

type GroupRow = typeof groups.$inferSelect;

function toGroup(row: GroupRow, members: GroupMember[]): Group {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    members,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!
  };
}

export async function listGroups(): Promise<Group[]> {
  const allGroups = await appDb.query.groups.findMany({
    orderBy: (table) => [asc(table.name), asc(table.id)]
  });

  if (allGroups.length === 0) return [];

  const groupIds = allGroups.map((g) => g.id);
  const allMembers = await appDb
    .select({
      groupId: groupMembers.groupId,
      userId: groupMembers.userId,
      email: users.email,
      name: users.name,
      createdAt: groupMembers.createdAt
    })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(inArray(groupMembers.groupId, groupIds))
    .orderBy(asc(groupMembers.userId), asc(groupMembers.id));

  const membersByGroup = new Map<number, GroupMember[]>();
  for (const m of allMembers) {
    const bucket = membersByGroup.get(m.groupId) ?? [];
    bucket.push({
      userId: m.userId,
      email: m.email,
      name: m.name,
      createdAt: toIso(m.createdAt)!
    });
    membersByGroup.set(m.groupId, bucket);
  }

  return allGroups.map((g) => toGroup(g, membersByGroup.get(g.id) ?? []));
}

export async function countGroups(): Promise<number> {
  const [row] = await appDb.select({ value: count() }).from(groups);
  return row?.value ?? 0;
}

export async function getGroup(id: number): Promise<Group | null> {
  const group = await appDb.query.groups.findFirst({
    where: (table, operators) => operators.eq(table.id, id)
  });
  if (!group) return null;

  const members = await appDb
    .select({
      userId: groupMembers.userId,
      email: users.email,
      name: users.name,
      createdAt: groupMembers.createdAt
    })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(groupMembers.groupId, id))
    .orderBy(asc(groupMembers.userId), asc(groupMembers.id));

  return toGroup(
    group,
    members.map((m) => ({
      userId: m.userId,
      email: m.email,
      name: m.name,
      createdAt: toIso(m.createdAt)!
    }))
  );
}

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

/** The trimmed name of a group; refused (400) when missing, blank or too long. */
function groupName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ApiValidationError("A group needs a name");
  if (name.length > NAME_MAX_LENGTH) throw new ApiValidationError(`A group name is at most ${NAME_MAX_LENGTH} characters`);
  return name;
}

/** The trimmed description of a group, null when blank; refused (400) when not text or too long. */
function groupDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiValidationError("A group description must be text");
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new ApiValidationError(`A group description is at most ${DESCRIPTION_MAX_LENGTH} characters`);
  }
  return description || null;
}

/** Refuses (409) a name another group has. */
async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  const clash = await first(appDb
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.name, name))
    .limit(1));
  if (clash && clash.id !== exceptId) throw new ApiConflictError("A group with this name already exists");
}

export async function createGroup(input: GroupInput, actorUserId: number): Promise<Group> {
  const name = groupName(input.name);
  const description = groupDescription(input.description);
  const now = nowIso();

  // The name check and the insert in one transaction, so no other group can take the name in between.
  const row = await appDb.transaction(async (tx) => {
    await assertNameFree(name, null);
    return await first(tx
      .insert(groups)
      .values({
        name,
        description,
        createdBy: actorUserId,
        createdAt: now,
        updatedAt: now
      })
      .returning());
  });

  if (!row) throw new Error("Failed to create group");

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "group",
    entityId: row.id,
    summary: `Created group ${name}`
  });

  return (await getGroup(row.id))!;
}

export async function updateGroup(
  id: number,
  input: { name?: string; description?: string | null },
  actorUserId: number
): Promise<Group> {
  const name = await appDb.transaction(async (tx) => {
    const existing = await tx.query.groups.findFirst({
      where: (table, operators) => operators.eq(table.id, id)
    });
    if (!existing) throw new Error(NOT_FOUND);
    const name = input.name !== undefined ? groupName(input.name) : existing.name;
    const description = input.description !== undefined ? groupDescription(input.description) : existing.description;
    if (name !== existing.name) await assertNameFree(name, id);

    await tx
      .update(groups)
      .set({
        name,
        description,
        updatedAt: nowIso()
      })
      .where(eq(groups.id, id));
    return name;
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "group",
    entityId: id,
    summary: `Updated group ${name}`
  });

  return (await getGroup(id))!;
}

/**
 * Deletes a group with its memberships, its forward-auth grants and what SCIM
 * kept about it, in one transaction. Foreign keys are not enforced (SQLite
 * runs with them off, PostgreSQL has none), so the schema's cascades are
 * carried out here: left behind, the memberships and grants would belong to
 * whichever group got the id next.
 */
export async function deleteGroup(id: number, actorUserId: number): Promise<void> {
  const { existing, memberIds } = await appDb.transaction(async (tx) => {
    const existing = await tx.query.groups.findFirst({
      where: (table, operators) => operators.eq(table.id, id)
    });
    if (!existing) throw new Error(NOT_FOUND);
    const memberIds = (await tx
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, id)))
      .map((row) => row.userId);

    await tx.delete(forwardAuthAccess).where(eq(forwardAuthAccess.groupId, id));
    await tx.delete(groupMembers).where(eq(groupMembers.groupId, id));
    // SCIM (ee/scim) stops managing the group and its role mapping goes with it.
    await tx.delete(scimGroups).where(eq(scimGroups.groupId, id));
    await tx.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, id));
    await tx.delete(scimRoleMappings).where(eq(scimRoleMappings.groupId, id));
    await tx.delete(groups).where(eq(groups.id, id));
    return { existing, memberIds };
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "group",
    entityId: id,
    summary: `Deleted group ${existing.name}`
  });
  // Forward-auth sessions the group's grants allowed end on every node (shared state).
  await revokeForwardAuthSessionsWithoutAccess({ userIds: memberIds });
}

export async function addGroupMember(
  groupId: number,
  userId: number,
  actorUserId: number
): Promise<Group> {
  // Not a user id (the REST body's userId, as a number): no such user.
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new ApiClientError("User not found", 404);
  const group = await appDb.transaction(async (tx) => {
    const group = await tx.query.groups.findFirst({
      where: (table, operators) => operators.eq(table.id, groupId)
    });
    if (!group) throw new Error(NOT_FOUND);
    // Foreign keys are not enforced: a membership of a user id that does not
    // exist yet would make whoever gets that id a member.
    const user = await first(tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1));
    if (!user) throw new ApiClientError("User not found", 404);
    const already = await first(tx
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .limit(1));
    if (already) throw new ApiConflictError("This user is already a member of the group");

    await tx.insert(groupMembers).values({
      groupId,
      userId,
      createdAt: nowIso()
    });
    return group;
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "create",
    entityType: "group_member",
    entityId: groupId,
    summary: `Added user ${userId} to group ${group.name}`
  });

  return (await getGroup(groupId))!;
}

export async function removeGroupMember(
  groupId: number,
  userId: number,
  actorUserId: number
): Promise<Group> {
  const group = await appDb.transaction(async (tx) => {
    const group = await tx.query.groups.findFirst({
      where: (table, operators) => operators.eq(table.id, groupId)
    });
    if (!group) throw new Error(NOT_FOUND);

    const member = await tx.query.groupMembers.findFirst({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.groupId, groupId),
          operators.eq(table.userId, userId)
        )
    });
    if (!member) throw new Error("Member not found in group");

    await tx.delete(groupMembers).where(eq(groupMembers.id, member.id));
    return group;
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "delete",
    entityType: "group_member",
    entityId: groupId,
    summary: `Removed user ${userId} from group ${group.name}`
  });
  // Forward-auth sessions the group's grants allowed end on every node (shared state).
  await revokeForwardAuthSessionsWithoutAccess({ userIds: [userId] });

  return (await getGroup(groupId))!;
}

/** The groups user `userId` is a member of, for forward-auth headers. */
export async function getGroupsForUser(userId: number): Promise<{ id: number; name: string }[]> {
  const rows = await appDb
    .select({ id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.userId, userId))
    // Membership order, as the forward-auth groups header lists them.
    .orderBy(asc(groupMembers.id));

  return rows;
}
