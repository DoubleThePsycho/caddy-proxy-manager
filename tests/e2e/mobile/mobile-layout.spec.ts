import { test, expect } from '@playwright/test';
import { createProxyHost, openCreateHostDialog, openEditorSection } from '../../helpers/proxy-api';

// Force a mobile viewport even under the desktop Chromium project so these
// checks validate responsive behavior instead of self-skipping.
test.use({ viewport: { width: 393, height: 852 } });

test.describe('Mobile layout', () => {
  test('app bar is visible with hamburger and title', async ({ page }) => {
    await page.goto('/');
    // The top bar: the navigation button and the current section's name
    const appBar = page.getByRole('banner');
    await expect(appBar).toBeVisible();
    await expect(page.getByRole('button', { name: /open navigation/i })).toBeVisible();
    await expect(appBar.getByTestId('mobile-title')).toContainText('Overview');
  });

  test('bottom navigation has 44px targets and opens the drawer from More', async ({ page }) => {
    await page.goto('/');
    const bottom = page.getByRole('navigation', { name: 'Main', exact: true });
    await expect(bottom).toBeVisible();
    for (const name of ['Overview', 'Hosts', 'Analytics', 'Security']) {
      const box = await bottom.getByRole('link', { name, exact: true }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await bottom.getByRole('link', { name: 'Hosts', exact: true }).click();
    await expect(page).toHaveURL('/proxy-hosts');
    await bottom.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('dialog').getByRole('link', { name: 'Certificates', exact: true })).toBeVisible();
  });

  test('drawer opens and closes via hamburger', async ({ page }) => {
    await page.goto('/');
    const drawerDialog = page.locator('[role="dialog"]');
    // The drawer is closed initially
    await expect(drawerDialog.getByRole('link', { name: 'Proxy hosts', exact: true })).not.toBeVisible();
    // Open drawer
    await page.getByRole('button', { name: /open navigation/i }).click();
    await expect(drawerDialog.getByRole('link', { name: 'Proxy hosts', exact: true })).toBeVisible();
    // Close by pressing Escape
    await page.keyboard.press('Escape');
    await expect(drawerDialog.getByRole('link', { name: 'Proxy hosts', exact: true })).not.toBeVisible();
  });

  test('navigating from drawer closes it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /open navigation/i }).click();
    const drawerDialog = page.locator('[role="dialog"]');
    const drawerNavLink = drawerDialog.getByRole('link', { name: 'Proxy hosts', exact: true });
    await expect(drawerNavLink).toBeVisible();
    // Drawer links are touch-sized
    expect((await drawerNavLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Click a nav link inside the drawer
    await drawerNavLink.click();
    await expect(page).toHaveURL('/proxy-hosts');
    // Drawer should close after navigation — drawer links no longer visible
    await expect(drawerDialog.getByRole('link', { name: /access lists/i })).not.toBeVisible();
  });

  test('proxy hosts page shows card list, not a table', async ({ page }) => {
    await page.goto('/proxy-hosts');
    // On a phone the hosts list is a list of cards: no table is shown.
    await expect(page.locator('table')).not.toBeVisible();
  });

  test('page header action button appears below title on mobile', async ({ page }) => {
    await page.goto('/proxy-hosts');
    const title = page.getByRole('heading', { level: 1, name: /proxy hosts/i });
    // The header's link (an empty list shows a second one in its empty state).
    const button = page.getByRole('link', { name: /new proxy host/i }).first();
    await expect(title).toBeVisible();
    await expect(button).toBeVisible();
    // Button should be below the title — its Y coordinate should be greater
    const titleBox = await title.boundingBox();
    const buttonBox = await button.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height - 1);
  });

  test('host editor is usable at mobile width', async ({ page }) => {
    await openCreateHostDialog(page);
    // No horizontal page scroll, and the sections, fields and save bar are reachable.
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = page.viewportSize()?.width ?? 393;
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1); // +1 for rounding
    await expect(page.getByLabel('Add domains')).toBeVisible();
    const bar = page.getByTestId('host-editor-bar');
    await expect(bar).toBeVisible();
    const barBox = await bar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(barBox!.width).toBeLessThanOrEqual(viewportWidth + 1);
    await openEditorSection(page, 'Security');
    await expect(page.getByRole('heading', { name: 'Web application firewall' })).toBeVisible();
    expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(viewportWidth + 1);
  });

  test('card edit and delete actions reachable without scrolling', async ({ page }) => {
    // A host of this project's own, so the projects that run this spec never
    // create the same domain twice, removed again afterwards.
    const tag = test.info().project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const domain = `mobile-test-${tag}.local`;
    const id = await createProxyHost(page, { name: `Mobile Test Host ${tag}`, domain, upstream: 'localhost:9999' });
    try {
      // The mobileCard renderer uses a DropdownMenu (three-dot button) for actions.
      // Open the dropdown and verify Edit and Delete menu items are present.
      await page.goto(`/proxy-hosts?search=${domain}`);
      const moreButton = page.getByRole('button', { name: /more actions for/i }).first();
      await expect(moreButton).toBeVisible();
      await moreButton.click();
      await expect(page.getByRole('menuitem', { name: /edit/i })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /delete/i })).toBeVisible();
    } finally {
      const origin = new URL(page.url()).origin;
      await page.request.delete(`${origin}/api/v1/proxy-hosts/${id}`, { headers: { Origin: origin } });
    }
  });

  test('overview stacks at phone width without horizontal overflow', async ({ page }) => {
    await page.goto('/');
    // The date line leads the page; the title is in the top bar (Phone.dc.html).
    await expect(page.getByTestId('overview-date')).toBeVisible();
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual((page.viewportSize()?.width ?? 393) + 5);
    // Each item of Needs attention opens as one row.
    const rows = page.getByTestId('attention-list').getByRole('listitem');
    if (await rows.count()) {
      const box = await rows.first().getByRole('link').first().boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('analytics page loads without horizontal body overflow', async ({ page }) => {
    await page.goto('/analytics');
    // Wait for content to load
    await page.waitForLoadState('networkidle');
    // The document body should not be wider than the viewport
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = page.viewportSize()?.width ?? 393;
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 5); // 5px tolerance
  });
});
