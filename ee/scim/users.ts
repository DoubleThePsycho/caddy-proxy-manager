// SPDX-License-Identifier: Elastic-2.0
/**
 * SCIM Users (RFC 7644 section 3): list with filter and paging, get, create,
 * replace, patch and delete, on the accounts SCIM manages (scim_users).
 *
 * SCIM only ever sees and changes accounts it created or that an
 * administrator handed to it: any other account, the primary admin and the
 * break-glass accounts are invisible or refused. A create whose e-mail
 * address belongs to an account SCIM does not manage is refused (409), so an
 * identity provider can never take over a local account by itself.
 *
 * Each request runs in one database transaction and is recorded in the audit
 * log with the token that made it. Never checks the license.
 */
import { and, count, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { appDb, nowIso, toIso } from "@/src/lib/db";
import {
  apiTokens,
  forwardAuthExchanges,
  forwardAuthSessions,
  groupMembers,
  groups,
  scimGroups,
  scimUsers,
  sessions,
  users,
} from "@/src/lib/db/schema";
import { deleteUser } from "@/src/lib/models/user";
import { signInEmailConflict } from "@/src/lib/sign-in-names";
import { assertBreakGlassAdminRemains } from "@/ee/sso/enforcement-store";
import { assertActiveAdminRemains } from "@/ee/custom-roles/escalation";
import { auditScimEvents, type ScimActor, type ScimAuditEvent } from "./audit";
import { parseListFilter } from "./filter";
import { readPatchOperations } from "./patch";
import {
  listResponse,
  projectResource,
  readPage,
  resourceLocation,
  ScimError,
  SCHEMA_USER,
} from "./protocol";
import { isProtectedUser, readScimSettings, userNameKey, type ScimWriter } from "./store";
import {
  accountEmailOf,
  accountNameOf,
  applyUserPatch,
  parseStoredEmails,
  readUserResource,
  type UserAttributes,
} from "./user-attributes";
import { asc, first } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

type ScimUserRow = typeof scimUsers.$inferSelect;
type UserRow = typeof users.$inferSelect;
type Joined = { scim: ScimUserRow; user: UserRow };

const NOT_FOUND = () => new ScimError(404, "User not found");
const PROTECTED = () =>
  new ScimError(403, "This account is the primary admin or a break-glass account and cannot be changed through SCIM");

function attributesOf(row: ScimUserRow): UserAttributes {
  return {
    userName: row.userName,
    externalId: row.externalId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    formattedName: row.formattedName,
    emails: parseStoredEmails(row.emails),
    active: row.active,
  };
}

/** SCIM ids are the account ids; anything else names no user. */
function parseUserId(raw: string): number {
  const id = parseRowId(raw);
  if (id === null) throw NOT_FOUND();
  return id;
}

async function loadManaged(tx: ScimWriter, userId: number): Promise<Joined | null> {
  const row = await first(tx
    .select({ scim: scimUsers, user: users })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(and(eq(scimUsers.userId, userId), isNull(scimUsers.deletedAt)))
    .limit(1));
  return row ?? null;
}

async function groupsOf(tx: ScimWriter, userIds: readonly number[]): Promise<Map<number, { id: number; name: string }[]>> {
  const result = new Map<number, { id: number; name: string }[]>();
  if (userIds.length === 0) return result;
  const rows = await tx
    .select({ userId: groupMembers.userId, id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(scimGroups, eq(scimGroups.groupId, groups.id))
    .where(inArray(groupMembers.userId, [...userIds]))
    .orderBy(asc(groups.id));
  for (const row of rows) {
    const list = result.get(row.userId) ?? [];
    list.push({ id: row.id, name: row.name });
    result.set(row.userId, list);
  }
  return result;
}

export function toScimUser(row: Joined, memberOf: { id: number; name: string }[]): Record<string, unknown> {
  const { scim, user } = row;
  const name: Record<string, string> = {};
  if (scim.formattedName) name.formatted = scim.formattedName;
  if (scim.givenName) name.givenName = scim.givenName;
  if (scim.familyName) name.familyName = scim.familyName;
  const emails = parseStoredEmails(scim.emails).map((email) => ({
    value: email.value,
    ...(email.type ? { type: email.type } : {}),
    primary: email.primary,
  }));
  return {
    schemas: [SCHEMA_USER],
    id: String(user.id),
    ...(scim.externalId ? { externalId: scim.externalId } : {}),
    userName: scim.userName,
    ...(Object.keys(name).length ? { name } : {}),
    ...(scim.displayName ? { displayName: scim.displayName } : {}),
    emails,
    active: scim.active,
    groups: memberOf.map((group) => ({ value: String(group.id), display: group.name, $ref: resourceLocation("Groups", group.id) })),
    meta: {
      resourceType: "User",
      created: toIso(scim.createdAt),
      lastModified: toIso(scim.updatedAt),
      location: resourceLocation("Users", user.id),
    },
  };
}

async function render(tx: ScimWriter, row: Joined): Promise<Record<string, unknown>> {
  return toScimUser(row, (await groupsOf(tx, [row.user.id])).get(row.user.id) ?? []);
}

// ── Reads ───────────────────────────────────────────────────────────────

export async function listScimUsers(params: URLSearchParams) {
  const page = readPage(params);
  const filter = parseListFilter(params.get("filter"), ["username", "externalid", "id"]);
  const conditions: SQL[] = [isNull(scimUsers.deletedAt)];
  if (filter) {
    if (typeof filter.value !== "string") return listResponse([], 0, page);
    if (filter.attribute === "username") conditions.push(eq(scimUsers.userNameKey, userNameKey(filter.value)));
    else if (filter.attribute === "externalid") conditions.push(eq(scimUsers.externalId, filter.value));
    else {
      const id = parseRowId(filter.value);
      if (id === null) return listResponse([], 0, page);
      conditions.push(eq(scimUsers.userId, id));
    }
  }
  const where = and(...conditions);
  const [{ value: total }] = await appDb
    .select({ value: count() })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(where);
  if (page.count === 0) return listResponse([], total, page);
  const rows = await appDb
    .select({ scim: scimUsers, user: users })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(where)
    .orderBy(asc(scimUsers.userId))
    .limit(page.count)
    .offset(page.startIndex - 1);
  const memberships = await groupsOf(appDb, rows.map((row) => row.user.id));
  const resources = rows.map((row) => projectResource(toScimUser(row, memberships.get(row.user.id) ?? []), params));
  return listResponse(resources, total, page);
}

export async function getScimUser(rawId: string, params: URLSearchParams) {
  const row = await loadManaged(appDb, parseUserId(rawId));
  if (!row) throw NOT_FOUND();
  return projectResource(await render(appDb, row), params);
}

// ── Writes ──────────────────────────────────────────────────────────────

async function assertUserNameFree(tx: ScimWriter, userName: string, exceptUserId: number | null): Promise<void> {
  const existing = await first(tx
    .select({ userId: scimUsers.userId })
    .from(scimUsers)
    .where(eq(scimUsers.userNameKey, userNameKey(userName)))
    .limit(1));
  if (existing && existing.userId !== exceptUserId) {
    throw new ScimError(409, "A user with this userName already exists", "uniqueness");
  }
}

/** Refuses an e-mail address another account has or signs in with. */
async function assertEmailFree(tx: ScimWriter, email: string, exceptUserId: number | null): Promise<void> {
  const conflict = await signInEmailConflict(tx, exceptUserId, email);
  if (!conflict) return;
  const holder = await first(tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1));
  const managed = holder
    ? await first(tx.select({ id: scimUsers.id }).from(scimUsers).where(eq(scimUsers.userId, holder.id)).limit(1))
    : undefined;
  if (holder && !managed) {
    throw new ScimError(
      409,
      "An account with this e-mail address already exists and is not managed by SCIM. " +
        "An administrator can let SCIM manage it on the Provisioning page.",
      "uniqueness"
    );
  }
  throw new ScimError(409, conflict, "uniqueness");
}

/**
 * Disables an account and ends everything it is signed in with: dashboard
 * sessions, forward-auth sessions (and their exchange codes) and API tokens.
 * Refused (400) when it would leave no active administrator, or no
 * break-glass administrator while SSO is enforced.
 */
export async function deprovisionAccount(tx: ScimWriter, userId: number): Promise<{ sessions: number; forwardAuthSessions: number; apiTokens: number }> {
  await assertBreakGlassAdminRemains(tx, { userId, status: "disabled" });
  await assertActiveAdminRemains(tx, { userId, status: "disabled" });
  await tx.update(users).set({ status: "disabled", updatedAt: nowIso() }).where(eq(users.id, userId));
  const endedSessions = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  await tx.delete(forwardAuthExchanges)
    .where(inArray(
      forwardAuthExchanges.sessionId,
      tx.select({ id: forwardAuthSessions.id }).from(forwardAuthSessions).where(eq(forwardAuthSessions.userId, userId))
    ));
  const endedForwardAuth = await tx
    .delete(forwardAuthSessions)
    .where(eq(forwardAuthSessions.userId, userId))
    .returning({ id: forwardAuthSessions.id });
  const revokedTokens = await tx.delete(apiTokens).where(eq(apiTokens.createdBy, userId)).returning({ id: apiTokens.id });
  return { sessions: endedSessions.length, forwardAuthSessions: endedForwardAuth.length, apiTokens: revokedTokens.length };
}

function scimColumns(attributes: UserAttributes) {
  return {
    userName: attributes.userName,
    userNameKey: userNameKey(attributes.userName),
    externalId: attributes.externalId,
    displayName: attributes.displayName,
    givenName: attributes.givenName,
    familyName: attributes.familyName,
    formattedName: attributes.formattedName,
    emails: JSON.stringify(attributes.emails),
    active: attributes.active,
  };
}

function changedFields(before: UserAttributes, after: UserAttributes): string[] {
  const fields: (keyof UserAttributes)[] = ["userName", "externalId", "displayName", "givenName", "familyName", "formattedName", "emails", "active"];
  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

/**
 * Writes `after` to a managed account whose SCIM attributes were `before`,
 * and applies an active transition. Returns the audit events.
 */
async function writeManaged(tx: ScimWriter, row: Joined, before: UserAttributes, after: UserAttributes): Promise<ScimAuditEvent[]> {
  const userId = row.user.id;
  const email = accountEmailOf(after);
  if (userNameKey(after.userName) !== userNameKey(before.userName)) await assertUserNameFree(tx, after.userName, userId);
  if (email !== row.user.email) await assertEmailFree(tx, email, userId);
  const now = nowIso();
  const events: ScimAuditEvent[] = [];

  let revoked: Awaited<ReturnType<typeof deprovisionAccount>> | null = null;
  if (before.active && !after.active) {
    revoked = await deprovisionAccount(tx, userId);
  } else if (!before.active && after.active) {
    await tx.update(users).set({ status: "active", updatedAt: now }).where(eq(users.id, userId));
  }
  await tx.update(users).set({ email, name: accountNameOf(after), updatedAt: now }).where(eq(users.id, userId));
  await tx.update(scimUsers).set({ ...scimColumns(after), updatedAt: now }).where(eq(scimUsers.userId, userId));

  const fields = changedFields(before, after).filter((field) => field !== "active");
  if (fields.length > 0) {
    events.push({
      action: "scim_user_update",
      entityType: "user",
      entityId: userId,
      summary: `updated user ${userId} (${email}): ${fields.join(", ")}`,
      data: { fields, userName: after.userName, ...(email !== row.user.email ? { previousEmail: row.user.email, email } : {}) },
    });
  }
  if (revoked) {
    events.push({
      action: "scim_user_deactivate",
      entityType: "user",
      entityId: userId,
      summary: `deactivated user ${userId} (${email}); revoked ${revoked.sessions} dashboard session(s), ${revoked.forwardAuthSessions} forward-auth session(s) and ${revoked.apiTokens} API token(s)`,
      data: { userName: after.userName, revoked },
    });
  } else if (!before.active && after.active) {
    events.push({
      action: "scim_user_reactivate",
      entityType: "user",
      entityId: userId,
      summary: `reactivated user ${userId} (${email})`,
      data: { userName: after.userName },
    });
  }
  return events;
}

export async function createScimUser(token: ScimActor, body: unknown): Promise<{ status: number; resource: Record<string, unknown> }> {
  const attributes = readUserResource(body, null);
  const email = accountEmailOf(attributes);
  const { events, row } = await appDb.transaction(async (tx) => {
    const settings = await readScimSettings(tx);
    // A row whose account is gone (deleted outside the user model) names nobody.
    const stale = await first(tx
      .select({ userId: scimUsers.userId, user: users.id })
      .from(scimUsers)
      .leftJoin(users, eq(users.id, scimUsers.userId))
      .where(eq(scimUsers.userNameKey, userNameKey(attributes.userName)))
      .limit(1));
    if (stale && stale.user === null) await tx.delete(scimUsers).where(eq(scimUsers.userId, stale.userId));
    const existing = await first(tx
      .select({ scim: scimUsers, user: users })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .where(eq(scimUsers.userNameKey, userNameKey(attributes.userName)))
      .limit(1));
    if (existing && existing.scim.deletedAt === null) {
      throw new ScimError(409, "A user with this userName already exists", "uniqueness");
    }
    if (existing) {
      // The provider deleted this userName while the delete mode was
      // "disable" and now creates it again: the same identity comes back.
      if (await isProtectedUser(tx, existing.user.id)) throw PROTECTED();
      await tx.update(scimUsers).set({ deletedAt: null, updatedAt: nowIso() }).where(eq(scimUsers.userId, existing.user.id));
      const events = await writeManaged(tx, existing, attributesOf(existing.scim), attributes);
      events.unshift({
        action: "scim_user_create",
        entityType: "user",
        entityId: existing.user.id,
        summary: `restored user ${existing.user.id} (${email}), deleted earlier by the identity provider`,
        data: { userName: attributes.userName, externalId: attributes.externalId, restored: true },
      });
      return { events, row: (await loadManaged(tx, existing.user.id))! };
    }

    await assertEmailFree(tx, email, null);
    const now = nowIso();
    const user = (await first(tx
      .insert(users)
      .values({
        email,
        name: accountNameOf(attributes),
        passwordHash: null,
        role: settings.defaultRole,
        customRoleId: null,
        // No sign-in method yet: the first SSO sign-in links one (binding.ts).
        provider: null,
        subject: null,
        status: attributes.active ? "active" : "disabled",
        username: null,
        displayUsername: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()))!;
    await tx.insert(scimUsers)
      .values({ userId: user.id, ...scimColumns(attributes), origin: "scim", createdByTokenId: token.id, createdAt: now, updatedAt: now });
    const events: ScimAuditEvent[] = [{
      action: "scim_user_create",
      entityType: "user",
      entityId: user.id,
      summary: `created user ${user.id} (${email}) with role ${settings.defaultRole}${attributes.active ? "" : ", inactive"}`,
      data: { userName: attributes.userName, externalId: attributes.externalId, role: settings.defaultRole, active: attributes.active },
    }];
    return { events, row: (await loadManaged(tx, user.id))! };
  });
  await auditScimEvents(token, events);
  return { status: 201, resource: await render(appDb, row) };
}

async function updateWith(
  token: ScimActor,
  rawId: string,
  change: (current: UserAttributes) => UserAttributes
): Promise<Record<string, unknown>> {
  const userId = parseUserId(rawId);
  const { events, row } = await appDb.transaction(async (tx) => {
    const current = await loadManaged(tx, userId);
    if (!current) throw NOT_FOUND();
    if (await isProtectedUser(tx, userId)) throw PROTECTED();
    const before = attributesOf(current.scim);
    const after = change(before);
    const events = await writeManaged(tx, current, before, after);
    return { events, row: (await loadManaged(tx, userId))! };
  });
  await auditScimEvents(token, events);
  return await render(appDb, row);
}

/** PUT: the resource replaces every kept attribute; `active` left out keeps its value. */
export async function replaceScimUser(token: ScimActor, rawId: string, body: unknown): Promise<Record<string, unknown>> {
  return await updateWith(token, rawId, (current) => readUserResource(body, current));
}

export async function patchScimUser(token: ScimActor, rawId: string, body: unknown): Promise<Record<string, unknown>> {
  const operations = readPatchOperations(body);
  return await updateWith(token, rawId, (current) => {
    const after = applyUserPatch(current, operations);
    if (!after.userName.trim()) throw new ScimError(400, "userName is required", "invalidValue");
    return after;
  });
}

/**
 * DELETE: with the delete mode "disable" (the default) the account is
 * disabled, its sessions and API tokens are revoked and SCIM no longer sees
 * it; with "delete" the account is deleted.
 */
export async function deleteScimUser(token: ScimActor, rawId: string): Promise<void> {
  const userId = parseUserId(rawId);
  const settings = await readScimSettings(appDb);
  if (settings.deleteMode === "delete") {
    const current = await loadManaged(appDb, userId);
    if (!current) throw NOT_FOUND();
    if (await isProtectedUser(appDb, userId)) throw PROTECTED();
    await assertActiveAdminRemains(appDb, { userId, deleted: true });
    await deleteUser(userId);
    await auditScimEvents(token, [{
      action: "scim_user_delete",
      entityType: "user",
      entityId: userId,
      summary: `deleted user ${userId} (${current.user.email})`,
      data: { userName: current.scim.userName, mode: "delete" },
    }]);
    return;
  }
  const events = await appDb.transaction(async (tx) => {
    const current = await loadManaged(tx, userId);
    if (!current) throw NOT_FOUND();
    if (await isProtectedUser(tx, userId)) throw PROTECTED();
    const revoked = current.user.status === "active" || current.scim.active ? await deprovisionAccount(tx, userId) : null;
    await tx.update(scimUsers).set({ active: false, deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(scimUsers.userId, userId));
    return [{
      action: "scim_user_delete",
      entityType: "user",
      entityId: userId,
      summary: `deleted user ${userId} (${current.user.email}) at the identity provider: account disabled` +
        (revoked ? `; revoked ${revoked.sessions} dashboard session(s), ${revoked.forwardAuthSessions} forward-auth session(s) and ${revoked.apiTokens} API token(s)` : ""),
      data: { userName: current.scim.userName, mode: "disable", revoked },
    } satisfies ScimAuditEvent];
  });
  await auditScimEvents(token, events);
}
