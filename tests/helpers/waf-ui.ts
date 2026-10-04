/**
 * Drives the WAF settings page (/waf) in Playwright specs.
 */
import { expect, type Page } from '@playwright/test';

/** Turns the global WAF on for every host, in blocking mode with the OWASP Core Rule Set, and saves when anything changed. */
export async function enableGlobalWafWithCrs(page: Page): Promise<void> {
  await page.goto('/waf');
  await expect(page.getByRole('heading', { level: 1, name: 'WAF settings' })).toBeVisible();

  const applyToAll = page.getByRole('switch', { name: /^Apply to all \d+ hosts$/ });
  if ((await applyToAll.getAttribute('data-state')) !== 'checked') await applyToAll.click();
  const crs = page.getByRole('switch', { name: 'Load the Core Rule Set' });
  if ((await crs.getAttribute('data-state')) !== 'checked') await crs.click();
  await page.getByRole('radiogroup', { name: 'Global mode' }).getByRole('radio', { name: /^Blocking/ }).click();

  const save = page.getByRole('button', { name: 'Save and apply' }).first();
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText('WAF settings saved and applied.')).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByText(/^Not applied yet/)).toHaveCount(0);
}
