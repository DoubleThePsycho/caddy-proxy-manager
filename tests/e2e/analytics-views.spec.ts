/**
 * Saved views on the analytics page: save the current settings under a
 * name, open the view again from the Views menu, rename it, share it and
 * delete it, all through /api/v1/analytics/views.
 */
import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:3000';
const VIEWS = `${ORIGIN}/api/v1/analytics/views`;

test.describe('Analytics saved views', () => {
  test('saves, opens, renames, shares and deletes a view', async ({ page }) => {
    const stamp = Date.now();
    const name = `E2E view ${stamp}`;
    const renamed = `E2E errors ${stamp}`;

    try {
      await page.goto('/analytics?range=7d&metric=errors');
      await expect(page.getByRole('heading', { level: 2, name: 'Error responses by status class' })).toBeVisible();

      await page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Save view' }).click();
      const dialog = page.getByRole('dialog', { name: 'Save view' });
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByRole('button', { name: 'Save view' }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page).toHaveURL(/[?&]view=\d+/);
      const viewsButton = page.getByRole('button', { name: name });
      await expect(viewsButton).toBeVisible();

      // Changing a setting leaves the view.
      await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '24h' }).click();
      await expect(page).not.toHaveURL(/view=/);
      await expect(page.getByRole('button', { name: 'Views', exact: true })).toBeVisible();

      // Opening it brings its settings back.
      await page.getByRole('button', { name: 'Views', exact: true }).click();
      await page.getByRole('menuitem', { name: new RegExp(name) }).click();
      await expect(page).toHaveURL(/range=7d&metric=errors&view=\d+/);
      await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');

      // Manage: rename, share, delete.
      await page.getByRole('button', { name: name }).click();
      await page.getByRole('menuitem', { name: 'Manage views…' }).click();
      const manage = page.getByRole('dialog', { name: 'Saved views' });
      await manage.getByRole('button', { name: `Rename ${name}` }).click();
      await manage.getByLabel(`New name for ${name}`).fill(renamed);
      await manage.getByRole('button', { name: 'Rename', exact: true }).click();
      await expect(manage.getByRole('button', { name: renamed, exact: true })).toBeVisible();

      const share = manage.getByRole('switch', { name: `Share ${renamed} with other users` });
      await share.click();
      await expect(share).toHaveAttribute('aria-checked', 'true');
      const listed = await (await page.request.get(VIEWS)).json();
      expect(listed.find((view: { name: string }) => view.name === renamed)).toMatchObject({ shared: true, metric: 'errors', range: { preset: '7d' } });

      await manage.getByRole('button', { name: `Delete ${renamed}` }).click();
      await manage.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(manage.getByRole('button', { name: renamed, exact: true })).not.toBeVisible();
      const after = await (await page.request.get(VIEWS)).json();
      expect(after.some((view: { name: string }) => view.name === renamed)).toBe(false);
    } finally {
      const views = await (await page.request.get(VIEWS)).json().catch(() => []);
      for (const view of Array.isArray(views) ? views : []) {
        if (String(view.name).includes(String(stamp))) {
          await page.request.delete(`${VIEWS}/${view.id}`, { headers: { Origin: ORIGIN } }).catch(() => {
            /* best-effort cleanup */
          });
        }
      }
    }
  });
});
