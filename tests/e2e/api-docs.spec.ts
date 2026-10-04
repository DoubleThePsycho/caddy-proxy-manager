/**
 * E2E tests: API Docs page (OpenAPI / Swagger UI).
 *
 * Verifies the page loads and Swagger UI renders the OpenAPI spec.
 * The page requires admin role.
 */
import { test, expect } from '@playwright/test';

test.describe('API Docs page', () => {
  test('page loads without error', async ({ page }) => {
    await page.goto('/api-docs');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'API tokens' })).toHaveAttribute('href', '/profile#api-tokens');
  });

  test('expands an operation without resolver errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/api-docs');
    const operation = page.locator('.opblock-summary').first();
    await expect(operation).toBeVisible({ timeout: 15_000 });
    await operation.click();
    await expect(page.locator('.opblock-body').first()).toBeVisible();
    // Turbopack drops ApiDOM's refractor registration; apidom-refractors.ts puts it back.
    await page.waitForTimeout(1_000);
    expect(errors.filter((text) => /refract is not a function/.test(text))).toEqual([]);
  });

  test('/api-tokens leads to the API tokens on the profile', async ({ page }) => {
    await page.goto('/api-tokens');
    await expect(page).toHaveURL(/\/profile#api-tokens$/);
    await expect(page.getByRole('heading', { name: /^API tokens/ })).toBeVisible();
  });

  test('bundled Swagger UI renders without loading executable CDN assets', async ({ page }) => {
    await page.goto('/api-docs');
    await expect(page.locator('.swagger-ui')).toBeVisible({ timeout: 10_000 });
    const thirdPartyScripts = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry instanceof PerformanceResourceTiming)
        .filter((entry) => entry.initiatorType === 'script')
        .map((entry) => entry.name)
        .filter((url) => new URL(url).origin !== window.location.origin)
    );
    expect(thirdPartyScripts).toEqual([]);
  });

  test('OpenAPI spec endpoint returns valid JSON', async ({ request }) => {
    const response = await request.get('/api/v1/openapi.json');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('openapi');
    expect(body).toHaveProperty('paths');
  });
});

test.describe('API Docs page — unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access to /api-docs redirects to /login', async ({ page }) => {
    await page.goto('/api-docs');
    await expect(page).toHaveURL(/\/login/);
  });
});
