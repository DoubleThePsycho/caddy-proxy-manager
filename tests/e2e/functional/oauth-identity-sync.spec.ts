import { test, expect } from '@playwright/test';

/**
 * Regression (#261): OAuth link/unlink did not synchronize the Ingressi user state.
 *
 * Better Auth stores federated identities in the `accounts` table, while the
 * Profile page (and admin user list) read the informational `users.provider` /
 * `users.subject` columns. Three symptoms were reported:
 *
 *   1. OAuth auto-link created a working accounts row but left
 *      users.provider/subject empty — OAuth sign-in worked while the Profile
 *      page claimed the account was NOT linked.
 *   2. "Link <provider>" from the Profile page completed at the IdP but was
 *      never reflected in the Profile UI (same staleness).
 *   3. "Unlink OAuth Account" deleted the accounts rows but left
 *      users.provider/subject populated — the Profile page kept claiming the
 *      account was linked.
 *
 * The hostile IdP is `mock-oauth2-server` (interactiveLogin:false) with three
 * issuers (linker-a/b/c) that all issue identities for the Ingressi admin email
 * (testadmin@localhost) but with distinct `sub` values, so each test links a
 * fresh identity regardless of cleanup order.
 */

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const ORIGIN = BASE_URL;
const ADMIN_EMAIL = 'testadmin@localhost';

interface ApiUser {
  id: number;
  email: string;
  role: string;
  provider: string | null;
  subject: string | null;
}

interface ApiProvider {
  id: string;
  name: string;
  autoLink: boolean;
}

async function getAdminUser(request: import('@playwright/test').APIRequestContext): Promise<ApiUser> {
  const resp = await request.get(`${API}/users`);
  expect(resp.ok(), 'list users').toBeTruthy();
  const users = (await resp.json()) as ApiUser[];
  const admin = users.find((u) => u.email === ADMIN_EMAIL);
  expect(admin, 'admin user exists').toBeDefined();
  return admin!;
}

/** Create a mock-IdP-backed OAuth provider with auto-link enabled. */
async function createLinkerProvider(
  request: import('@playwright/test').APIRequestContext,
  issuerId: string
): Promise<ApiProvider> {
  const name = `Link IdP ${issuerId} ${Date.now()}`;
  const createResp = await request.post(`${API}/oauth-providers`, {
    headers: { Origin: ORIGIN },
    data: {
      name,
      type: 'oidc',
      clientId: 'ingressi',
      clientSecret: 'secret',
      issuer: `http://mock-oidc:8080/${issuerId}`,
      authorizationUrl: `http://localhost:5557/${issuerId}/authorize`,
      tokenUrl: `http://mock-oidc:8080/${issuerId}/token`,
      userinfoUrl: `http://mock-oidc:8080/${issuerId}/userinfo`,
      scopes: 'openid email profile',
      autoLink: true,
    },
  });
  expect(createResp.ok(), 'create oauth provider').toBeTruthy();
  const provider = (await createResp.json()) as ApiProvider;
  expect(provider.autoLink, 'provider created with auto-link').toBe(true);
  return provider;
}

async function deleteProvider(request: import('@playwright/test').APIRequestContext, providerId: string) {
  await request.delete(`${API}/oauth-providers/${providerId}`, { headers: { Origin: ORIGIN } }).catch(() => {});
}

/** Restore the admin user to a password-only identity after a test. */
async function unlinkAdmin(request: import('@playwright/test').APIRequestContext) {
  await request.post(`${BASE_URL}/api/user/unlink-oauth`, { headers: { Origin: ORIGIN } }).catch(() => {});
}

/**
 * Complete a real OAuth sign-in in a clean (sessionless) browser context.
 * mock-oauth2-server auto-issues the authorization code, so the flow finishes
 * without any user interaction.
 */
