// SPDX-License-Identifier: Elastic-2.0
/**
 * Campaign input: scope, reviewers and the other fields shared by campaigns
 * and schedules, and the snapshot of the access a campaign reviews.
 */
import { eq, inArray } from "drizzle-orm";
import { apiTokens, customRoles, groupMembers, groups, users } from "@/src/lib/db/schema";
import { ApiValidationError } from "@/src/lib/api-errors";
import { SCOPE_ROLES, type ItemKind, type ReviewScope, type ReviewerView } from "./types";
import { asc, first } from "@/src/lib/db/ops";
import type { AppTx } from "@/src/lib/db/types";

export type ReviewReader = Pick<AppTx, "select">;
export type ReviewWriter = Pick<AppTx, "select" | "insert" | "update" | "delete">;

export const MAX_REVIEWERS = 50;
export const MAX_NAME_LENGTH = 100;
export const MAX_SCOPE_IDS = 100;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new ApiValidationError("Request body must be a JSON object");
  return input;
}

export function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiValidationError(`Unknown field "${key.slice(0, 64)}"`);
  }
}

export function readName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiValidationError("name is required");
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) throw new ApiValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`);
  if (/\p{Cc}/u.test(name)) throw new ApiValidationError("name must not contain control characters");
  return name;
}

export function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiValidationError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function readIds(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiValidationError(`${field} must be an array of ids`);
  if (value.length > MAX_SCOPE_IDS) throw new ApiValidationError(`${field} may list at most ${MAX_SCOPE_IDS} ids`);
  for (const id of value) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new ApiValidationError(`${field} must be an array of ids`);
    }
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

/** A scope from a request: {"type":"all"} or {"type":"filter", roles?, customRoleIds?, groupIds?}. */
export async function readScope(input: unknown, reader: ReviewReader): Promise<ReviewScope> {
  const value = input === undefined ? { type: "all" } : input;
  if (!isRecord(value)) throw new ApiValidationError("scope must be an object");
  if (value.type === "all") {
    rejectUnknownKeys(value, ["type"]);
    return { type: "all" };
  }
  if (value.type !== "filter") throw new ApiValidationError('scope.type must be "all" or "filter"');
  rejectUnknownKeys(value, ["type", "roles", "customRoleIds", "groupIds"]);
  const roles = value.roles === undefined || value.roles === null ? [] : value.roles;
  if (!Array.isArray(roles) || roles.some((role) => !(SCOPE_ROLES as readonly unknown[]).includes(role))) {
    throw new ApiValidationError(`scope.roles must list built-in roles (${SCOPE_ROLES.join(", ")})`);
  }
  const customRoleIds = readIds(value.customRoleIds, "scope.customRoleIds");
  const groupIds = readIds(value.groupIds, "scope.groupIds");
  if (roles.length === 0 && customRoleIds.length === 0 && groupIds.length === 0) {
    throw new ApiValidationError("A filter scope needs at least one role, custom role or group");
  }
  if (customRoleIds.length > 0) {
    const found = await reader.select({ id: customRoles.id }).from(customRoles).where(inArray(customRoles.id, customRoleIds));
    if (found.length !== customRoleIds.length) throw new ApiValidationError("scope.customRoleIds names an unknown custom role");
  }
  if (groupIds.length > 0) {
    const found = await reader.select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds));
    if (found.length !== groupIds.length) throw new ApiValidationError("scope.groupIds names an unknown group");
  }
  return { type: "filter", roles: [...new Set(roles as (typeof SCOPE_ROLES)[number][])], customRoleIds, groupIds };
}

export function parseStoredScope(raw: string | null | undefined): ReviewScope {
  try {
    const value = JSON.parse(raw ?? "");
    if (isRecord(value) && value.type === "filter") {
      const ids = (input: unknown) => (Array.isArray(input) ? input.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : []);
      return {
        type: "filter",
        roles: Array.isArray(value.roles) ? value.roles.filter((role): role is (typeof SCOPE_ROLES)[number] => (SCOPE_ROLES as readonly unknown[]).includes(role)) : [],
        customRoleIds: ids(value.customRoleIds),
        groupIds: ids(value.groupIds),
      };
    }
  } catch {
    // fall through
  }
  return { type: "all" };
}

/** Reviewer ids: 1 to MAX_REVIEWERS active users. */
export async function readReviewerIds(value: unknown, reader: ReviewReader): Promise<number[]> {
  if (!Array.isArray(value) || value.length === 0) throw new ApiValidationError("reviewerIds must list at least one user id");
  if (value.length > MAX_REVIEWERS) throw new ApiValidationError(`At most ${MAX_REVIEWERS} reviewers`);
  const ids = readIds(value, "reviewerIds");
  const found = await reader
    .select({ id: users.id, status: users.status, organizationId: users.organizationId })
    .from(users)
    .where(inArray(users.id, ids));
  if (found.length !== ids.length) throw new ApiValidationError("reviewerIds names an unknown user");
  if (found.some((user) => user.status !== "active")) throw new ApiValidationError("Every reviewer must be an active user");
  // A campaign lists users and roles of every organisation (ee/multi-tenancy).
  if (found.some((user) => user.organizationId !== null)) {
    throw new ApiValidationError("Reviewers must be provider-level users, not users of an organisation");
  }
  return ids;
}

export function parseStoredIds(raw: string | null | undefined): number[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

export async function describeReviewers(reader: ReviewReader, ids: readonly number[]): Promise<ReviewerView[]> {
  if (ids.length === 0) return [];
  const rows = await reader.select({ id: users.id, email: users.email, name: users.name }).from(users).where(inArray(users.id, [...ids]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => ({ id, email: byId.get(id)?.email ?? null, name: byId.get(id)?.name ?? null }));
}

type SubjectRow = { id: number; email: string; name: string | null; role: string; customRoleId: number | null };

/** Active users the scope covers, by id. */
export async function usersInScope(reader: ReviewReader, scope: ReviewScope): Promise<SubjectRow[]> {
  const active = await reader
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, customRoleId: users.customRoleId })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(asc(users.id));
  if (scope.type === "all") return active;
  const inGroups = new Set(
    scope.groupIds.length === 0
      ? []
      : (await reader.select({ userId: groupMembers.userId }).from(groupMembers).where(inArray(groupMembers.groupId, scope.groupIds)))
          .map((row) => row.userId)
  );
  return active.filter((user) =>
    (user.customRoleId === null && (scope.roles as readonly string[]).includes(user.role)) ||
    (user.customRoleId !== null && scope.customRoleIds.includes(user.customRoleId)) ||
    inGroups.has(user.id)
  );
}

export type ItemSnapshot = { kind: ItemKind; targetId: number | null; targetLabel: string };

/** Every access `user` has now, as review items. */
export async function accessOf(reader: ReviewReader, user: SubjectRow): Promise<ItemSnapshot[]> {
  const items: ItemSnapshot[] = [{ kind: "account", targetId: null, targetLabel: "Dashboard account" }];
  if (user.customRoleId !== null) {
    const role = await first(reader.select({ name: customRoles.name }).from(customRoles).where(eq(customRoles.id, user.customRoleId)).limit(1));
    items.push({ kind: "role", targetId: user.customRoleId, targetLabel: `Custom role "${role?.name ?? user.customRoleId}"` });
  } else if (user.role === "admin") {
    items.push({ kind: "role", targetId: null, targetLabel: "Administrator (built-in role)" });
  }
  const memberships = await reader
    .select({ id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, user.id))
    .orderBy(asc(groups.name), asc(groups.id));
  for (const group of memberships) items.push({ kind: "group", targetId: group.id, targetLabel: `Group "${group.name}"` });
  const tokens = await reader
    .select({ id: apiTokens.id, name: apiTokens.name, expiresAt: apiTokens.expiresAt })
    .from(apiTokens)
    .where(eq(apiTokens.createdBy, user.id))
    .orderBy(asc(apiTokens.id));
  for (const token of tokens) {
    const expiry = token.expiresAt ? `, expires ${token.expiresAt.slice(0, 10)}` : ", no expiry";
    items.push({ kind: "api_token", targetId: token.id, targetLabel: `API token "${token.name}"${expiry}` });
  }
  return items;
}
