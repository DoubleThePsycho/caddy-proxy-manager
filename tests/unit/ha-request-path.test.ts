/**
 * What a high availability standby serves: the request-path allowlist
 * (ee/high-availability/request-path.ts), the 503 "standby" answer proxy.ts gives to
 * everything else, and the health check by role and scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { REQUEST_PATH_ROUTES, isRequestPathRoute } from '@/ee/high-availability/request-path';
import { resetHaStatusCache } from '@/ee/high-availability/role';
import middleware from '@/proxy';
import { GET as health } from '@/app/api/health/route';

let dir: string;

function writeStatus(status: Record<string, unknown>) {
  const path = join(dir, 'status.json');
  writeFileSync(path, JSON.stringify({ version: 1, nodeId: 'web-1', ...status }));
  vi.stubEnv('HA_STATUS_FILE', path);
  resetHaStatusCache();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-request-path-'));
  resetHaStatusCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetHaStatusCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('isRequestPathRoute', () => {
  it('lets the forward-auth, portal and API gate routes through', () => {
    for (const path of [
      '/api/forward-auth/verify',
      '/api/forward-auth/callback',
      '/api/forward-auth/login',
      '/api/forward-auth/session-login',
      '/portal',
      '/api/monetization/gate',
      '/api/branding/logo',
      '/api/branding/favicon',
    ]) {
      expect(isRequestPathRoute(path), path).toBe(true);
    }
  });

  it('keeps the dashboard, the REST API, dashboard sign-in and the rest of monetization out', () => {
    for (const path of [
      '/',
      '/settings',
      '/login',
      '/api/auth/sign-in/email',
      '/api/v1/proxy-hosts',
      '/api/v1/high-availability/cluster',
      '/api/instances/sync',
      '/api/monetization/me',
      '/api/monetization/stripe/webhook',
      '/api-portal',
      '/api/forward-auth',
      '/api/forward-auth/verify/extra',
      '/portal/x',
      '/portals',
      '/api/brandingx',
      '/scim/v2/Users',
    ]) {
      expect(isRequestPathRoute(path), path).toBe(false);
    }
  });

  it('lists only routes that exist', () => {
    const files: Record<string, string> = {
      '/api/forward-auth/verify': 'app/api/forward-auth/verify/route.ts',
      '/api/forward-auth/callback': 'app/api/forward-auth/callback/route.ts',
      '/api/forward-auth/login': 'app/api/forward-auth/login/route.ts',
      '/api/forward-auth/session-login': 'app/api/forward-auth/session-login/route.ts',
      '/portal': 'app/(auth)/portal/page.tsx',
      '/api/monetization/gate': 'app/api/monetization/gate/route.ts',
      '/api/branding': 'app/api/branding/[asset]/route.ts',
    };
    expect(REQUEST_PATH_ROUTES.map((route) => route.path).sort()).toEqual(Object.keys(files).sort());
    for (const file of Object.values(files)) expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    for (const route of REQUEST_PATH_ROUTES) expect(route.reason.length).toBeGreaterThan(10);
  });
});

async function through(path: string) {
  return middleware(new NextRequest(`http://localhost:3000${path}`));
}

describe('proxy on a standby', () => {
  beforeEach(() => {
    vi.stubEnv('HA_ROLE', 'standby');
  });

  it('answers dashboard pages and the API with 503 standby', async () => {
    const api = await through('/api/v1/proxy-hosts');
    expect(api.status).toBe(503);
    expect(api.headers.get('retry-after')).toBe('5');
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(await api.json()).toMatchObject({ role: 'standby', error: expect.stringContaining('standby') });

    for (const path of ['/settings', '/login', '/api/auth/get-session', '/scim/v2/Users']) {
      const response = await through(path);
      expect(response.status, path).toBe(503);
    }
    const page = await through('/');
    expect(page.headers.get('content-type')).toContain('text/plain');
    expect(await page.text()).toContain('high availability standby');
  });

  it('lets the health check and the request-path routes through', async () => {
    for (const path of ['/api/health', '/api/forward-auth/verify', '/api/forward-auth/callback', '/api/monetization/gate', '/api/branding/logo']) {
      const response = await through(path);
      expect(response.status, path).not.toBe(503);
      expect(response.headers.get('x-middleware-next'), path).toBe('1');
    }
    const portal = await through('/portal');
    expect(portal.status).not.toBe(503);
    expect(portal.headers.get('content-security-policy')).toContain('script-src');
  });
});

describe('proxy without high availability', () => {
  it('never answers 503 standby', async () => {
    const response = await through('/api/v1/proxy-hosts');
    expect(response.status).not.toBe(503);
  });
});

async function check(scope?: string) {
  const response = await health(new NextRequest(`http://localhost:3000/api/health${scope ? `?scope=${scope}` : ''}`));
  return { status: response.status, body: await response.json() };
}

describe('health check', () => {
  it('answers 200 ok without high availability, whatever the scope', async () => {
    expect(await check()).toEqual({ status: 200, body: { status: 'ok' } });
    expect(await check('request-path')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('sends dashboard traffic to the leader only', async () => {
    vi.stubEnv('HA_ROLE', 'leader');
    writeStatus({ role: 'leader', fenceAt: new Date(Date.now() + 10_000).toISOString() });
    expect(await check()).toEqual({ status: 200, body: { status: 'ok', role: 'leader' } });

    vi.stubEnv('HA_ROLE', 'standby');
    writeStatus({ role: 'standby', fenceAt: null, follow: { replicaId: 'e3-aaaaaaaa', ready: false, error: null } });
    expect(await check()).toEqual({ status: 503, body: { status: 'standby', role: 'standby' } });
    expect((await check('live')).status).toBe(200);
    // A standby serves the request-path routes once it has a copy of the database.
    expect((await check('request-path')).status).toBe(503);
    writeStatus({ role: 'standby', fenceAt: null, follow: { replicaId: 'e3-aaaaaaaa', ready: true, error: null } });
    expect(await check('request-path')).toEqual({ status: 200, body: { status: 'ok', role: 'standby' } });
  });

  it('takes a leader out of rotation once its lease can no longer be vouched for', async () => {
    vi.stubEnv('HA_ROLE', 'leader');
    writeStatus({ role: 'leader', fenceAt: new Date(Date.now() - 1).toISOString() });
    expect(await check()).toEqual({ status: 503, body: { status: 'fenced', role: 'leader' } });
    vi.stubEnv('HA_STATUS_FILE', join(dir, 'missing.json'));
    resetHaStatusCache();
    expect((await check()).status).toBe(503);
    expect((await check('live')).status).toBe(200);
  });
});
