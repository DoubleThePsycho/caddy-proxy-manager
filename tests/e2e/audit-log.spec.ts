import { test, expect } from '@playwright/test';
import { createProxyHost } from '../helpers/proxy-api';

test.describe('Audit Log', () => {
  test('audit log page loads without redirecting to login', async ({ page }) => {
    await page.goto('/audit-log');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  });

  test('audit log page lists events in a table', async ({ page }) => {
    await page.goto('/audit-log');
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Summary' })).toBeVisible();
  });

  test('creating a proxy host creates audit log entry', async ({ page }) => {
    // Create a proxy host in the host editor
    await createProxyHost(page, { name: 'Audit Test Host', domain: 'audit-test.local', upstream: 'localhost:8888' });

    // The audit log finds it by its entity type and text.
    await page.goto('/audit-log?entityType=proxy_host&q=Audit%20Test%20Host');
    await expect(page.getByRole('table').getByText('Created proxy host Audit Test Host').first()).toBeVisible();
  });

  test('audit log page has search functionality held in the URL', async ({ page }) => {
    await page.goto('/audit-log');
    const search = page.getByRole('searchbox', { name: 'Search the audit log' });
    await expect(search).toBeVisible();
    await search.fill('no-such-event-text-e2e');
    await expect(page).toHaveURL(/[?&]q=no-such-event-text-e2e/);
    await expect(page.getByText('No events match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page).not.toHaveURL(/q=/);
  });

  test('filters by actor, action, entity and time range', async ({ page }) => {
    await page.goto('/audit-log');
    await expect(page.getByRole('combobox', { name: /Actor/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Action/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Entity/ })).toBeVisible();
    const range = page.getByRole('group', { name: 'Time range' });
    await range.getByRole('button', { name: '7d' }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(range.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('expanding an event shows its hash', async ({ page }) => {
    await page.goto('/audit-log');
    // The button's name turns into "Hide …" once open, so find it again by its event.
    const toggle = page.getByRole('button', { name: /^(Show diff|Details), event \d+$/ }).first();
    const id = (await toggle.getAttribute('aria-label'))?.match(/event (\d+)$/)?.[1];
    expect(id).toBeTruthy();
    await toggle.click();
    await expect(page.getByRole('button', { name: new RegExp(`^Hide (diff|details), event ${id}$`) })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('table').getByText('Hash', { exact: true })).toBeVisible();
  });

  test('offers verifying the hash chain and exporting', async ({ page }) => {
    await page.goto('/audit-log');
    await expect(page.getByRole('button', { name: 'Verify now' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Export CSV or JSON' })).toBeEnabled();
  });

  test('links to streaming and retention', async ({ page }) => {
    await page.goto('/audit-log');
    await page.getByRole('link', { name: 'Streaming and retention' }).click();
    await expect(page).toHaveURL(/\/audit-log\/streaming/);
    await expect(page.getByRole('heading', { name: 'Audit streaming', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Retention' })).toBeVisible();
  });
});