async function oauthSignInAsAdmin(browser: import('@playwright/test').Browser, providerName: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/login`);
    const button = page.getByRole('button', { name: new RegExp(`continue with ${providerName}`, 'i') });
    await expect(button).toBeVisible({ timeout: 15_000 });
    await button.click();

    await page.waitForURL(
      (url) => {
        try {
          const u = new URL(url);
          return (
            u.origin === BASE_URL &&
            !u.pathname.startsWith('/api/auth') &&
            !u.pathname.startsWith('/login')
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    );
    expect(page.url(), 'OAuth sign-in should not error').not.toContain('error');
  } finally {
    await ctx.close();
  }
}

test.describe('OAuth link/unlink synchronizes the Ingressi user state (#261)', () => {
  const providerIds: string[] = [];

  test.afterEach(async ({ request }) => {
    // Restore the pre-test state even when assertions fail, so a broken run
    // does not poison the admin identity for the rest of the suite.
    await unlinkAdmin(request);
    for (const id of providerIds.splice(0)) {
      await deleteProvider(request, id);
    }
  });

  test('auto-link via OAuth sign-in updates users.provider/subject and the Profile page', async ({ page, browser }) => {
    test.setTimeout(90_000);
    const admin = page.request;
    const provider = await createLinkerProvider(admin, 'linker-a');
    providerIds.push(provider.id);

    // Real federated sign-in against the existing admin account (same email).
    await oauthSignInAsAdmin(browser, provider.name);

    // The accounts-table link must be projected onto the user record…
    const adminUser = await getAdminUser(admin);
    expect(adminUser.provider, 'users.provider must reflect the linked OAuth identity').toBe(provider.id);
    expect(adminUser.subject, 'users.subject must carry the IdP sub claim').toBe('linker-sub-a');

    // …and the Profile page must show the account as linked.
    await page.goto('/profile');
    await expect(page.getByText(/your account is linked to/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(provider.name).first()).toBeVisible();
  });

  test('linking from the Profile page completes and is reflected', async ({ page }) => {
    test.setTimeout(90_000);
    const admin = page.request;
    const provider = await createLinkerProvider(admin, 'linker-b');
    providerIds.push(provider.id);

    // Admin is signed in via storageState; link from the Profile page.
    await page.goto('/profile');
    const linkButton = page.getByRole('button', { name: new RegExp(`^link ${provider.name}$`, 'i') });
    await expect(linkButton).toBeVisible({ timeout: 15_000 });
    await linkButton.click();

    // The IdP auto-issues and the callback returns to /profile — now linked.
    await expect(page.getByText(/your account is linked to/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(provider.name).first()).toBeVisible();

    const adminUser = await getAdminUser(admin);
    expect(adminUser.provider).toBe(provider.id);
    expect(adminUser.subject).toBe('linker-sub-b');
  });

  test('unlinking resets users.provider/subject and the Profile page', async ({ page, browser }) => {
    test.setTimeout(90_000);
    const admin = page.request;
    const provider = await createLinkerProvider(admin, 'linker-c');
    providerIds.push(provider.id);

    // Set up the linked state through a real OAuth sign-in…
    await oauthSignInAsAdmin(browser, provider.name);
    expect((await getAdminUser(admin)).provider).toBe(provider.id);

    // …then unlink from the Profile page.
    await page.goto('/profile');
    const unlinkButton = page.getByRole('button', { name: /unlink oauth account/i });
    await expect(unlinkButton).toBeVisible({ timeout: 15_000 });
    await unlinkButton.click();
    await page.getByRole('button', { name: /^unlink oauth$/i }).click();

    // The page reloads and must show the account as no longer linked, offering to link it again.
    await expect(page.getByRole('button', { name: new RegExp(`^link ${provider.name}$`, 'i') })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/your account is linked to/i)).toHaveCount(0);

    const adminUser = await getAdminUser(admin);
    expect(adminUser.provider, 'users.provider must fall back to credentials').toBe('credentials');
    expect(adminUser.subject, 'users.subject must be cleared').toBeNull();

    // OAuth sign-in with the unlinked identity must NOT silently re-link while
    // auto-link remains on — actually it may re-link (trusted provider), which
    // is by design; what matters is the unlink itself fully unlinked the
    // identity at unlink time, which the assertions above verify.
  });
});
