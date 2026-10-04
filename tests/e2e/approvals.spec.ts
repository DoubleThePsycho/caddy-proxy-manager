/**
 * Change approvals (ee/approvals) in the test stack, which has no license:
 * the Approvals page loads read-only with the licensing notice, policies
 * cannot be created, and host changes are applied directly while no policy
 * exists. The approval flow itself (four-eyes, windows, emergency changes,
 * every bypass path) is covered by tests/integration/approvals-*.test.ts,
 * which can sign test licenses.
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
const HEADERS = { 'Content-Type': 'application/json', Origin: BASE };

test.describe('Approvals', () => {
  test('page loads with the licensing notice and no requests', async ({ page }) => {
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByText(/Creating and changing approval policies needs an Enterprise license/)).toBeVisible();
    await expect(page.getByText('No change is waiting for approval.')).toBeVisible();
    await expect(page.getByText('No policy on: every host change is applied directly')).toBeVisible();

    await page.getByRole('tab', { name: /Decided/ }).click();
    await expect(page.getByText('No decided change requests yet')).toBeVisible();

    await page.getByRole('tab', { name: /Policies/ }).click();
    await expect(page.getByText(/No policies yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: /New policy/ })).toBeDisabled();
  });

  test('Manage policies opens the policies tab', async ({ page }) => {
    await page.goto('/approvals');
    await page.getByRole('button', { name: 'Manage policies' }).click();
    await expect(page.getByRole('tab', { name: /Policies/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=policies/);
  });

  test('is reachable from the navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Approvals' }).first().click();
    await expect(page).toHaveURL(/\/approvals/);
  });

  test('REST API: reading works, creating a policy needs the license', async ({ page }) => {
    const policies = await page.request.get(`${BASE}/api/v1/approval-policies`);
    expect(policies.status()).toBe(200);
    expect(await policies.json()).toEqual([]);

    const requests = await page.request.get(`${BASE}/api/v1/change-requests?status=open`);
    expect(requests.status()).toBe(200);
    expect(await requests.json()).toMatchObject({ requests: [], total: 0 });

    const create = await page.request.post(`${BASE}/api/v1/approval-policies`, { headers: HEADERS, data: { name: 'E2E production' } });
    expect(create.status()).toBe(403);
    expect((await create.json()).error).toMatch(/needs an active .* Enterprise license/);
  });

  test('host changes are applied directly while no policy exists', async ({ page }) => {
    const created = await page.request.post(`${BASE}/api/v1/proxy-hosts`, {
      headers: HEADERS,
      data: { name: 'E2E approvals host', domains: ['approvals-e2e.example.com'], upstreams: ['localhost:9998'], tags: ['prod'] },
    });
    expect(created.status()).toBe(201);
    const host = await created.json();
    try {
      const updated = await page.request.put(`${BASE}/api/v1/proxy-hosts/${host.id}`, { headers: HEADERS, data: { name: 'E2E approvals host 2' } });
      expect(updated.status()).toBe(200);
    } finally {
      await page.request.delete(`${BASE}/api/v1/proxy-hosts/${host.id}`, { headers: { Origin: BASE } }).catch(() => undefined);
    }
  });
});
