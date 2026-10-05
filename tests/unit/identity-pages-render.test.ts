/**
 * Server-side render of the rebuilt identity pages: the Users tab (the
 * administrator without a second factor, filters, the role managed by a
 * directory), the Groups tab (columns hidden without permission), Sign-in
 * and directories (enforced SSO, the login page, a failing directory with
 * its last error and the connection test for ldap:write only) and the
 * OpenAPI entries of the overviews.
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
vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import UsersTab from '@/app/(dashboard)/users/UsersTab';
import GroupsTab from '@/app/(dashboard)/groups/GroupsTab';
import SignInClient from '@/app/(dashboard)/sign-in/SignInClient';
import { GET as openapi } from '@/app/api/v1/openapi.json/route';
import type { GroupOverviewEntry, UserOverviewEntry } from '@/src/lib/users-overview';
import type { SignInOverview } from '@/src/lib/sign-in-overview';

const stamp = '2026-10-02T10:00:00.000Z';

function user(overrides: Partial<UserOverviewEntry>): UserOverviewEntry {
  return {
    id: 2, email: 'user@example.com', username: 'user@example.com', name: 'User', role: 'user', customRoleId: null, organizationId: null,
    status: 'active', lastSignInAt: stamp, lastSignInMethod: 'password', disabledAt: null, invited: false, createdAt: stamp,
    sources: [{ kind: 'local', label: 'Password' }], passwordSignIn: true,
    secondFactor: { state: 'authenticator_app', authenticatorApp: true, passkeys: 0, required: false, gate: 'none', deadline: null },
    roleManagedBy: null, administrator: false, breakGlass: false, primaryAdmin: false, apiTokenLastUsedAt: null,
    ...overrides,
  };
}

const users = [
  user({ id: 1, name: 'admin', email: 'admin@example.com', role: 'admin', administrator: true, primaryAdmin: true }),
  user({
    id: 3, name: 'l.bianchi', email: 'l.bianchi@example.com', role: 'admin', administrator: true,
    sources: [{ kind: 'ldap', label: 'Corp directory' }],
    secondFactor: { state: 'none', authenticatorApp: false, passkeys: 0, required: true, gate: 'required', deadline: '2026-10-01T00:00:00.000Z' },
    roleManagedBy: 'Corp directory sets the role at each sign-in', lastSignInMethod: 'ldap',
  }),
  user({ id: 4, name: 's.conti', email: 's.conti@example.com', role: 'viewer', invited: true, lastSignInAt: null, lastSignInMethod: null, sources: [{ kind: 'scim', label: 'SCIM provisioning' }], secondFactor: { state: 'not_needed', authenticatorApp: false, passkeys: 0, required: false, gate: 'none', deadline: null }, passwordSignIn: false }),
  user({ id: 5, name: 'ext.audit', email: 'audit@example.com', status: 'disabled', disabledAt: '2026-09-12T08:00:00.000Z' }),
];

function usersTab(overrides: Partial<Parameters<typeof UsersTab>[0]> = {}) {
  return renderToStaticMarkup(createElement(UsersTab, {
    users,
    currentUserId: 1,
    selectedUserId: null,
    mfaPolicy: { scope: 'admins', graceDays: 7, deadline: '2026-10-01T00:00:00.000Z', required: 2, enrolled: 1 },
    canWrite: true,
    canWriteMfaPolicy: true,
    roleOptions: { customRoles: [], canAssignAdmin: true, customRolesLicensed: true },
    totalPermissions: 68,
    organizationNames: {},
    ...overrides,
  }));
}

describe('Users tab', () => {
  it('names the administrator without a second factor and offers to change the role or disable the account', () => {
    const html = usersTab();
    expect(html).toContain('l.bianchi is an administrator without a second factor.');
    expect(html).toContain('They sign in through Corp directory with a password only.');
    expect(html).toContain('Change role');
    expect(html).toContain('Disable account');
    expect(html).toContain('Corp directory sets the role at each sign-in');
    expect(html).toContain('Overdue since');
  });

  it('counts the filters and shows the statuses and the MFA policy', () => {
    const html = usersTab();
    expect(html).toMatch(/All <span class="num text-muted-foreground">4<\/span>/);
    expect(html).toMatch(/Administrators <span class="num text-muted-foreground">2<\/span>/);
    expect(html).toMatch(/Invited or disabled <span class="num text-muted-foreground">2<\/span>/);
    expect(html).toContain('Invited');
    expect(html).toContain('Disabled');
    // Disabled since the date the account was disabled.
    expect(html).toMatch(/since <span class="num">[^<]+<\/span>/);
    expect(html).toContain('Primary admin');
    expect(html).toContain('Multi-factor authentication is required for administrators and custom roles.');
    expect(html).toContain('Edit policy');
    // Four users fit on one page: no pager.
    expect(html).not.toContain('aria-label="Pages of users"');
  });

  it('pages a long list 25 at a time, newest first, with links that keep the page in the URL', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      user({ id: 100 + index, name: `person-${index}`, email: `person-${index}@example.com`, createdAt: new Date(Date.UTC(2026, 8, 1 + index)).toISOString() })
    );
    const html = usersTab({ users: many });
    expect(html.match(/data-testid="user-row-/g)).toHaveLength(25);
    expect(html).toContain('aria-label="Pages of users"');
    expect(html).toMatch(/<span class="num">1<\/span>–<span class="num">25<\/span> of <span class="num">30<\/span> users/);
    expect(html).toContain('href="/users?page=2"');
    // Newest first: the last account created leads, the five oldest are on page 2.
    expect(html.indexOf('person-29@example.com')).toBeLessThan(html.indexOf('person-5@example.com'));
    expect(html).not.toContain('person-4@example.com');
  });

  it('gives a reader no account controls in the banner and no policy editing', () => {
    const html = usersTab({ canWrite: false, canWriteMfaPolicy: false });
    expect(html).not.toContain('Disable account');
    expect(html).not.toContain('Edit policy');
  });
});

const group = (overrides: Partial<GroupOverviewEntry>): GroupOverviewEntry => ({
  id: 1, name: 'ops', description: 'Operations dashboards', organizationId: null, createdAt: stamp, updatedAt: stamp,
  members: [{ userId: 1, email: 'admin@example.com', name: 'admin' }], scim: null, roleMappings: [], hosts: [{ id: 1, name: 'Grafana', domain: 'grafana.example.com' }],
  ...overrides,
});

describe('Groups tab', () => {
  it('shows members, management, role mappings and hosts', () => {
    const html = renderToStaticMarkup(createElement(GroupsTab, {
      groups: [group({}), group({ id: 2, name: 'ingressi-users', scim: { origin: 'scim', updatedAt: stamp }, roleMappings: [{ role: 'user', customRoleId: null, customRoleName: null, priority: 1 }], hosts: [] })],
      users: null,
      canWrite: true,
    }));
    expect(html).toContain('grafana.example.com');
    expect(html).toContain('Dashboard role');
    expect(html).toContain('Mapping, priority');
    expect(html).toContain('Created by SCIM');
    expect(html).toContain('No host yet');
    expect(html).toContain('New group');
    expect(html).toContain('placeholder="Group name, description or member"');
  });

  it('pages a long list of groups', () => {
    const many = Array.from({ length: 27 }, (_, index) => group({ id: 10 + index, name: `team-${String(index).padStart(2, '0')}` }));
    const html = renderToStaticMarkup(createElement(GroupsTab, { groups: many, users: null, canWrite: false }));
    expect(html.match(/data-testid="group-row-/g)).toHaveLength(25);
    expect(html).toContain('aria-label="Pages of groups"');
    expect(html).toContain('href="/users?page=2"');
  });

  it('hides the columns the role cannot read', () => {
    const html = renderToStaticMarkup(createElement(GroupsTab, {
      groups: [group({ roleMappings: null, hosts: null })],
      users: null,
      canWrite: false,
    }));
    expect(html).not.toContain('Dashboard role');
    expect(html).not.toContain('Lets members reach');
    expect(html).not.toContain('New group');
  });
});

function overview(): SignInOverview {
  return {
    generatedAt: stamp,
    enforcement: {
      enabled: true, configurable: true, warnings: [], changedAt: stamp, changedBy: 'admin', refusedLastWeek: 3,
      breakGlass: [{ id: 2, username: 'breakglass', name: 'Break glass', email: 'ops@example.com', role: 'admin', status: 'active', passwordSignIn: true, validAdmin: true, authenticatorApp: true, passkeys: 1, lastSignInAt: stamp, lastSignInMethod: 'password' }],
    },
    loginPage: [
      { kind: 'oidc', label: 'Continue with auth.example.com', state: 'offered' },
      { kind: 'ldap', label: 'Sign in with Corp directory', state: 'unavailable' },
      { kind: 'password', label: 'Break-glass sign-in', state: 'break_glass' },
    ],
    oauthRegistration: false,
    oauthRoleFromClaims: false,
    oidc: [{ id: 'a', name: 'auth.example.com', type: 'oidc', enabled: true, issuer: 'https://auth.example.com/o/', host: 'auth.example.com', scopes: 'openid email profile', autoLink: false, users: { total: 1, invited: 0, names: ['admin'] }, lastSignIn: { at: stamp, user: 'admin' } }],
    saml: [],
    ldap: [{
      id: 7, name: 'Corp directory', enabled: true, url: 'ldaps://dc01.example.com:636', transport: 'tls', ownCaCertificate: true,
      users: { total: 1, invited: 0, names: ['l.bianchi'] }, lastSignIn: null, mappings: [{ group: 'Ingressi Admins', role: 'Admin' }], defaultRole: 'Viewer',
      groupMode: 'member_of', nestedGroups: true, requiredGroup: null, provisionUsers: false, allowWhenSsoEnforced: true, open: true,
      health: { status: 'failing', checkedAt: stamp, lastSuccessAt: null, lastFailureAt: stamp, failingSince: stamp, lastError: 'Service account bind: invalid credentials (LDAP result 49)', consecutiveFailures: 17 },
      warnings: [],
    }],
    scim: null,
  };
}

const can = { writeSso: true, writeLdap: true, readSettings: true, readUsers: true, readAuditLog: true, readScim: false, readLdap: true };

describe('Sign-in and directories', () => {
  it('shows enforced SSO, the break-glass account, refused passwords and the login page', () => {
    const html = renderToStaticMarkup(createElement(SignInClient, { overview: overview(), can, turnOffEnforcement: vi.fn() }));
    expect(html).toContain('Single sign-on is required for the dashboard');
    expect(html).toContain('breakglass');
    expect(html).toContain('Can sign in with a password');
    expect(html).toContain('View in the audit log');
    expect(html).toContain('Turn off');
    expect(html).toContain('Continue with auth.example.com');
    expect(html).toContain('unavailable');
    expect(html).toContain('Break-glass sign-in');
    expect(html).toContain('2 sources · 1 failing');
  });

  it('shows a failing directory with its last error and the connection test for ldap:write only', () => {
    const html = renderToStaticMarkup(createElement(SignInClient, { overview: overview(), can, turnOffEnforcement: vi.fn() }));
    expect(html).toContain('The directory fails its connection check.');
    expect(html).toContain('Service account bind: invalid credentials (LDAP result 49)');
    expect(html).toContain('l.bianchi cannot sign in through it');
    expect(html).toContain('Test the connection');
    expect(html).toContain('17</span> failed checks in a row');
    expect(html).toContain('aria-label="Configure Corp directory"');
    const reader = renderToStaticMarkup(createElement(SignInClient, { overview: overview(), can: { ...can, writeLdap: false, writeSso: false }, turnOffEnforcement: vi.fn() }));
    expect(reader).not.toContain('Test the connection');
    expect(reader).not.toContain('>Turn off<');
  });
});

describe('OpenAPI: identity overviews', () => {
  it('documents the three endpoints and every reference resolves', async () => {
    const doc = await (await openapi({ headers: { get: () => null } } as never)).json();
    const paths: Record<string, string> = {
      '/api/v1/users/overview': 'users:read',
      '/api/v1/groups/overview': 'groups:read',
      '/api/v1/sign-in/overview': 'sso:read',
    };
    for (const [path, permission] of Object.entries(paths)) {
      expect(Object.keys(doc.paths[path]), path).toEqual(['get']);
      expect(doc.paths[path].get.description).toContain(permission);
      expect(doc.paths[path].get.operationId).toBeTruthy();
    }
    const documented = JSON.stringify([
      ...Object.keys(paths).map((path) => doc.paths[path]),
      ...['UsersOverview', 'UserOverviewEntry', 'GroupsOverview', 'GroupOverviewEntry', 'SignInOverview'].map((name) => doc.components.schemas[name]),
    ]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of new Set(refs)) {
      const parts = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(parts.reduce((node: Record<string, unknown> | undefined, key: string) => node?.[key] as Record<string, unknown> | undefined, doc), ref).toBeDefined();
    }
    expect(documented).not.toMatch(/clientSecret|bindPassword|passwordHash/);
  });
});
