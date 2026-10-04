/**
 * API token scopes (src/lib/api-token-scopes.ts): what a token with scopes
 * may do is its owner's access intersected with the scopes, never more, for
 * every kind of owner (administrator, custom role with and without a tag
 * scope, organisation user, built-in user and viewer) and every subset of
 * scopes.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTokenScopes,
  expandTokenScopes,
  parseStoredTokenScopes,
  parseTokenScopesInput,
  readOnlyScopesFor,
} from '@/src/lib/api-token-scopes';
import {
  adminAccess,
  builtInAccess,
  can,
  isAdminLevel,
  organizationAccess,
  permissionDeniedMessage,
  PERMISSIONS,
  scopeTagsFor,
  type Access,
  type Permission,
} from '@/src/lib/permissions';
import { ApiValidationError } from '@/src/lib/api-errors';

function customRole(permissions: Permission[], scopeTags: string[] = []): Access {
  return {
    userId: 7,
    role: 'viewer',
    isAdmin: false,
    customRole: { id: 3, name: 'Operators' },
    permissions: new Set(permissions),
    scopeTags,
    organizationId: null,
  };
}

const OWNERS: Array<[string, Access]> = [
  ['administrator', adminAccess(1)],
  ['custom role', customRole(['proxy_hosts:read', 'proxy_hosts:write', 'certificates:read', 'users:read', 'sso:write'])],
  ['custom role with a tag scope', customRole(['proxy_hosts:read', 'proxy_hosts:write', 'l4_proxy_hosts:read'], ['team-a'])],
  ['organisation administrator', organizationAccess(5, 9, 'org_admin')],
  ['built-in user', builtInAccess(2, 'user')],
  ['built-in viewer', builtInAccess(3, 'viewer')],
];

/** A deterministic pseudo-random generator, so the sampled subsets are the same on every run. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function sampleScopes(count: number): Permission[][] {
  const random = generator(42);
  const samples: Permission[][] = [];
  for (let i = 0; i < count; i += 1) {
    const size = 1 + Math.floor(random() * 8);
    const picked = new Set<Permission>();
    while (picked.size < size) picked.add(PERMISSIONS[Math.floor(random() * PERMISSIONS.length)]);
    samples.push([...picked]);
  }
  // Every single permission, and all of them.
  for (const permission of PERMISSIONS) samples.push([permission]);
  samples.push([...PERMISSIONS]);
  return samples;
}

describe('applyTokenScopes', () => {
  it('leaves a token without scopes with its owner\'s access', () => {
    for (const [, owner] of OWNERS) {
      expect(applyTokenScopes(owner, null)).toBe(owner);
      expect(applyTokenScopes(owner, undefined)).toBe(owner);
    }
  });

  it.each(OWNERS)('never gives a token of a %s more than its owner or its scopes', (_label, owner) => {
    for (const scopes of sampleScopes(400)) {
      const access = applyTokenScopes(owner, scopes);
      const allowed = new Set(expandTokenScopes(scopes));
      expect(access.isAdmin).toBe(false);
      for (const permission of PERMISSIONS) {
        if (can(access, permission)) {
          expect(can(owner, permission), `${permission} beyond the owner`).toBe(true);
          expect(allowed.has(permission), `${permission} beyond the scopes`).toBe(true);
        }
      }
      // Everything both allow is kept.
      for (const permission of allowed) {
        expect(can(access, permission)).toBe(can(owner, permission));
      }
      // Organisation and host scoping stay the owner's.
      expect(access.organizationId ?? null).toBe(owner.organizationId ?? null);
      for (const area of ['proxy_hosts', 'l4_proxy_hosts', 'certificates'] as const) {
        expect(scopeTagsFor(access, area)).toEqual(scopeTagsFor(owner, area));
      }
    }
  });

  it('keeps administrator-level permissions only when both the owner and the scopes have them', () => {
    const scoped = applyTokenScopes(adminAccess(1), ['proxy_hosts:write']);
    expect(isAdminLevel(scoped.permissions)).toBe(false);
    expect(can(scoped, 'sso:write')).toBe(false);
    expect(can(scoped, 'users:write')).toBe(false);
    expect(can(scoped, 'proxy_hosts:read')).toBe(true);

    const owner = customRole(['proxy_hosts:read']);
    expect(can(applyTokenScopes(owner, ['sso:write']), 'sso:write')).toBe(false);
  });

  it('says why a permission was refused', () => {
    const scoped = applyTokenScopes(adminAccess(1), ['proxy_hosts:read']);
    expect(permissionDeniedMessage(scoped, 'certificates:write')).toBe("This API token's scopes do not include certificates:write");
    const ownerLacks = applyTokenScopes(customRole(['proxy_hosts:read']), ['certificates:write']);
    expect(permissionDeniedMessage(ownerLacks, 'certificates:write')).toBe('Permission required: certificates:write');
  });
});

describe('parseTokenScopesInput', () => {
  const owner = customRole(['proxy_hosts:read', 'proxy_hosts:write', 'certificates:read']);

  it('means "the owner\'s role" when left out', () => {
    expect(parseTokenScopesInput(undefined, owner)).toBeNull();
    expect(parseTokenScopesInput(null, owner)).toBeNull();
  });

  it('keeps known permissions the owner holds, deduplicated in catalogue order', () => {
    expect(parseTokenScopesInput(['certificates:read', 'proxy_hosts:write', 'certificates:read'], owner))
      .toEqual(['proxy_hosts:write', 'certificates:read']);
  });

  it('refuses what is not a non-empty list of permissions the owner holds', () => {
    for (const input of ['proxy_hosts:read', {}, [], [42], ['nope:read'], ['users:read'], ['proxy_hosts:read', 'sso:write']]) {
      expect(() => parseTokenScopesInput(input, owner)).toThrow(ApiValidationError);
    }
    expect(() => parseTokenScopesInput(['proxy_hosts:read'], builtInAccess(2, 'user'))).toThrow(/does not hold/);
    expect(() => parseTokenScopesInput(new Array(PERMISSIONS.length + 1).fill('proxy_hosts:read'), adminAccess(1))).toThrow(/too many/);
  });

  it('accepts every permission for an administrator', () => {
    expect(parseTokenScopesInput([...PERMISSIONS], adminAccess(1))).toEqual([...PERMISSIONS]);
  });
});

describe('stored scopes', () => {
  it('reads null as the owner\'s role and fails closed on anything unreadable', () => {
    expect(parseStoredTokenScopes(null)).toBeNull();
    expect(parseStoredTokenScopes('["certificates:read","proxy_hosts:read"]')).toEqual(['proxy_hosts:read', 'certificates:read']);
    expect(parseStoredTokenScopes('not json')).toEqual([]);
    expect(parseStoredTokenScopes('{"all":true}')).toEqual([]);
    expect(parseStoredTokenScopes('["*"]')).toEqual([]);
  });

  it('ignores a scope another release stored that this release does not have', () => {
    expect(parseStoredTokenScopes('["import:write","proxy_hosts:read"]')).toEqual(['proxy_hosts:read']);
    // A token left with no scope this release knows may do nothing, not everything.
    expect(parseStoredTokenScopes('["import:write"]')).toEqual([]);
  });

  it('lists the read permissions an owner holds for "read only"', () => {
    expect(readOnlyScopesFor(customRole(['proxy_hosts:read', 'proxy_hosts:write', 'waf:read'])))
      .toEqual(['proxy_hosts:read', 'waf:read']);
    expect(readOnlyScopesFor(adminAccess(1)).every((permission) => permission.endsWith(':read'))).toBe(true);
  });
});
