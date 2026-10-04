/**
 * Multi-tenancy (ee/multi-tenancy) in the test stack, which has no license:
 * the Organisations and Usage pages load (the first with the licensing
 * notice), organisations cannot be created, nothing moves into one, and an
 * install without organisations works exactly as before. Isolation between
 * organisations (every resource, operation and surface) is covered by
 * tests/integration/multi-tenancy-isolation.test.ts and
 * tests/integration/multi-tenancy.test.ts, which can sign test licenses.
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
const HEADERS = { 'Content-Type': 'application/json', Origin: BASE };

test.describe('Multi-tenancy (unlicensed)', () => {
  test('the Organisations page loads with the licensing notice', async ({ page }) => {
    await page.goto('/organizations');
    // The title carries the count and the edition pill ("Organisations 0 MSP edition").
    await expect(page.getByRole('heading', { level: 1, name: /^Organisations/ })).toBeVisible();
    await expect(page.getByText('MSP edition')).toBeVisible();
    await expect(page.getByText(/Multi-tenancy needs a .* MSP license or higher/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No organisations yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: /New organisation/ })).toHaveCount(0);
    // No organisations: no switcher.
    await expect(page.getByTestId('organization-switcher')).toHaveCount(0);
  });

  test('Organisations and Usage are in the navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Organisations' }).first().click();
    await expect(page).toHaveURL(/\/organizations/);
    await page.getByRole('link', { name: 'Usage' }).first().click();
    await expect(page).toHaveURL(/\/usage/);
    await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Provider', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', /\/api\/v1\/usage-reports\?.*format=csv/);
  });

  test('REST API: reading works, creating and moving into an organisation need the license', async ({ page }) => {
    const list = await page.request.get(`${BASE}/api/v1/organizations`);
    expect(list.status()).toBe(200);
    expect(await list.json()).toEqual([]);

    const create = await page.request.post(`${BASE}/api/v1/organizations`, { headers: HEADERS, data: { name: 'E2E Acme' } });
    expect(create.status()).toBe(403);
    expect((await create.json()).error).toMatch(/Multi-tenancy needs an active .* MSP license/);

    const move = await page.request.post(`${BASE}/api/v1/organizations/move`, { headers: HEADERS, data: { organizationId: 1, proxyHostIds: [1] } });
    expect(move.status()).toBe(404);

    const catalogue = await (await page.request.get(`${BASE}/api/v1/permissions`)).json();
    expect(catalogue.adminLevel.permissions).toContain('organizations:write');

    const openapi = await (await page.request.get(`${BASE}/api/v1/openapi.json`)).json();
    expect(openapi.paths['/api/v1/organizations/move']).toBeDefined();
    expect(openapi.paths['/api/v1/usage-reports']).toBeDefined();
  });

  test('usage reports as JSON and CSV', async ({ page }) => {
    const json = await page.request.get(`${BASE}/api/v1/usage-reports`);
    expect(json.status()).toBe(200);
    const report = await json.json();
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ organizationId: null, organizationName: 'Provider' });

    const csv = await page.request.get(`${BASE}/api/v1/usage-reports?format=csv`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toMatch(/text\/csv/);
    expect((await csv.text()).split('\r\n')[0]).toBe(
      'organizationId,organizationSlug,organizationName,from,to,proxyHosts,enabledProxyHosts,users,requests,bytes,wafBlocks'
    );
    expect((await page.request.get(`${BASE}/api/v1/usage-reports?month=2026-13`)).status()).toBe(400);
  });

  test('without organisations hosts work as before and stay provider-level', async ({ page }) => {
    const created = await page.request.post(`${BASE}/api/v1/proxy-hosts`, {
      headers: HEADERS,
      data: { name: 'E2E tenancy host', domains: ['tenancy-e2e.example.com'], upstreams: ['localhost:9997'] },
    });
    expect(created.status()).toBe(201);
    const host = await created.json();
    try {
      expect(host.organizationId).toBeNull();
      const filtered = await page.request.get(`${BASE}/api/v1/proxy-hosts?organizationId=provider`);
      expect((await filtered.json()).some((entry: { id: number }) => entry.id === host.id)).toBe(true);
      const into = await page.request.post(`${BASE}/api/v1/proxy-hosts`, {
        headers: HEADERS,
        data: { name: 'E2E tenancy host 2', domains: ['tenancy-e2e-2.example.com'], upstreams: ['localhost:9997'], organizationId: 1 },
      });
      expect(into.status()).toBe(400);
      expect((await into.json()).error).toMatch(/Unknown organisation/);
    } finally {
      await page.request.delete(`${BASE}/api/v1/proxy-hosts/${host.id}`, { headers: { Origin: BASE } }).catch(() => undefined);
    }
  });
});
