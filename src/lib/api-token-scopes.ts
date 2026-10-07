/**
 * API token scopes: a token may be limited to some of the permission strings
 * of the catalogue (src/lib/permissions.ts), for example proxy_hosts:read.
 * What such a token may do is its owner's access, read fresh on every
 * request, intersected with its scopes:
 *
 *  - a scope the owner does not hold (any more) grants nothing;
 *  - a token with scopes is never an administrator, whatever its owner is:
 *    paths that only administrators can use (those not covered by a
 *    permission) refuse it, and so do the self-service endpoints for the
 *    owner's account (sessions, tokens, passkeys, preferences); see
 *    requireApiUser in src/lib/api-auth.ts;
 *  - the owner's tag scope (custom roles) stays as it is, so host scoping
 *    keeps applying;
 *  - a write scope also grants the area's read action, as in custom roles.
 *
 * A token without scopes acts with its owner's role, as before scopes
 * existed.
 */
import {
  can,
  isPermission,
  normalizePermissions,
  PERMISSIONS,
  type Access,
  type Permission,
} from "./permissions";
import { ApiValidationError } from "./api-errors";

/** The scopes a stored value holds; null means "the owner's role". */
export function parseStoredTokenScopes(raw: string | null | undefined): Permission[] | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Only editing the database by hand produces this. Fail closed: a token
    // whose scopes cannot be read may do nothing, never everything.
    return [];
  }
  if (!Array.isArray(value)) return [];
  return PERMISSIONS.filter((permission) => value.includes(permission));
}

/** What a token's scopes allow, with the read action every write implies. */
export function expandTokenScopes(scopes: readonly Permission[]): Permission[] {
  return normalizePermissions(scopes);
}

/**
 * The access a request made with a token acts with: `access` (its owner's)
 * limited to `scopes`. Null scopes leave the owner's access as it is.
 */
export function applyTokenScopes(access: Access, scopes: readonly Permission[] | null | undefined): Access {
  if (scopes === null || scopes === undefined) return access;
  const allowed = new Set(expandTokenScopes(scopes));
  const held = access.isAdmin ? PERMISSIONS : PERMISSIONS.filter((permission) => access.permissions.has(permission));
  return {
    ...access,
    isAdmin: false,
    permissions: new Set(held.filter((permission) => allowed.has(permission))),
    // An administrator's empty tag scope means every host; a custom role's
    // tags keep limiting the scopable areas.
    scopeTags: access.isAdmin ? [] : access.scopeTags,
    tokenScopes: [...allowed],
  };
}

/** Whether `access` comes from a token with scopes. */
export function isScopedTokenAccess(access: Access): boolean {
  return Array.isArray(access.tokenScopes);
}

/**
 * Reads the scopes asked for a new token. Absent or null: the owner's role.
 * Otherwise a non-empty list of permission names from the catalogue, every
 * one of which the owner holds now. Returns them deduplicated, in catalogue
 * order, as given (the read action a write implies is added at use, not
 * stored).
 */
export function parseTokenScopesInput(input: unknown, owner: Access): Permission[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) {
    throw new ApiValidationError("scopes must be a list of permissions, or null for the same access as your role");
  }
  if (input.length === 0) {
    throw new ApiValidationError("scopes must name at least one permission; leave it out for the same access as your role");
  }
  if (input.length > PERMISSIONS.length) {
    throw new ApiValidationError("scopes lists too many permissions");
  }
  const requested = new Set<Permission>();
  for (const value of input) {
    if (!isPermission(value)) {
      throw new ApiValidationError(`Unknown permission in scopes: ${String(value).slice(0, 80)}`);
    }
    if (!can(owner, value)) {
      throw new ApiValidationError(`You cannot give a token a permission your role does not hold: ${value}`);
    }
    requested.add(value);
  }
  return PERMISSIONS.filter((permission) => requested.has(permission));
}

/** Every read permission `owner` holds: the "read only" choice on Profile. */
export function readOnlyScopesFor(owner: Access): Permission[] {
  return PERMISSIONS.filter((permission) => permission.endsWith(":read") && can(owner, permission));
}
