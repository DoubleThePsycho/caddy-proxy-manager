import { test, expect } from '@playwright/test';

/**
 * Profile → Active sessions pages a long list: 61 sessions are signed in
 * through the REST sign-in endpoint, the list shows 25 a page with the page
 * in the address, and every session the test made is signed out afterwards.
 *
 * Sessions stand in for the paged lists that need a license (organisations)
 * or are capped (API tokens, at most 10 per account): the stack runs without
 * a license, and sessions page the same way.
 */

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const ADMIN = { username: 'testadmin', password: 'TestPassword2026!' };
const EXTRA_SESSIONS = 61;

type SessionRow = { id: number; current: boolean };

test.describe('Profile sessions paging', () => {
  test.setTimeout(180_000);

  test('pages 60+ sessions 25 at a time, the page in the address', async ({ page, playwright }) => {
    const before = new Set(((await (await page.request.get(`${API}/sessions`)).json()) as SessionRow[]).map((session) => session.id));
    const client = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
    let created: number[] = [];
    try {
      for (let index = 0; index < EXTRA_SESSIONS; index += 1) {
        const response = await client.post(`${BASE_URL}/api/auth/sign-in/username`, {
          headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
          data: ADMIN,
        });
        expect(response.status(), await response.text()).toBe(200);
      }
      const after = (await (await page.request.get(`${API}/sessions`)).json()) as SessionRow[];
      created = after.filter((session) => !before.has(session.id)).map((session) => session.id);
      expect(created.length).toBeGreaterThanOrEqual(EXTRA_SESSIONS);
      const total = after.length;
      const pages = Math.ceil(total / 25);

      await page.goto('/profile');
      const section = page.getByRole('region', { name: /^Active sessions/ });
      const pager = section.getByRole('navigation', { name: 'Pages of sessions' });
      await expect(pager).toContainText(`1–25 of ${total} sessions`);
      await expect(section.locator('tbody tr')).toHaveCount(25);
      // The session of this browser comes first.
      await expect(section.locator('tbody tr').first()).toContainText('This device');

      await pager.getByRole('link', { name: 'Next page' }).click();
      await expect(page).toHaveURL(/[?&]sessions=2(&|$)/);
      await expect(pager).toContainText(`26–50 of ${total} sessions`);
      await expect(section.locator('tbody tr')).toHaveCount(25);
      await expect(section.getByText('This device')).toHaveCount(0);

      // The last page holds the rest, and a reload keeps it.
      await page.goto(`/profile?sessions=${pages}`);
      await expect(pager).toContainText(`${(pages - 1) * 25 + 1}–${total} of ${total} sessions`);
      await expect(section.locator('tbody tr')).toHaveCount(total - (pages - 1) * 25);
      await expect(pager.getByRole('link', { name: 'Next page' })).toHaveCount(0);

      // A page past the last one shows the last one.
      await page.goto('/profile?sessions=999');
      await expect(pager).toContainText(`of ${total} sessions`);
      await expect(section.locator('tbody tr')).toHaveCount(total - (pages - 1) * 25);
    } finally {
      for (const id of created) {
        await page.request.delete(`${API}/sessions/${id}`, { headers: { Origin: BASE_URL } });
      }
      await client.dispose();
    }

    const left = (await (await page.request.get(`${API}/sessions`)).json()) as SessionRow[];
    expect(left.filter((session) => created.includes(session.id))).toEqual([]);
  });
});
