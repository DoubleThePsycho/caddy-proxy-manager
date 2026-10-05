/**
 * E2E tests: the shared pager on the Users tab and the audit log.
 *
 * Creates 60 users through POST /api/v1/users (deleted again afterwards), then
 * pages the Users tab (25 to a page, newest first, the page in the URL, a
 * search starting again at page 1) and the audit log events their creation
 * recorded (50 to a page, the filters kept in each page link).
 * Runs as admin (testadmin).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const COUNT = 60;
const RUN = `pager-${Date.now().toString(36)}`;
const ids: number[] = [];

function email(index: number): string {
  return `${RUN}-${String(index).padStart(2, '0')}@example.com`;
}

async function createUsers(request: APIRequestContext) {
  for (let index = 1; index <= COUNT; index++) {
    const response = await request.post(`${BASE}/api/v1/users`, {
      headers: { Origin: BASE },
      data: { email: email(index), name: `Pager ${String(index).padStart(2, '0')}`, password: 'PagerPass2026!', role: 'viewer' },
    });
    expect(response.status(), await response.text()).toBe(201);
    ids.push((await response.json()).id);
  }
}

function userRows(page: Page) {
  return page.getByRole('region', { name: 'Users' }).getByRole('row');
}

test.describe('Paging users and audit events', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await createUsers(request);
  });

  test.afterAll(async ({ request }) => {
    test.setTimeout(180_000);
    for (const id of ids) {
      await request.delete(`${BASE}/api/v1/users/${id}`, { headers: { Origin: BASE } });
    }
  });

  test('the Users tab shows 25 users a page, newest first, with the page in the URL', async ({ page }) => {
    await page.goto('/users');
    const pager = page.getByRole('navigation', { name: 'Pages of users' });
    await expect(pager).toBeVisible();
    await expect(pager).toContainText(/1–25 of \d+ users/);
    // Header row and 25 users.
    await expect(userRows(page)).toHaveCount(26);
    // The newest account comes first.
    await expect(userRows(page).nth(1)).toContainText(email(COUNT));

    await pager.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/\/users\?page=2$/);
    await expect(pager).toContainText(/26–50 of \d+ users/);
    await expect(userRows(page)).toHaveCount(26);
    await expect(userRows(page).nth(1)).toContainText(email(COUNT - 25));

    // A reload keeps the page.
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Pages of users' }).getByRole('link', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
  });

  test('a search narrows every page and starts again at the first', async ({ page }) => {
    await page.goto('/users?page=2');
    await page.getByPlaceholder('Name, e-mail, role or source').fill(RUN);
    await expect(page).toHaveURL(/\/users$/);
    const pager = page.getByRole('navigation', { name: 'Pages of users' });
    await expect(pager).toContainText(`1–25 of ${COUNT} users`);

    await pager.getByRole('link', { name: 'Page 3' }).click();
    await expect(page).toHaveURL(/\/users\?page=3$/);
    await expect(pager).toContainText(`51–${COUNT} of ${COUNT} users`);
    await expect(userRows(page)).toHaveCount(COUNT - 50 + 1);
    await expect(userRows(page).last()).toContainText(email(1));
  });

  test('the pager fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/users');
    const pager = page.getByRole('navigation', { name: 'Pages of users' });
    await expect(pager.getByRole('link', { name: 'Next page' })).toBeVisible();
    // Only the current page number shows on a narrow screen.
    await expect(pager.getByRole('link', { name: 'Page 2' })).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the audit log pages the events 50 at a time and keeps the search in each page link', async ({ page }) => {
    await page.goto(`/audit-log?q=${RUN}`);
    const pager = page.getByRole('navigation', { name: 'Pages of events' });
    await expect(pager).toContainText(`1–50 of ${COUNT} events`);
    const events = page.getByRole('region', { name: 'Events' }).getByRole('row');
    await expect(events).toHaveCount(51);

    await pager.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(new RegExp(`/audit-log\\?q=${RUN}&page=2$`));
    await expect(pager).toContainText(`51–${COUNT} of ${COUNT} events`);
    await expect(events).toHaveCount(COUNT - 50 + 1);
    // The oldest of them, the first user created, is last.
    await expect(events.last()).toContainText(email(1));
  });
});
