/**
 * Plain-language analytics questions (ee/ai/questions) on the E2E stack,
 * which runs without a license and without an AI provider: the Ask box is
 * shown read-only with the reason, the Compliance page opens the same box,
 * and the REST API refuses to ask or save while listing and the settings
 * stay readable. Asking itself needs a model and is covered by
 * tests/integration/ai-questions.test.ts with a fake provider.
 */
import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:3000';
// Session-authenticated changes need a same-origin Origin header (the API's CSRF check); page.request sends none.
const SAME_ORIGIN = { Origin: ORIGIN };

test.describe('Analytics questions', () => {
  test('shows the Ask box read-only without a license', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Traffic analytics', level: 1 })).toBeVisible();
    test.skip(await page.getByTestId('analytics-disabled').isVisible(), 'ClickHouse is not configured on this stack');
    const ask = page.getByRole('region', { name: 'Ask about your traffic' });
    await expect(ask).toBeVisible();
    await expect(ask.getByText('Read-only without a license.')).toBeVisible();
    await expect(ask.getByLabel('Your question')).toBeDisabled();
    await expect(ask.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  });

  test('opens the Ask box from Compliance', async ({ page }) => {
    await page.goto('/compliance');
    await page.getByRole('button', { name: 'Ask about traffic' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ask about traffic' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Your question')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await expect(dialog).not.toBeVisible();
  });

  test('REST API: asking and saving need the license, listing and settings do not', async ({ page }) => {
    const asked = await page.request.post(`${ORIGIN}/api/v1/analytics/questions`, { headers: SAME_ORIGIN, data: { question: 'Which countries were blocked most last week?' } });
    expect(asked.status()).toBe(403);
    expect((await asked.json()).error).toMatch(/AI analyst needs an active .* license/);

    const saved = await page.request.post(`${ORIGIN}/api/v1/analytics/questions/saved`, {
      headers: SAME_ORIGIN,
      data: { question: 'Blocked by country?', query: { metric: 'mitigated', breakdown: 'country', range: { preset: '7d' } } },
    });
    expect(saved.status()).toBe(403);

    const list = await page.request.get(`${ORIGIN}/api/v1/analytics/questions/saved`);
    expect(list.status()).toBe(200);
    expect(Array.isArray(await list.json())).toBe(true);

    const settings = await page.request.get(`${ORIGIN}/api/v1/ai/question-settings`);
    expect(settings.status()).toBe(200);
    expect(await settings.json()).toMatchObject({ shareRequestDetails: false });
    const enable = await page.request.put(`${ORIGIN}/api/v1/ai/question-settings`, { headers: SAME_ORIGIN, data: { shareRequestDetails: true } });
    expect(enable.status()).toBe(403);

    const invalid = await page.request.post(`${ORIGIN}/api/v1/analytics/questions`, { headers: SAME_ORIGIN, data: { question: 'ok?', sql: 'SELECT 1' } });
    expect(invalid.status()).toBe(400);
  });
});
