/**
 * Enforced SSO without break-glass accounts, as rendered: the login page
 * offers no password sign-in, and the Single sign-on page links the recovery
 * steps instead of printing a host command.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/sso',
  useSearchParams: () => new URLSearchParams(),
}));

import LoginClient from '@/app/(auth)/login/LoginClient';
import SsoClient from '@/ee/sso/ui/SsoClient';
import type { BreakGlassCandidate, SsoEnforcementView } from '@/ee/sso/enforcement';

const RECOVERY_DOCS = 'ee/docs/sso-enforcement.md#recovery';
const provider = { id: 'corp', name: 'Corp SSO', host: 'auth.example.com' };

function login(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(LoginClient, { enabledProviders: [provider], ...props }));
}

describe('login page under enforced SSO', () => {
  it('offers the password sign-in behind a toggle while a break-glass account can use it', () => {
    const html = login({ ssoEnforced: true, breakGlassSignIn: true });
    expect(html).toContain('Continue with Corp SSO');
    expect(html).toContain('Sign in with a password');
    expect(html).toContain('Break-glass accounts only');
  });

  it('offers no password sign-in without a break-glass account', () => {
    const html = login({ ssoEnforced: true, breakGlassSignIn: false });
    expect(html).toContain('Continue with Corp SSO');
    expect(html).not.toContain('Sign in with a password');
    expect(html).not.toContain('Break-glass');
    expect(html).not.toContain('id="password"');
  });

  it('keeps a directory that stays open under enforcement, without the local account', () => {
    const html = login({ ssoEnforced: true, breakGlassSignIn: false, directories: [{ id: 3, name: 'Corp directory' }] });
    expect(html).toContain('Sign in with Corp directory');
    expect(html).not.toContain('Sign in with a password');
    expect(html).not.toContain('Break-glass');
  });

  it('says so when nothing is left to sign in with', () => {
    const html = login({ enabledProviders: [], ssoEnforced: true, breakGlassSignIn: false });
    expect(html).toContain('Single sign-on is required, but no identity provider is enabled.');
    expect(html).not.toContain('id="password"');
  });

  it('shows the password form as before without enforcement', () => {
    const html = login({ ssoEnforced: false, breakGlassSignIn: false });
    expect(html).toContain('id="password"');
    expect(html).toContain('or with a password');
  });
});

function view(overrides: Partial<SsoEnforcementView> = {}): SsoEnforcementView {
  return {
    enabled: true,
    breakGlassUsernames: [],
    breakGlassAccounts: [],
    ssoProviders: [{ id: 'corp', name: 'Corp SSO', kind: 'oidc' }],
    warnings: [],
    configurable: true,
    ...overrides,
  };
}

const candidates: BreakGlassCandidate[] = [
  { id: 1, username: 'admin', name: 'Admin', email: 'admin@example.com', role: 'admin', status: 'active' },
  { id: 2, username: 'helpdesk', name: null, email: 'helpdesk@example.com', role: 'user', status: 'active' },
];

function sso(enforcement: SsoEnforcementView): string {
  return renderToStaticMarkup(createElement(SsoClient, { enforcement, candidates, saveEnforcement: vi.fn() }));
}

describe('Single sign-on page', () => {
  it('links the recovery steps, with no warning or host command, while enforced without a break-glass administrator', () => {
    const html = sso(view());
    expect(html).toContain('If the identity provider is down');
    expect(html).toContain(RECOVERY_DOCS);
    expect(html).not.toContain('No break-glass administrator');
    expect(html).not.toContain('docker compose');
    expect(html).not.toContain('Sign in with a password');
    expect(html).toContain('Break-glass accounts (optional)');
    expect(html).not.toContain('Check this setting');
    expect(html).not.toContain('at least one break-glass');
  });

  it('counts only an active administrator as a way back in', () => {
    const html = sso(view({
      breakGlassUsernames: ['helpdesk'],
      breakGlassAccounts: [{ id: 2, username: 'helpdesk', name: null, email: 'helpdesk@example.com', role: 'user', status: 'active', passwordSignIn: true, validAdmin: false }],
    }));
    expect(html).not.toContain('Sign in with a password');
  });

  it('shows the login-page path and the recovery link with a break-glass administrator', () => {
    const html = sso(view({
      breakGlassUsernames: ['admin'],
      breakGlassAccounts: [{ id: 1, username: 'admin', name: 'Admin', email: 'admin@example.com', role: 'admin', status: 'active', passwordSignIn: true, validAdmin: true }],
    }));
    expect(html).toContain('Sign in with a password');
    expect(html).toContain(RECOVERY_DOCS);
    expect(html).not.toContain('docker compose');
  });
});
