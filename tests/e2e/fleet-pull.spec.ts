/**
 * Fleet pull replicas on the master of the test stack (web-master:3002). The
 * stack has no license, so this covers what works without one: the pull
 * endpoint reaches its route without a session (the proxy middleware lets it
 * through) and refuses unknown credentials, adding a pull replica is refused,
 * and the Fleet page shows the Pull replicas card with the license notice.
 */
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';

const MASTER = 'http://localhost:3002';

async function loginContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseURL}/login`);
  await page.getByRole('textbox', { name: /username/i }).fill('testadmin');
  await page.getByRole('textbox', { name: /password/i }).fill('TestPassword2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
  await page.close();
  return context;
}

test.describe.serial('Fleet pull replicas (master, unlicensed)', () => {
  let master: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    master = await loginContext(browser, MASTER);
  });

  test.afterAll(async () => {
    await master.close();
  });

  test('the pull endpoint answers without a session and refuses an unknown credential', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext();
    const response = await anonymous.post(`${MASTER}/api/instances/pull`, {
      data: { version: 1 },
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer pull_${'a'.repeat(43)}` },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(response.headers()['cache-control']).toContain('no-store');
    await anonymous.dispose();
  });

  test('refuses to add a pull replica without a license', async () => {
    const response = await master.request.post(`${MASTER}/api/v1/fleet/pull-replicas`, {
      data: { name: 'e2e-branch' },
      headers: { 'Content-Type': 'application/json', Origin: MASTER },
    });
    expect(response.status()).toBe(403);
    const list = await master.request.get(`${MASTER}/api/v1/fleet/pull-replicas`);
    expect(list.status()).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  test('shows the Pull replicas card on the Fleet page', async () => {
    const page = await master.newPage();
    await page.goto(`${MASTER}/fleet`);
    await expect(page.getByText('Pull replicas', { exact: true })).toBeVisible();
    await expect(page.getByText(/Adding pull replicas and issuing credentials needs an active .* Enterprise license or higher/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Add pull replica/ })).toBeDisabled();
    await page.close();
  });
});
