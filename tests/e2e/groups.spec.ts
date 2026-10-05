/**
 * E2E tests: the Groups tab of Users and groups (/groups).
 *
 * Verifies group creation, member management, and deletion.
 * Runs as admin (testadmin).
 */
import { test, expect, type Page } from '@playwright/test';

const GROUP = 'e2e-test-group';

async function groupMenu(page: Page, name: string) {
  await page.getByRole('button', { name: `More actions for group ${name}` }).click();
}

test.describe('Groups tab', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('/groups');
  });

  test('/groups opens Users and groups on the Groups tab', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: 'Users and groups' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Groups/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'Groups' })).toBeVisible();
  });

  test('New group opens the create dialog and Cancel closes it', async ({ page }) => {
    await page.getByRole('button', { name: /new group/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Name')).toBeVisible();
    await expect(dialog.getByLabel('Description')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('create a new group', async ({ page }) => {
    await page.getByRole('button', { name: /new group/i }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(GROUP);
    await dialog.getByLabel('Description').fill('Created by E2E test');
    await dialog.getByRole('button', { name: 'Create' }).click();

    const row = page.getByRole('row').filter({ hasText: GROUP });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Created by E2E test')).toBeVisible();
    await expect(row.getByText('0 members')).toBeVisible();
    await expect(row.getByText('Local', { exact: true })).toBeVisible();
  });

  test('add a member to the group', async ({ page }) => {
    await groupMenu(page, GROUP);
    await page.getByRole('menuitem', { name: 'Manage members' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Add a user to this group')).toBeVisible();
    await dialog.getByRole('list', { name: 'Users to add' }).getByRole('button').first().click();
    await expect(dialog.getByRole('list', { name: 'Members' })).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('row').filter({ hasText: GROUP }).getByText('1 member')).toBeVisible({ timeout: 10_000 });
  });

  test('remove the member from the group', async ({ page }) => {
    await page.getByRole('button', { name: GROUP, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTitle('Remove member').first().click();
    await expect(dialog.getByText('No members yet.')).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('row').filter({ hasText: GROUP }).getByText('0 members')).toBeVisible({ timeout: 10_000 });
  });

  test('delete the group after confirming', async ({ page }) => {
    await groupMenu(page, GROUP);
    await page.getByRole('menuitem', { name: 'Delete group' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete group' }).click();
    await expect(page.getByRole('row').filter({ hasText: GROUP })).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe('Groups tab — unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access to /groups redirects to /login', async ({ page }) => {
    await page.goto('/groups');
    await expect(page).toHaveURL(/\/login/);
  });
});
