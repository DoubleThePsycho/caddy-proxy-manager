import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Passkeys end to end with Chromium's virtual WebAuthn authenticator: adding
 * one on Profile, signing in with it from the login page, and the password
 * step of an account whose only second factor is a passkey asking for the
 * passkey. A dedicated user is used and deleted afterwards: the login page
 * offers passkey sign-in only while some account has a passkey, so the other
 * specs keep seeing the plain form.
 */

const BASE_URL = 'http://localhost:3000';
const USER = { username: 'passkey-e2e', email: 'passkey-e2e@example.com', password: 'Passkey-E2E-2026!' };

let userId: number | null = null;

async function withVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function signInWithPassword(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Username').fill(USER.username);
  await page.getByLabel('Password').fill(USER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe('Passkeys', () => {
  test.setTimeout(120_000);

  test.beforeAll(async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/v1/users`, {
      headers: { Origin: BASE_URL },
      data: { email: USER.email, username: USER.username, password: USER.password, role: 'user', name: 'Passkey E2E' },
    });
    expect(response.status()).toBe(201);
    userId = (await response.json()).id;
  });

  test.afterAll(async ({ request }) => {
    // Deleting the user deletes its passkeys, so the login page goes back to the plain form.
    if (userId !== null) await request.delete(`${BASE_URL}/api/v1/users/${userId}`, { headers: { Origin: BASE_URL } });
  });

  test('add a passkey on Profile, then sign in with it', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await withVirtualAuthenticator(context, page);
      await signInWithPassword(page);
      await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

      await page.goto(`${BASE_URL}/profile`);
      await page.getByRole('button', { name: 'Add a passkey' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill('Virtual key');
      await dialog.getByLabel('Password', { exact: true }).fill(USER.password);
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('Virtual key')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Multi-factor on')).toBeVisible();

      // Sign out, then back in with the passkey alone.
      await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
      await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
      await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
      await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

      // The password step alone no longer signs this account in.
      await context.clearCookies();
      await signInWithPassword(page);
      await expect(page.getByTestId('passkey-challenge')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Password accepted for')).toBeVisible();
      await page.getByRole('button', { name: 'Use your passkey' }).click();
      await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    } finally {
      await context.close();
    }
  });
});
