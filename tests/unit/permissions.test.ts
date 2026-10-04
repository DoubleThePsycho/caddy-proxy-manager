/**
 * The permission catalogue (src/lib/permissions.ts): normalisation, the
 * built-in roles, the administrator-level set and the scope helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  adminAccess,
  builtInAccess,
  can,
  isAdminLevel,
  isPermission,
  listHeldPermissions,
  normalizePermissions,
  permissionDeniedMessage,
  PERMISSION_AREAS,
  PERMISSIONS,
  scopeTagsFor,
  tagsInScope,
  UNSCOPED_ONLY_PERMISSIONS,
  type Access,
  type Permission,
} from '@/src/lib/permissions';

function customAccess(permissions: Permission[], scopeTags: string[] = []): Access {
  return {
    userId: 9,
    role: 'viewer',
    isAdmin: false,
    customRole: { id: 3, name: 'Team A' },
    permissions: new Set(permissions),
    scopeTags,
  };
}

describe('permission catalogue', () => {
  it('names every permission area:action and nothing else', () => {
    expect(PERMISSIONS.length).toBe(new Set(PERMISSIONS).size);
    for (const permission of PERMISSIONS) {
      const [area, action] = permission.split(':');
      expect((PERMISSION_AREAS as Record<string, { actions: readonly string[] }>)[area].actions).toContain(action);
      expect(isPermission(permission)).toBe(true);
    }
    expect(isPermission('proxy_hosts:delete')).toBe(false);
    expect(isPermission('admin')).toBe(false);
    expect(isPermission(42)).toBe(false);
  });

  it('includes the areas the guards protect, the paid ones too', () => {
    for (const permission of [
      'proxy_hosts:read', 'proxy_hosts:write', 'l4_proxy_hosts:write', 'access_lists:write', 'certificates:write',
      'waf:write', 'analytics:read', 'groups:write', 'users:write', 'audit_log:read', 'settings:write',
      'instances:write', 'api_docs:read', 'alerts:write', 'audit_streaming:write', 'config_history:read',
      'config_history:restore', 'backups:restore', 'sso:write', 'ai:write', 'license:write', 'mfa_policy:write',
      'config:export', 'config:import',
    ]) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it('adds the read action of every write, restore or import, deduplicates and sorts', () => {
    expect(normalizePermissions(['proxy_hosts:write', 'proxy_hosts:write'])).toEqual(['proxy_hosts:read', 'proxy_hosts:write']);
    expect(normalizePermissions(['backups:restore'])).toEqual(['backups:read', 'backups:restore']);
    expect(normalizePermissions(['config:export'])).toEqual(['config:export']);
    expect(normalizePermissions(['config:import'])).toEqual(['config:import']);
    expect(normalizePermissions(['users:write', 'access_lists:read'])).toEqual(['access_lists:read', 'users:read', 'users:write']);
  });

  it('refuses unknown permissions', () => {
    expect(() => normalizePermissions(['proxy_hosts:admin'])).toThrow(/Unknown permission/);
    expect(() => normalizePermissions([{}])).toThrow(/Unknown permission/);
  });

  it('marks sso, MFA policy, license and instance writes, and users plus settings writes, as administrator-level', () => {
    for (const permission of ['sso:write', 'mfa_policy:write', 'license:write', 'instances:write'] as Permission[]) {
      expect(isAdminLevel([permission])).toBe(true);
    }
    expect(isAdminLevel(['users:write'])).toBe(false);
    expect(isAdminLevel(['settings:write'])).toBe(false);
    expect(isAdminLevel(['users:write', 'settings:write'])).toBe(true);
    expect(isAdminLevel(['sso:read', 'license:read', 'proxy_hosts:write'])).toBe(false);
  });

  it('keeps whole-configuration permissions out of scoped roles', () => {
    expect(UNSCOPED_ONLY_PERMISSIONS).toEqual(expect.arrayContaining([
      'config:export', 'config:import', 'config_history:restore', 'backups:write', 'backups:restore',
    ]));
  });
});

describe('built-in roles', () => {
  it('gives administrators every permission and no scope', () => {
    const admin = builtInAccess(1, 'admin');
    expect(admin.isAdmin).toBe(true);
    for (const permission of PERMISSIONS) expect(can(admin, permission)).toBe(true);
    expect(scopeTagsFor(admin, 'proxy_hosts')).toBeNull();
    expect(listHeldPermissions(admin)).toEqual([...PERMISSIONS]);
    expect(adminAccess(1)).toEqual(admin);
  });

  it.each(['user', 'viewer', 'superuser', ''])('gives the %j role none of them, as before custom roles', (role) => {
    const access = builtInAccess(2, role);
    expect(access.isAdmin).toBe(false);
    for (const permission of PERMISSIONS) expect(can(access, permission)).toBe(false);
    expect(listHeldPermissions(access)).toEqual([]);
    expect(permissionDeniedMessage(access, 'proxy_hosts:read')).toBe('Administrator privileges required');
  });
});

describe('custom roles', () => {
  it('holds exactly the listed permissions', () => {
    const access = customAccess(['proxy_hosts:read', 'proxy_hosts:write']);
    expect(can(access, 'proxy_hosts:write')).toBe(true);
    expect(can(access, 'users:read')).toBe(false);
    expect(listHeldPermissions(access)).toEqual(['proxy_hosts:read', 'proxy_hosts:write']);
    expect(permissionDeniedMessage(access, 'users:read')).toBe('Permission required: users:read');
  });

  it('applies the tag scope to the scoped areas only', () => {
    const access = customAccess(['proxy_hosts:read', 'waf:read'], ['team-a']);
    expect(scopeTagsFor(access, 'proxy_hosts')).toEqual(['team-a']);
    expect(scopeTagsFor(access, 'l4_proxy_hosts')).toEqual(['team-a']);
    expect(scopeTagsFor(access, 'certificates')).toEqual(['team-a']);
    expect(scopeTagsFor(access, 'waf')).toBeNull();
    expect(scopeTagsFor(customAccess(['proxy_hosts:read']), 'proxy_hosts')).toBeNull();
  });

  it('matches hosts with any of the scope tags', () => {
    expect(tagsInScope(['team-a', 'prod'], ['team-a'])).toBe(true);
    expect(tagsInScope(['team-b'], ['team-a', 'team-c'])).toBe(false);
    expect(tagsInScope([], ['team-a'])).toBe(false);
    expect(tagsInScope([], null)).toBe(true);
  });
});
