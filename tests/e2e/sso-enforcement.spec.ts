/**
 * E2E tests: enforced SSO (ee/sso) with and without break-glass accounts.
 *
 * The E2E stack has no license, and enforcement never checks one, so the
 * setting is written straight into the database (as an administrator would
 * have saved it while licensed); the OAuth provider it needs comes from the
 * REST API. Existing sessions stay valid under enforcement, so the admin's
 * stored session keeps working. Turning enforcement off needs no license and
 * is done through the dashboard. Everything is removed afterwards, so the
 * login page of later specs is the usual one.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { webSql, writeSettingRow } from '../helpers/e2e-sql';

const BASE = 'http://localhost:3000';
const PROVIDER_NAME = 'E2E Enforced SSO';
const COMMAND = 'docker compose exec web bun db-tools/break-glass.js turn-off-sso-enforcement';

let providerId: string | null = null;

function setEnforcement(enabled: boolean, breakGlassUserIds: number[]): void {
  writeSettingRow('sso_enforcement', { enabled, breakGlassUserIds });
}

function storedEnforcement(): { enabled: boolean; breakGlassUserIds: number[] } | null {
  const [row] = webSql<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['sso_enforcement']);
  return row ? JSON.parse(row.value) : null;
}

function adminId(): number {
  const [row] = webSql<{ id: number }>('SELECT id FROM users WHERE username = ?', ['testadmin']);
  return Number(row.id);
}

async function removeProviders(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${BASE}/api/v1/oauth-providers`);
  const providers = (await response.json()) as Array<{ id: string; name: string }>;
  for (const provider of providers.filter((entry) => entry.name === PROVIDER_NAME)) {
    await request.delete(`${BASE}/api/v1/oauth-providers/${provider.id}`, { headers: { Origin: BASE } });
  }
}

test.describe.serial('Enforced SSO', () => {
  test.beforeAll(async ({ request }) => {
    webSql('DELETE FROM settings WHERE key = ?', ['sso_enforcement']);
    await removeProviders(request);
    const created = await request.post(`${BASE}/api/v1/oauth-providers`, {
      headers: { Origin: BASE },
      data: { name: PROVIDER_NAME, type: 'oidc', clientId: 'e2e-enforced-sso', clientSecret: 'e2e-enforced-sso-secret', issuer: 'https://sso.example.com' },
    });
    expect(created.ok()).toBeTruthy();
    providerId = ((await created.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    webSql('DELETE FROM settings WHERE key = ?', ['sso_enforcement']);
    if (providerId) await request.delete(`${BASE}/api/v1/oauth-providers/${providerId}`, { headers: { Origin: BASE } });
  });

  test('without a break-glass account the login page offers no password sign-in', async ({ browser }) => {
    setEnforcement(true, []);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await expect(page.getByRole('button', { name: new RegExp(`Continue with ${PROVIDER_NAME}`) })).toBeVisible();
    await expect(page.getByText('Sign in with a password')).toHaveCount(0);
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/break-glass/i)).toHaveCount(0);
    await context.close();
  });

  test('the Single sign-on page shows the way back in as a note', async ({ page }) => {
    setEnforcement(true, []);
    await page.goto(`${BASE}/sso`);
    const note = page.getByTestId('no-break-glass-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText(COMMAND);
    await expect(page.getByText('Break-glass accounts (optional)')).toBeVisible();
    await expect(page.getByText(/at least one break-glass/i)).toHaveCount(0);
  });

  test('the Sign-in and directories page shows the same note and no password option', async ({ page }) => {
    setEnforcement(true, []);
    await page.goto(`${BASE}/sign-in`);
    await expect(page.getByTestId('no-break-glass-note')).toContainText(COMMAND);
    const options = page.getByRole('list', { name: 'Login page options' });
    await expect(options).toContainText(`Continue with ${PROVIDER_NAME}`);
    await expect(options).not.toContainText('Break-glass sign-in');
  });

  test('with a break-glass account the login page keeps the password sign-in', async ({ browser, page }) => {
    setEnforcement(true, [adminId()]);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const login = await context.newPage();
    await login.goto(`${BASE}/login`);
    const toggle = login.getByRole('button', { name: /Sign in with a password/ });
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Break-glass accounts only');
    await toggle.click();
    await expect(login.getByLabel('Password', { exact: true })).toBeVisible();
    await context.close();

    await page.goto(`${BASE}/sso`);
    await expect(page.getByTestId('no-break-glass-note')).toHaveCount(0);
    await expect(page.getByText(COMMAND)).toBeVisible();
  });

  test('enforcement without a break-glass account can be turned off from the dashboard', async ({ page }) => {
    setEnforcement(true, []);
    await page.goto(`${BASE}/sign-in`);
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Single sign-on is not required' })).toBeVisible();
    expect(storedEnforcement()).toEqual({ enabled: false, breakGlassUserIds: [] });

    const anonymous = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } });
    const login = await anonymous.newPage();
    await login.goto(`${BASE}/login`);
    await expect(login.getByLabel('Password', { exact: true })).toBeVisible();
    await anonymous.close();
  });
});
