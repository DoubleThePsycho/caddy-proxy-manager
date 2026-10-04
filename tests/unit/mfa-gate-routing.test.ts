/**
 * Where the dashboard sends an account whose MFA grace period is over and
 * that has not set up MFA: the proxy, requireUser() and the login page all
 * lead to /mfa-setup, which stays reachable; nothing else is. Accounts the
 * policy does not hold back are unaffected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  required: new Set<number>(),
  session: { user: { id: '5', email: 'u@example.com', name: 'U', role: 'admin' } } as unknown,
}));

vi.mock('@/src/lib/mfa', () => ({
  MFA_SETUP_PATH: '/mfa-setup',
  mfaEnrolmentRequired: async (userId: number) => mocks.required.has(userId),
}));
vi.mock('@/src/lib/auth-server', () => ({
  getAuth: () => ({
    api: {
      getSession: async () => (mocks.session ? { user: { id: 5 }, session: { id: 1, createdAt: new Date() } } : null),
    },
  }),
}));
vi.mock('@/src/lib/models/user', () => ({
  getUserById: async (id: number) => ({ id, email: 'u@example.com', name: 'U', role: 'admin', status: 'active', avatarUrl: null }),
}));
vi.mock('@/src/lib/models/oauth-providers', () => ({ getProviderDisplayList: async () => [] }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const realAuth = await vi.importActual<typeof import('@/src/lib/auth')>('@/src/lib/auth');
vi.mock('@/src/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/auth')>('@/src/lib/auth');
  return { ...actual, auth: vi.fn(actual.auth) };
});

import middleware from '@/proxy';
import LoginPage from '@/app/(auth)/login/page';

beforeEach(() => {
  mocks.required.clear();
  mocks.session = { user: { id: '5' } };
});

function location(res: Response): string | null {
  const value = res.headers.get('location');
  return value ? new URL(value).pathname : null;
}

describe('proxy', () => {
  it('sends an account that must set up MFA to /mfa-setup from every protected page', async () => {
    mocks.required.add(5);
    for (const path of ['/', '/proxy-hosts', '/profile', '/api/user/change-password']) {
      const res = await middleware(new NextRequest(`http://localhost:3000${path}`));
      expect(res.status, path).toBe(307);
      expect(location(res), path).toBe('/mfa-setup');
    }
    const setup = await middleware(new NextRequest('http://localhost:3000/mfa-setup'));
    expect(location(setup)).toBeNull();
  });

  it('lets other accounts through and sends visitors without a session to /login', async () => {
    expect(location(await middleware(new NextRequest('http://localhost:3000/proxy-hosts')))).toBeNull();
    mocks.session = null;
    expect(location(await middleware(new NextRequest('http://localhost:3000/mfa-setup')))).toBe('/login');
  });
});

describe('requireUser', () => {
  it('redirects to /mfa-setup instead of returning the session', async () => {
    mocks.required.add(5);
    await expect(realAuth.requireUser()).rejects.toThrow('REDIRECT:/mfa-setup');
    await expect(realAuth.requireAdmin()).rejects.toThrow('REDIRECT:/mfa-setup');
    mocks.required.clear();
    await expect(realAuth.requireUser()).resolves.toMatchObject({ user: { id: '5' } });
  });

  it('leaves auth() alone, which the forward-auth portal relies on', async () => {
    mocks.required.add(5);
    await expect(realAuth.auth()).resolves.toMatchObject({ user: { id: '5' } });
  });
});

describe('login page', () => {
  it('sends a signed-in account to /mfa-setup or to the dashboard', async () => {
    mocks.required.add(5);
    await expect(LoginPage()).rejects.toThrow('REDIRECT:/mfa-setup');
    mocks.required.clear();
    await expect(LoginPage()).rejects.toThrow('REDIRECT:/');
  });
});
