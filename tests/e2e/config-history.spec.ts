/**
 * Change history page (ee/config-history and ee/backups) on the E2E stack:
 * the page loads, the backups line leads to the Backups page (as
 * ?tab=backups does), the settings and export dialogs open, and the settings
 * are saved over the REST API. Versions, comparisons and rollbacks are
 * covered by tests/integration/config-history*.test.ts.
 */
import { test, expect } from '@playwright/test';

test.describe('Change history', () => {
  test('page loads with the recording strip; the backups line opens Backups', async ({ page }) => {
    await page.goto('/history');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'Change history', level: 1 })).toBeVisible();
    await expect(page.getByText(/Recording (on|off)/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Save a version now/ })).toBeEnabled();
    await expect(page.getByRole('tab', { name: /Backups/ })).toHaveCount(0);

    await page.getByRole('main').getByRole('link', { name: /No scheduled backups|^Backups to / }).click();
    await expect(page).toHaveURL(/\/backups$/);
    await expect(page.getByRole('heading', { name: 'Backup destinations' })).toBeVisible();
  });

  test('?tab=backups opens the Backups page', async ({ page }) => {
    await page.goto('/history?tab=backups');
    await expect(page).toHaveURL(/\/backups$/);
    await expect(page.getByRole('heading', { name: 'Recent backups' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Add destination/ })).toBeEnabled();
  });

  test('history settings and export dialogs open', async ({ page }) => {
    await page.goto('/history');
    await page.getByRole('button', { name: 'History settings' }).first().click();
    const settings = page.getByRole('dialog', { name: 'History settings' });
    await expect(settings).toBeVisible();
    await expect(settings.getByLabel('Versions to keep')).toBeVisible();
    await settings.getByRole('button', { name: 'Cancel' }).click();
    await expect(settings).not.toBeVisible();

    await page.getByRole('button', { name: /Export or import/ }).click();
    const transfer = page.getByRole('dialog', { name: 'Export or import the configuration' });
    await expect(transfer).toBeVisible();
    await expect(transfer.getByLabel('Repeat passphrase')).toBeVisible();
  });

  test('REST API: versions are readable and the settings can be saved', async ({ page }) => {
    const versions = await page.request.get('/api/v1/config-history/versions');
    expect(versions.status()).toBe(200);
    expect(await versions.json()).toMatchObject({ versions: expect.any(Array) });

    const current = await (await page.request.get('/api/v1/config-history/settings')).json();
    // Saved unchanged, so recording stays as the other specs expect it.
    const saved = await page.request.put('/api/v1/config-history/settings', {
      data: { enabled: current.enabled, retention: current.retention },
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toEqual(current);
  });

  test('is reachable from the navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Change history' }).first().click();
    await expect(page).toHaveURL(/\/history/);
  });
});
