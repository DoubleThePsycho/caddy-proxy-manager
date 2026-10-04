/**
 * Fleet management on the master/slave pair of the test stack
 * (web-master:3002, web-slave:3003). The stack has no license, so this
 * covers what works without one: the page, the license refusal for setting
 * up environments, and drift detection against a slave running this release
 * (the status reply of GET /api/instances/sync?status=1).
 */
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';

const MASTER = 'http://localhost:3002';
const TOKEN = 'e2e-sync-token-0123456789abcdef0123456789';

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

test.describe.serial('Fleet management (master → slave, unlicensed)', () => {
  let master: BrowserContext;
  let instanceId: number | null = null;

  test.beforeAll(async ({ browser }) => {
    master = await loginContext(browser, MASTER);
  });

  test.afterAll(async () => {
    if (instanceId !== null) {
      await master.request.delete(`${MASTER}/api/v1/instances/${instanceId}`, { headers: { Origin: MASTER } });
    }
    await master.close();
  });

  test('shows the Fleet page with the license notice', async () => {
    const page = await master.newPage();
    await page.goto(`${MASTER}/fleet`);
    await expect(page.getByRole('heading', { name: 'Fleet', exact: true })).toBeVisible();
    await expect(page.getByText(/Fleet management needs an active .* Enterprise license or higher/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Environments', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nodes', exact: true })).toBeVisible();
    // Without a license no environment can be created.
    await expect(page.getByRole('button', { name: 'New environment' })).toHaveCount(0);
    await page.close();
  });

  test('refuses to create an environment without a license', async () => {
    const response = await master.request.post(`${MASTER}/api/v1/fleet/environments`, {
      data: { name: 'e2e-production', promotionOnly: true },
      headers: { 'Content-Type': 'application/json', Origin: MASTER },
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error).toMatch(/Fleet management needs an active/);
  });

  test('reports the slave in sync after a sync, without a license', async () => {
    const created = await master.request.post(`${MASTER}/api/v1/instances`, {
      data: { name: 'fleet-e2e-slave', baseUrl: 'http://web-slave:3000', apiToken: TOKEN },
      headers: { 'Content-Type': 'application/json', Origin: MASTER },
    });
    expect(created.status()).toBe(201);
    instanceId = (await created.json()).id;

    const sync = await master.request.post(`${MASTER}/api/v1/instances/sync`, { headers: { Origin: MASTER } });
    expect(sync.status()).toBe(200);
    expect((await sync.json()).failed).toBe(0);

    const drift = await master.request.post(`${MASTER}/api/v1/fleet/drift`, { headers: { Origin: MASTER } });
    expect(drift.status()).toBe(200);
    const instance = (await drift.json()).find((item: { id: number }) => item.id === instanceId);
    expect(instance.drift).toMatchObject({ status: 'in_sync', localChanges: false });
    expect(instance.drift.reportedVersion).toEqual(expect.any(String));
  });
});
