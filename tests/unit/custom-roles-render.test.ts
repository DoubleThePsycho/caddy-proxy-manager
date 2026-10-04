/**
 * Server-side render of the Roles tab (Users and groups), the role picker on
 * the Users tab and the host tag field: the license notice, the permissions
 * grouped by area, the scope and the controls a user without users:write
 * does not get.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/users',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/users/actions', () => ({
  createUserAction: vi.fn(), updateUserRoleAction: vi.fn(), updateUserStatusAction: vi.fn(),
  updateUserInfoAction: vi.fn(), deleteUserAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/users/mfa-actions', () => ({ resetUserMfaAction: vi.fn(), updateMfaPolicyAction: vi.fn() }));
vi.mock('@/app/(dashboard)/groups/actions', () => ({
  createGroupAction: vi.fn(), updateGroupAction: vi.fn(), deleteGroupAction: vi.fn(), addGroupMemberAction: vi.fn(), removeGroupMemberAction: vi.fn(),
}));

import RolesTab from '@/ee/custom-roles/ui/RolesTab';
import UsersAndGroupsClient from '@/app/(dashboard)/users/UsersAndGroupsClient';
import { HostTagBadges, HostTagsField } from '@/components/hosts/HostTags';
import { describePermissionCatalogue } from '@/ee/custom-roles/catalogue';
import type { CustomRoleView } from '@/ee/custom-roles/store';
import type { UserOverviewEntry } from '@/src/lib/users-overview';
import { PERMISSIONS } from '@/src/lib/permissions';

const stamp = '2026-10-02T10:00:00.000Z';
const roles: CustomRoleView[] = [
  { id: 1, name: 'Team A', description: 'Runs team A hosts', permissions: ['proxy_hosts:read', 'proxy_hosts:write'], scopeTags: ['team-a'], createdAt: stamp, updatedAt: stamp, userCount: 2, adminLevel: false },
  { id: 2, name: 'Platform', description: null, permissions: ['users:read', 'users:write', 'settings:read', 'settings:write'], scopeTags: [], createdAt: stamp, updatedAt: stamp, userCount: 0, adminLevel: true },
];

function tab(overrides: Partial<Parameters<typeof RolesTab>[0]> = {}) {
  return renderToStaticMarkup(createElement(RolesTab, {
    roles,
    catalogue: describePermissionCatalogue(),
    actor: { isAdmin: true, permissions: [], scopeTags: [], customRoleId: null },
    holders: { admin: ['admin'], user: [], viewer: ['val'], custom: { 1: ['ann', 'bob'], 2: [] } },
    canWrite: true,
    licensed: true,
    editionLabel: 'Business',
    saveRole: vi.fn(),
    deleteRole: vi.fn(),
    ...overrides,
  }));
}

describe('Roles tab', () => {
  it('lists the built-in and custom roles with their permission count, scope and administrator-level marker', () => {
    const html = tab();
    for (const name of ['Admin', 'User', 'Viewer', 'Team A', 'Platform']) expect(html).toContain(name);
    expect(html).toContain('team-a');
    expect(html).toContain('Administrator-level');
    expect(html).toContain(`of ${PERMISSIONS.length}`);
    expect(html).toContain('Create role');
    expect(html).not.toContain('license or higher');
  });

  it('opens a custom role with its permissions grouped by area, holders and controls', () => {
    const html = tab({ initialOpen: 'custom-1' });
    expect(html).toContain('Traffic');
    expect(html).toContain('Proxy hosts');
    expect(html).toContain('Only those tagged team-a');
    expect(html).toContain('ann, bob');
    expect(html).toContain('Edit role');
    expect(html).toContain('Duplicate');
    expect(html).toContain('Delete role');
    expect(html).toMatch(/write<span class="sr-only">, granted<\/span>/);
  });

  it('describes a built-in role without controls', () => {
    const html = tab({ initialOpen: 'admin' });
    expect(html).toContain(`Holds all ${PERMISSIONS.length} permissions`);
    expect(html).toContain('Built-in roles cannot be edited or deleted.');
    expect(html).not.toContain('Delete role');
  });

  it('shows the license notice and no create or edit without a license', () => {
    const html = tab({ licensed: false, initialOpen: 'custom-1' });
    expect(html).toContain('needs an active Ingressi Business license or higher');
    expect(html).not.toContain('Create role');
    expect(html).not.toContain('Edit role');
    // Deleting stays possible.
    expect(html).toContain('Delete role');
  });

  it('gives a user without users:write no controls and keeps your own role out of reach', () => {
    expect(tab({ canWrite: false, initialOpen: 'custom-1' })).not.toMatch(/Create role|Delete role|Edit role/);
    const own = { isAdmin: false, permissions: ['users:write'], scopeTags: [], customRoleId: 1 };
    expect(tab({ actor: own, initialOpen: 'custom-1' })).not.toContain('Delete role');
    expect(tab({ actor: own, initialOpen: 'custom-2' })).toContain('Delete role');
  });
});

function overviewUser(overrides: Partial<UserOverviewEntry> = {}): UserOverviewEntry {
  return {
    id: 5, email: 'ann@example.com', username: 'ann@example.com', name: 'Ann', role: 'viewer', customRoleId: 1, organizationId: null,
    status: 'active', lastSignInAt: null, lastSignInMethod: null, disabledAt: null, invited: false, createdAt: stamp,
    sources: [{ kind: 'local', label: 'Password' }], passwordSignIn: true,
    secondFactor: { state: 'authenticator_app', authenticatorApp: true, passkeys: 0, required: false, gate: 'none', deadline: null },
    roleManagedBy: null, administrator: false, breakGlass: false, primaryAdmin: false, apiTokenLastUsedAt: null,
    ...overrides,
  };
}

describe('Users tab role column', () => {
  it('shows a custom role by name and offers no changes without users:write', () => {
    const html = renderToStaticMarkup(createElement(UsersAndGroupsClient, {
      initialTab: 'users',
      currentUserId: 1,
      users: [overviewUser()],
      mfaPolicy: null,
      customRoles: [{ id: 1, name: 'Team A', adminLevel: false, permissionCount: 2, scopeTags: ['team-a'] }],
      canWrite: false,
      totalPermissions: PERMISSIONS.length,
      groups: null,
    }));
    expect(html).toContain('Team A');
    expect(html).toContain('Custom · 2 permissions · tag team-a');
    expect(html).not.toContain('Add user');
  });
});

describe('host tags', () => {
  it('pre-fills a new host with the first scope tag and explains the scope', () => {
    const html = renderToStaticMarkup(createElement(HostTagsField, { scopeTags: ['team-a', 'team-c'], isNew: true }));
    expect(html).toContain('value="team-a"');
    expect(html).toContain('Your role manages hosts tagged team-a, team-c');
    const edit = renderToStaticMarkup(createElement(HostTagsField, { defaultTags: ['prod', 'team-a'] }));
    expect(edit).toContain('value="prod, team-a"');
  });

  it('renders badges only for tagged hosts', () => {
    expect(renderToStaticMarkup(createElement(HostTagBadges, { tags: ['team-a'] }))).toContain('team-a');
    expect(renderToStaticMarkup(createElement(HostTagBadges, { tags: [] }))).toBe('');
  });
});
