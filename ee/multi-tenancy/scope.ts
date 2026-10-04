// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: the organisation scope. An organisation is a hard scope next
 * to the role scope (tags, src/lib/access-scope.ts): the role decides what a
 * user may do, the organisation decides which rows they can ever reach, and
 * both apply. Organisation users (Access.organizationId set) see and change
 * only rows of their organisation; a row of another organisation or of the
 * provider level answers 404, exactly like a missing one. Provider-level users
 * (organizationId null) reach every row; they can narrow lists to one
 * organisation (the dashboard's organisation switcher, ?organizationId= on the
 * REST API), which is a view, not a security boundary.
 *
 * The checks live in two places: the routes, actions and pages filter and
 * look up rows with the caller's Access, and the models refuse a write by an
 * organisation user on another organisation's row (assertActorReaches), so a
 * route that forgot a check still cannot cross the boundary.
 *
 * Never checks the license, except organizationForNewRow when a
 * provider-level user puts a new row into an organisation.
 */
import { eq, isNull, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { appDb } from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { can, tenantOf, type Access } from "@/src/lib/permissions";
import { readOrganization, userOrganizationId, FEATURE } from "./store";
import { first } from "@/src/lib/db/ops";
import { parseRowId } from "@/src/lib/row-ids";

/** A refusal because of the caller's organisation (403); the message is safe to show. */
export class TenantError extends ApiClientError {
  constructor(message: string) {
    super(message, 403);
    this.name = "TenantError";
  }
}

/** True when `access` may see a row owned by `organizationId` (null: the provider level). */
export function inTenant(access: Pick<Access, "organizationId">, organizationId: number | null | undefined): boolean {
  const tenant = tenantOf(access);
  return tenant === null || (organizationId ?? null) === tenant;
}

export function isProviderLevel(access: Pick<Access, "organizationId">): boolean {
  return tenantOf(access) === null;
}

/** Refuses an organisation user (403) on a provider-level feature. */
export function assertProviderLevel(access: Pick<Access, "organizationId">, message: string): void {
  if (!isProviderLevel(access)) throw new TenantError(message);
}

/**
 * Which rows a list returns: undefined for every row, null for provider-level
 * rows only, a number for that organisation's rows.
 */
export type OrganizationFilter = number | null | undefined;

/** An organisation user always gets their own organisation; a provider-level caller what they ask for. */
export function organizationFilterFor(access: Pick<Access, "organizationId">, requested: OrganizationFilter = undefined): OrganizationFilter {
  const tenant = tenantOf(access);
  return tenant !== null ? tenant : requested;
}

/** The SQL condition of a filter on an organizationId column (undefined: no condition). */
export function organizationCondition(column: SQLiteColumn, filter: OrganizationFilter): SQL | undefined {
  if (filter === undefined) return undefined;
  return filter === null ? isNull(column) : eq(column, filter);
}

/** True when a row owned by `organizationId` passes `filter`. */
export function matchesOrganizationFilter(organizationId: number | null | undefined, filter: OrganizationFilter): boolean {
  return filter === undefined || (organizationId ?? null) === filter;
}

/**
 * Reads ?organizationId= of a list request: "provider" for provider-level
 * rows, an organisation id, or nothing for every row. Organisation users
 * always get their own organisation, whatever they send.
 */
export function readOrganizationFilterParam(access: Pick<Access, "organizationId">, value: string | null | undefined): OrganizationFilter {
  if (!isProviderLevel(access)) return tenantOf(access);
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  if (raw === "provider") return null;
  const id = parseRowId(raw);
  if (id === null) throw new ApiValidationError('organizationId must be an organisation id or "provider"');
  return id;
}

/** The organisation of the user acting (by id), for the model layer; null for the provider level. */
export async function actorOrganizationId(actorUserId: number | null | undefined): Promise<number | null> {
  return typeof actorUserId === "number" && actorUserId > 0 ? await userOrganizationId(appDb, actorUserId) : null;
}

/**
 * Model-layer guard: an organisation user acting on a row of another
 * organisation or of the provider level gets `notFound`, a 404 exactly as for
 * a missing row. Provider-level actors pass.
 */
export async function assertActorReaches(actorUserId: number | null | undefined, rowOrganizationId: number | null | undefined, notFound: string): Promise<void> {
  const actor = await actorOrganizationId(actorUserId);
  if (actor !== null && (rowOrganizationId ?? null) !== actor) {
    throw new ApiClientError(notFound, 404);
  }
}

function readOrganizationIdInput(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const id = parseRowId(typeof value === "string" ? value.trim() : value);
  if (id === null) {
    throw new ApiValidationError("organizationId must be an organisation id or null");
  }
  return id;
}

/**
 * The organisation a new row (proxy host, certificate, access list, group,
 * user) belongs to. An organisation user's rows always go to their own
 * organisation; naming another one, or the provider level, is refused. A
 * provider-level actor's rows go to the provider level unless `requested`
 * names an organisation, which is moving a row into it: that needs
 * organizations:write and the license.
 */
export async function organizationForNewRow(actorUserId: number, requested: unknown): Promise<number | null> {
  const actor = await actorOrganizationId(actorUserId);
  if (actor !== null) {
    if (requested !== undefined && readOrganizationIdInput(requested) !== actor) {
      throw new TenantError("You can only create resources in your own organisation");
    }
    return actor;
  }
  const organizationId = readOrganizationIdInput(requested);
  if (organizationId === null) return null;
  // Imported here: the custom-roles access module reads this module's store.
  const { accessForUser } = await import("@/ee/custom-roles/access");
  const user = await first(appDb
    .select({ role: users.role, customRoleId: users.customRoleId, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1));
  // A request made with an API token is limited to its scopes
  // (src/lib/api-token-scopes.ts): the actor's access is read again here, so
  // the token's scopes are applied again too.
  const { applyTokenScopes, currentRequestTokenScopes } = await import("@/src/lib/api-token-scopes");
  const access = applyTokenScopes(
    await accessForUser({
      id: actorUserId,
      role: user?.role ?? "viewer",
      customRoleId: user?.customRoleId ?? null,
      organizationId: user?.organizationId ?? null,
    }),
    await currentRequestTokenScopes()
  );
  if (!can(access, "organizations:write")) {
    throw new TenantError("Putting resources into an organisation needs the organizations:write permission");
  }
  if (!await readOrganization(appDb, organizationId)) throw new ApiValidationError("Unknown organisation");
  const { requireFeature } = await import("@/ee/licensing/store");
  await requireFeature(FEATURE);
  return organizationId;
}
