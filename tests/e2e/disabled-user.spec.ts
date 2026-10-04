/**
 * E2E tests: Disabled user enforcement.
 *
 * Verifies that disabling a user actually blocks them:
 *
 * 1. Disabled user's existing UI session is rejected (pages redirect to /login)
 * 2. Disabled user cannot log in with credentials
 * 3. Disabled user's API token returns 401
 * 4. Re-enabling the user restores access
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { createApiTokenFor, ensureLocalUser, webSql } from '../helpers/e2e-sql';

const BASE = 'http://localhost:3000';
const API_BASE = `${BASE}/api/v1`;

const TEST_USERNAME = 'disabletest';
const TEST_EMAIL = `${TEST_USERNAME}@localhost`;
const TEST_PASSWORD = 'DisableTest2026!';

// ── Helpers ─────────────────────────────────────────────────────────────

function ensureTestUser() {
  ensureLocalUser({ username: TEST_USERNAME, password: TEST_PASSWORD, role: 'user', email: TEST_EMAIL });
}

function setUserStatus(status: 'active' | 'disabled') {
  webSql('UPDATE users SET status = ?, "updatedAt" = ? WHERE email = ?', [status, new Date().toISOString(), TEST_EMAIL]);
}

function createApiToken(): string {
  return createApiTokenFor(TEST_EMAIL, 'test-disabled-token');
}

async function loginAs(
  browser: import('@playwright/test').Browser,
  username: string,
  password: string
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
  await page.close();
  return context;
}

// ── Tests ───────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Disabled user enforcement', () => {
  test.beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        ensureTestUser();
        break;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  });

  test.afterAll(async () => {
    // Re-enable user so it doesn't affect other tests
    try { setUserStatus('active'); } catch { /* best effort */ }
  });

  test('disabled user UI session is rejected', async ({ browser }) => {
    // Log in while active
    const context = await loginAs(browser, TEST_USERNAME, TEST_PASSWORD);

    // Verify session works
    const page = await context.newPage();
    await page.goto(BASE);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
    await page.close();

    // Disable user
    setUserStatus('disabled');

    // Existing session should now be rejected — page should redirect to /login
    const page2 = await context.newPage();
    await page2.goto(BASE);
    await expect(page2).toHaveURL(/\/login/, { timeout: 15_000 });
    await page2.close();

    await context.close();

    // Re-enable for subsequent tests
    setUserStatus('active');
  });

  test('disabled user cannot log in', async ({ page }) => {
    // Disable first
    setUserStatus('disabled');

    await page.goto(`${BASE}/login`);
    await page.getByLabel('Username').fill(TEST_USERNAME);
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Should stay on login page or show an error
    await expect(async () => {
      const url = page.url();
      const hasError = await page.getByText(/invalid|disabled|error|failed|incorrect/i)
        .isVisible({ timeout: 1_000 }).catch(() => false);
      expect(url.includes('/login') || hasError).toBe(true);
    }).toPass({ timeout: 15_000 });

    // Re-enable for subsequent tests
    setUserStatus('active');
  });

  test('disabled user API token returns 401', async ({ request }) => {
    const token = createApiToken();

    // Token should work while active
    const res1 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res1.status()).toBe(200);

    // Disable user
    setUserStatus('disabled');

    // Token should now be rejected
    const res2 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res2.status()).toBe(401);

    // Re-enable for subsequent tests
    setUserStatus('active');
  });

  test('re-enabling user restores API access', async ({ request }) => {
    const token = createApiToken();

    // Disable
    setUserStatus('disabled');
    const res1 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res1.status()).toBe(401);

    // Re-enable
    setUserStatus('active');
    const res2 = await request.get(`${API_BASE}/tokens`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res2.status()).toBe(200);
  });

  test('re-enabling user restores UI login', async ({ browser }) => {
    // Disable then re-enable
    setUserStatus('disabled');
    setUserStatus('active');

    // Should be able to log in again
    const context = await loginAs(browser, TEST_USERNAME, TEST_PASSWORD);
    const page = await context.newPage();
    await page.goto(BASE);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
    await page.close();
    await context.close();
  });
});
