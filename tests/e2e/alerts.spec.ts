/**
 * Alerts page on the E2E stack, which runs without a license: the Community
 * notice, the tabs, the rule editor with its scope control (certificate
 * expiry rules are free; error rate rules need the license), and the AI
 * provider's model timeout.
 */
import { test, expect } from '@playwright/test';

test.describe('Alerts', () => {
  test('loads with the Community notice and the firing view', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
    await expect(page.getByText(/Community includes e-mail channels/)).toBeVisible();
    await expect(page.getByRole('tab', { name: /Firing/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Firing now', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Last 7 days', exact: true })).toBeVisible();
  });

  test('switches tabs and keeps the tab in the URL', async ({ page }) => {
    await page.goto('/alerts');
    await page.getByRole('tab', { name: /Rules/ }).click();
    await expect(page).toHaveURL(/tab=rules/);
    await expect(page.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible();

    await page.getByRole('tab', { name: /Channels/ }).click();
    await expect(page).toHaveURL(/tab=channels/);
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add channel' }).first()).toBeVisible();

    await page.goto('/alerts?tab=history');
    await expect(page.getByRole('heading', { name: 'Alert history' })).toBeVisible();
    await page.getByRole('link', { name: 'Firing alerts' }).click();
    await expect(page.getByRole('heading', { name: 'Firing now', exact: true })).toBeVisible();
  });

  test('New rule opens the editor with a scope control', async ({ page }) => {
    await page.goto('/alerts');
    await page.getByRole('button', { name: 'New rule' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'New rule' })).toBeVisible();

    // A certificate rule (free) can be limited to chosen hosts.
    const scope = dialog.getByRole('group', { name: 'Hosts the rule watches' });
    await expect(scope.getByRole('button', { name: 'All hosts' })).toHaveAttribute('aria-pressed', 'true');
    await scope.getByRole('button', { name: 'Chosen hosts' }).click();
    await expect(dialog.getByPlaceholder('Filter proxy hosts')).toBeVisible();
    await expect(dialog.getByLabel('Fire after the condition held for')).toBeVisible();

    // Error rate rules need the license on this stack.
    await dialog.getByRole('combobox', { name: 'Rule type' }).click();
    await expect(page.getByRole('option', { name: /Error rate \(license\)/ })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
  });

  test('the AI tab shows the model timeout, 60 seconds unless set', async ({ page }) => {
    await page.goto('/alerts?tab=ai');
    const timeout = page.getByLabel('Timeout (seconds)');
    await expect(timeout).toHaveValue('60');
    await expect(timeout).toHaveAttribute('min', '5');
    await expect(timeout).toHaveAttribute('max', '300');
    // Read-only without a license, like the rest of the provider form.
    await expect(timeout).toBeDisabled();

    const settings = await page.request.get('/api/v1/ai/settings');
    expect(settings.status()).toBe(200);
    expect(await settings.json()).toMatchObject({ timeoutSeconds: 60 });
  });
});
