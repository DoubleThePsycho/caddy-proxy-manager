/**
 * E2E tests: White-label branding (ee/white-label).
 *
 * The test stack has no license that the production keys sign, so this
 * covers what works without one: the page read-only with its notice, the
 * license gate on changes, reset and removal never needing a license, the
 * public image route, and the default branding everywhere.
 */
import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:3000';
const API = '/api/v1/branding';
const JSON_HEADERS = { 'Content-Type': 'application/json', Origin: ORIGIN };

test.describe('Branding page', () => {
  test('shows the default branding read-only without a license', async ({ page }) => {
    await page.goto('/branding');
    await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
    await expect(page.getByText('Changing the branding needs an active Enterprise license')).toBeVisible();
    await expect(page.getByLabel('Product name')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(page.getByTestId('branding-preview-light')).toContainText('Ingressi');
    await expect(page.getByTestId('branding-preview-dark')).toContainText('Ingressi');
  });

  test('is in the sidebar for administrators, under Settings', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
    await expect(page).toHaveURL(/\/settings/);
    await page.getByRole('link', { name: 'Branding', exact: true }).first().click();
    await expect(page).toHaveURL(/\/branding/);
    await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
  });
});

test.describe('Branding API without a license', () => {
  test('reads the branding', async ({ page }) => {
    const response = await page.request.get(API);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ configurable: false, defaultProductName: 'Ingressi' });
  });

  test('refuses changes with 403 and allows resetting and removing', async ({ page }) => {
    const put = await page.request.put(API, { headers: JSON_HEADERS, data: { productName: 'Example Edge' } });
    expect(put.status()).toBe(403);
    expect((await put.json()).error).toMatch(/White-label needs an active Ingressi Enterprise license/);

    const upload = await page.request.put(`${API}/assets/logo-light`, {
      headers: { Origin: ORIGIN },
      multipart: { file: { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') } },
    });
    expect(upload.status()).toBe(403);

    // Restoring defaults never needs a license.
    expect((await page.request.put(API, { headers: JSON_HEADERS, data: { productName: null } })).status()).toBe(200);
    expect((await page.request.delete(`${API}/assets/logo-light`, { headers: { Origin: ORIGIN } })).status()).toBe(200);
    expect((await page.request.delete(API, { headers: { Origin: ORIGIN } })).status()).toBe(200);
  });

  test('the API docs title is the product name', async ({ page }) => {
    const spec = await (await page.request.get('/api/v1/openapi.json')).json();
    expect(spec.info.title).toBe('Ingressi API');
    expect(spec.paths).toHaveProperty('/api/v1/branding');
  });
});

test.describe('Branding images and sign-in pages — unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the image route is public and answers 404 with nosniff when nothing is set', async ({ request }) => {
    const response = await request.get(`${ORIGIN}/api/branding/logo-light`, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['location']).toBeUndefined();
  });

  test('the branding API itself needs a sign-in', async ({ request }) => {
    expect((await request.get(`${ORIGIN}${API}`)).status()).toBe(401);
  });

  test('the login page shows the default product name', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/Ingressi/);
    await expect(page.getByText('Ingressi', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('brand-footer')).toHaveCount(0);
  });
});
