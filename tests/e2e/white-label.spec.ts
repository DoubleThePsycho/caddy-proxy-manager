/**
 * E2E tests: White-label branding (ee/white-label).
 *
 * The page and the API for administrators, changes and reset (every test
 * that changes the branding resets it, so later specs see the defaults),
 * the public image route, and the default branding everywhere.
 */
import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:3000';
const API = '/api/v1/branding';
const JSON_HEADERS = { 'Content-Type': 'application/json', Origin: ORIGIN };
/** A valid 1×1 PNG. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test.describe('Branding page', () => {
  test('shows the default branding, editable by administrators', async ({ page }) => {
    await page.goto('/branding');
    await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
    await expect(page.getByLabel('Product name')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
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

test.describe('Branding API', () => {
  test('reads the branding', async ({ page }) => {
    const response = await page.request.get(API);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ defaultProductName: 'Ingressi' });
  });

  test('changes the branding, uploads and removes a logo, and resets', async ({ page }) => {
    try {
      const put = await page.request.put(API, { headers: JSON_HEADERS, data: { productName: 'Example Edge' } });
      expect(put.status()).toBe(200);
      expect(await put.json()).toMatchObject({ source: 'local', effective: { productName: 'Example Edge' } });

      const svg = await page.request.put(`${API}/assets/logo-light`, {
        headers: { Origin: ORIGIN },
        multipart: { file: { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') } },
      });
      expect(svg.status()).toBe(400);

      const png = await page.request.put(`${API}/assets/logo-light`, {
        headers: { Origin: ORIGIN },
        multipart: { file: { name: 'logo.png', mimeType: 'image/png', buffer: PNG_1X1 } },
      });
      expect(png.status()).toBe(200);
      expect((await png.json()).assets.logoLight).toMatchObject({ type: 'image/png', width: 1, height: 1 });

      const removed = await page.request.delete(`${API}/assets/logo-light`, { headers: { Origin: ORIGIN } });
      expect(removed.status()).toBe(200);
      expect((await removed.json()).assets.logoLight).toBeNull();
    } finally {
      const reset = await page.request.delete(API, { headers: { Origin: ORIGIN } });
      expect(reset.status()).toBe(200);
      expect(await reset.json()).toMatchObject({ source: 'default', effective: { productName: 'Ingressi' } });
    }
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
