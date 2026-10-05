/**
 * E2E tests: the anonymous usage ping (src/lib/usage-ping), asked once and
 * off until someone says yes.
 *
 * The question on the overview page, the Settings section with its payload
 * preview, and the REST API. Nothing is sent during a run: the question is
 * answered with no, and when the API turns it on the first ping is no sooner
 * than a minute away, and it is turned off again straight away.
 */
import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:3000';
const API = '/api/v1/usage-ping';
const JSON_HEADERS = { 'Content-Type': 'application/json', Origin: ORIGIN };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.describe.serial('Usage ping', () => {
  test('is off until answered, and the overview asks until an administrator answers', async ({ page }) => {
    const status = await (await page.request.get(API)).json();
    test.skip(status.answered, 'An administrator already answered on this stack');
    expect(status).toMatchObject({ enabled: false, status: 'unanswered', installId: null, nextAttemptAt: null });

    await page.goto('/');
    const question = page.getByTestId('usage-ping-question');
    await expect(question).toBeVisible();
    await expect(question).toContainText('Share anonymous usage statistics?');
    // Both answers alike: neither is the primary button.
    const yes = question.getByRole('button', { name: 'Yes, share' });
    const no = question.getByRole('button', { name: "No, don't share" });
    expect(await yes.getAttribute('class')).toBe(await no.getAttribute('class'));
    expect((await (await page.request.get(API)).json()).lastAttemptAt).toBeNull();

    await question.getByRole('button', { name: 'See exactly what is sent' }).click();
    await expect(question.locator('pre')).toContainText('"install_id"');
    await expect(question.locator('pre')).not.toContainText('example.com');

    await no.click();
    await expect(question).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'The usage ping stays off' })).toBeVisible();
    await page.reload();
    // The overview, or its first-run layout on a fresh install.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('usage-ping-question')).toHaveCount(0);

    const after = await (await page.request.get(API)).json();
    expect(after).toMatchObject({ enabled: false, answered: true, installId: null });
  });

  test('Settings shows the status and exactly what would be sent', async ({ page }) => {
    await page.goto('/settings#usage-ping');
    const section = page.getByTestId('usage-ping-section');
    await expect(section).toBeVisible();
    await expect(section.getByText('Off', { exact: true })).toBeVisible();
    await expect(section.getByRole('switch')).not.toBeChecked();
    const payload = page.getByTestId('usage-ping-payload');
    await expect(payload).toContainText('"schema": 1');
    await expect(payload).toContainText('"edition": "community"');
    await expect(payload).toContainText('created when the ping is turned on');
  });

  test('the API turns it on with a random id and off again', async ({ page }) => {
    const bad = await page.request.put(API, { headers: JSON_HEADERS, data: { enabled: 'yes' } });
    expect(bad.status()).toBe(400);

    const on = await page.request.put(API, { headers: JSON_HEADERS, data: { enabled: true } });
    try {
      expect(on.status()).toBe(200);
      const view = await on.json();
      expect(view.installId).toMatch(UUID_V4);
      expect(view.payload.install_id).toBe(view.installId);
      expect(view.status).toBe('on');
      const firstPing = Date.parse(view.nextAttemptAt) - Date.now();
      expect(firstPing).toBeGreaterThan(30_000);
    } finally {
      const off = await page.request.put(API, { headers: JSON_HEADERS, data: { enabled: false } });
      expect(off.status()).toBe(200);
      expect((await off.json()).installId).toBeNull();
    }

    const reset = await page.request.post(`${API}/reset-install-id`, { headers: JSON_HEADERS });
    expect(reset.status()).toBe(409);
  });
});
