/**
 * Two replicas, one database: what one replica changes the other serves at
 * once, a session signed in on one works on the other, and a proxy host
 * created on either reaches Caddy (ee/docs/high-availability.md,
 * "PostgreSQL replicas"; src/lib/db/README.md, "Events and shared state").
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { httpGet } from '../../helpers/http';
import {
  ADMIN,
  PUBLIC_ORIGIN,
  REPLICA_A,
  REPLICA_B,
  clientAddress,
  eventually,
  type Replica,
} from '../../helpers/replicas';

const HOST_ON_A = { name: 'Replica A host', domain: 'replica-a-host.test' };
const HOST_ON_B = { name: 'Replica B host', domain: 'replica-b-host.test' };
const PROVIDER_NAME = 'Replica E2E provider';
/** "Within a second or two" (cache invalidation over LISTEN/NOTIFY), with slack for a loaded VM. */
const PROPAGATION_MS = 5_000;

let token = '';
const bearer = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const createdHosts: Array<{ replica: Replica; id: number }> = [];

async function createHost(request: APIRequestContext, replica: Replica, host: { name: string; domain: string }): Promise<number> {
  const response = await request.post(`${replica.url}/api/v1/proxy-hosts`, {
    headers: bearer(),
    data: { name: host.name, domains: [host.domain], upstreams: ['echo-server:8080'], sslForced: false },
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { id: number }).id;
  createdHosts.push({ replica, id });
  return id;
}

test.describe.serial('Two replicas: one database', () => {
  test('setup: an API token made on replica A', async ({ request }) => {
    const response = await request.post(`${REPLICA_A.url}/api/v1/tokens`, {
      headers: { Origin: REPLICA_A.url },
      data: { name: `replicas-e2e-${Date.now()}` },
    });
    expect(response.status(), await response.text()).toBe(201);
    token = ((await response.json()) as { raw_token: string }).raw_token;
    // The token, stored by A, works on B.
    expect((await request.get(`${REPLICA_B.url}/api/v1/proxy-hosts`, { headers: bearer() })).status()).toBe(200);
  });

  test('a proxy host created on replica A is listed on replica B', async ({ page, request }) => {
    const id = await createHost(request, REPLICA_A, HOST_ON_A);
    const onB = await request.get(`${REPLICA_B.url}/api/v1/proxy-hosts/${id}`, { headers: bearer() });
    expect(onB.status()).toBe(200);
    expect(await onB.json()).toMatchObject({ id, name: HOST_ON_A.name, domains: [HOST_ON_A.domain] });

    await page.goto(`${REPLICA_B.url}/proxy-hosts`);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText(HOST_ON_A.name).first()).toBeVisible();
  });

  test('a proxy host created on replica B is applied to Caddy and reaches its upstream', async ({ request }) => {
    const id = await createHost(request, REPLICA_B, HOST_ON_B);
    await eventually(`${HOST_ON_B.domain} answering through Caddy`, async () => {
      const response = await httpGet(HOST_ON_B.domain);
      return response.status === 200 && response.body.includes('echo-ok') ? true : null;
    }, 30_000, 500);
    // And A lists it.
    expect((await request.get(`${REPLICA_A.url}/api/v1/proxy-hosts/${id}`, { headers: bearer() })).status()).toBe(200);
  });

  test('a setting saved on replica A is read on replica B', async ({ request }) => {
    const before = await (await request.get(`${REPLICA_A.url}/api/v1/settings/general`, { headers: bearer() })).json();
    try {
      const saved = await request.put(`${REPLICA_A.url}/api/v1/settings/general`, {
        headers: bearer(),
        data: { ...before, primaryDomain: 'replicas.example.com' },
      });
      expect(saved.status(), await saved.text()).toBe(200);
      const onB = await (await request.get(`${REPLICA_B.url}/api/v1/settings/general`, { headers: bearer() })).json();
      expect(onB.primaryDomain).toBe('replicas.example.com');
    } finally {
      await request.put(`${REPLICA_A.url}/api/v1/settings/general`, { headers: bearer(), data: before });
    }
  });

  test('a sign-in provider added on replica A is offered by replica B within seconds', async ({ request }) => {
    // Better Auth is built from the providers in memory (src/lib/db/cached-value.ts):
    // B rebuilds it when A announces the change, long before the 30 s refresh.
    const startSignIn = (replica: Replica, providerId: string) =>
      request.post(`${replica.url}/api/auth/sign-in/social`, {
        headers: { Origin: PUBLIC_ORIGIN, 'x-forwarded-for': clientAddress() },
        data: { provider: providerId, callbackURL: '/' },
      });

    const created = await request.post(`${REPLICA_A.url}/api/v1/oauth-providers`, {
      headers: bearer(),
      data: {
        name: PROVIDER_NAME,
        type: 'oauth2',
        clientId: 'replicas-e2e-client',
        clientSecret: 'replicas-e2e-secret',
        authorizationUrl: 'https://idp.example.test/authorize',
        tokenUrl: 'https://idp.example.test/token',
        userinfoUrl: 'https://idp.example.test/userinfo',
        scopes: 'openid email profile',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const providerId = ((await created.json()) as { id: string }).id;
    try {
      const startedAt = Date.now();
      const url = await eventually('replica B offering the new provider', async () => {
        const response = await startSignIn(REPLICA_B, providerId);
        if (response.status() !== 200) return null;
        return ((await response.json()) as { url?: string }).url ?? null;
      }, PROPAGATION_MS, 200);
      expect(url).toMatch(/^https:\/\/idp\.example\.test\/authorize\?/);
      console.log(`[replicas] replica B offered the provider ${Date.now() - startedAt} ms after A created it`);
    } finally {
      const removed = await request.delete(`${REPLICA_A.url}/api/v1/oauth-providers/${providerId}`, { headers: bearer() });
      expect(removed.status()).toBeLessThan(300);
    }
    // And forgets it as quickly.
    await eventually('replica B dropping the removed provider', async () => {
      const response = await startSignIn(REPLICA_B, providerId);
      return response.status() === 404 ? true : null;
    }, PROPAGATION_MS, 200);
  });

  test('a session signed in on replica A works on replica B, and signing out on B ends it on A', async ({ playwright }) => {
    const client = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const signIn = await client.post(`${REPLICA_A.url}/api/auth/sign-in/username`, {
        headers: { Origin: PUBLIC_ORIGIN, 'x-forwarded-for': clientAddress() },
        data: { username: ADMIN.username, password: ADMIN.password },
      });
      expect(signIn.status(), await signIn.text()).toBe(200);

      const sessionOnB = await client.get(`${REPLICA_B.url}/api/auth/get-session`);
      expect(sessionOnB.status()).toBe(200);
      expect(((await sessionOnB.json()) as { user?: { username?: string } } | null)?.user?.username).toBe(ADMIN.username);
      expect((await client.get(`${REPLICA_B.url}/api/v1/proxy-hosts`)).status()).toBe(200);

      const signOut = await client.post(`${REPLICA_B.url}/api/auth/sign-out`, { headers: { Origin: PUBLIC_ORIGIN }, data: {} });
      expect(signOut.status()).toBe(200);
      // The cookie is gone from this client; replay the old one to check the session row is gone too.
      const replay = await playwright.request.newContext({
        storageState: { cookies: [], origins: [] },
        extraHTTPHeaders: { cookie: signIn.headers()['set-cookie']?.split('\n').map((line) => line.split(';')[0]).join('; ') ?? '' },
      });
      try {
        const sessionOnA = await replay.get(`${REPLICA_A.url}/api/auth/get-session`);
        expect(await sessionOnA.json()).toBeNull();
        expect((await replay.get(`${REPLICA_A.url}/api/v1/proxy-hosts`)).status()).toBe(401);
      } finally {
        await replay.dispose();
      }
    } finally {
      await client.dispose();
    }
  });

  test('a dashboard session from replica A opens pages on replica B', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      await page.setExtraHTTPHeaders({ 'x-forwarded-for': clientAddress() });
      await page.goto(`${REPLICA_A.url}/login`);
      await page.getByRole('textbox', { name: /username/i }).fill(ADMIN.username);
      await page.getByRole('textbox', { name: /password/i }).fill(ADMIN.password);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });

      await page.goto(`${REPLICA_B.url}/proxy-hosts`);
      await expect(page).toHaveURL(new RegExp(`^${REPLICA_B.url}/proxy-hosts`));
      await expect(page.getByText(HOST_ON_B.name).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ playwright }) => {
    if (!token) return;
    const client = await playwright.request.newContext();
    try {
      for (const { replica, id } of createdHosts) {
        await client.delete(`${replica.url}/api/v1/proxy-hosts/${id}`, { headers: bearer() });
      }
    } finally {
      await client.dispose();
    }
  });
});
