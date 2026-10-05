/**
 * The proxy hosts list pages with the shared pager: 62 hosts created through
 * the REST API, 25 a page, the page kept in ?page= (so reload and back keep
 * it), clamped to the last page, and back on page 1 when the search changes.
 * The hosts are created disabled, so Caddy requests no certificates for
 * them, and removed again afterwards.
 */
import { test, expect, type Page } from '@playwright/test';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const PREFIX = 'pager-e2e';
const COUNT = 62;

const hostName = (n: number) => `${PREFIX}-${String(n).padStart(2, '0')}`;
const domainOf = (n: number) => `${hostName(n)}.example.com`;

async function deleteHosts(page: Page, origin: string, ids: number[]) {
  for (const id of ids) await page.request.delete(`${API_PROXY_HOSTS}/${id}`, { headers: { Origin: origin } });
}

/** Hosts a previous, interrupted run left behind. */
async function leftoverIds(page: Page): Promise<number[]> {
  const response = await page.request.get(API_PROXY_HOSTS);
  expect(response.ok()).toBeTruthy();
  const hosts = (await response.json()) as Array<{ id: number; name: string }>;
  return hosts.filter((host) => host.name.startsWith(`${PREFIX}-`)).map((host) => host.id);
}

test.describe('Proxy hosts pagination', () => {
  test('the list pages 62 hosts with the shared pager', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto('/proxy-hosts');
    const origin = new URL(page.url()).origin;
    await deleteHosts(page, origin, await leftoverIds(page));

    const ids: number[] = [];
    try {
      for (let n = 1; n <= COUNT; n++) {
        const response = await page.request.post(API_PROXY_HOSTS, {
          headers: { Origin: origin },
          data: { name: hostName(n), domains: [domainOf(n)], upstreams: [`localhost:${9100 + n}`], enabled: false },
        });
        expect(response.status(), `create ${hostName(n)}`).toBe(201);
        ids.push(((await response.json()) as { id: number }).id);
      }

      const pager = page.getByRole('navigation', { name: 'Pages of hosts' });
      const rows = page.locator('table tbody tr');

      // Page 1 of the matching hosts, sorted by name.
      await page.goto(`/proxy-hosts?search=${PREFIX}&sortBy=host&sortDir=asc`);
      await expect(pager).toContainText('1–25 of 62 hosts');
      await expect(rows).toHaveCount(25);
      await expect(page.getByRole('link', { name: domainOf(1), exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: domainOf(26), exact: true })).toHaveCount(0);
      await expect(pager.locator('[aria-label="Previous page"]')).toHaveAttribute('aria-disabled', 'true');

      // Next page: the page goes into the address, the other parameters stay.
      await pager.getByRole('link', { name: 'Next page' }).click();
      await expect(page).toHaveURL(/[?&]page=2(&|$)/);
      await expect(page).toHaveURL(/search=pager-e2e/);
      await expect(pager).toContainText('26–50 of 62 hosts');
      await expect(page.getByRole('link', { name: domainOf(26), exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: domainOf(1), exact: true })).toHaveCount(0);
      await expect(pager.getByRole('link', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');

      // A page number: the last page holds the remaining 12.
      await pager.getByRole('link', { name: 'Page 3' }).click();
      await expect(page).toHaveURL(/[?&]page=3(&|$)/);
      await expect(pager).toContainText('51–62 of 62 hosts');
      await expect(rows).toHaveCount(12);
      await expect(page.getByRole('link', { name: domainOf(62), exact: true })).toBeVisible();
      await expect(pager.locator('[aria-label="Next page"]')).toHaveAttribute('aria-disabled', 'true');

      // Back returns to the page before; a reload keeps the page.
      await page.goBack();
      await expect(page).toHaveURL(/[?&]page=2(&|$)/);
      await expect(pager).toContainText('26–50 of 62 hosts');
      await page.reload();
      await expect(pager).toContainText('26–50 of 62 hosts');

      // A page past the end shows the last one.
      await page.goto(`/proxy-hosts?search=${PREFIX}&sortBy=host&sortDir=asc&page=99`);
      await expect(pager).toContainText('51–62 of 62 hosts');

      // Changing the search goes back to page 1; nine hosts fit on one page, so no pager.
      await page.getByRole('searchbox', { name: 'Filter hosts' }).fill(`${PREFIX}-0`);
      await expect(page).toHaveURL(/search=pager-e2e-0(&|$)/);
      await expect(page).not.toHaveURL(/[?&]page=/);
      await expect(rows).toHaveCount(9);
      await expect(pager).toHaveCount(0);

      // The whole list pages too.
      await page.goto('/proxy-hosts');
      await expect(pager).toContainText(/1–25 of \d+ hosts/);
    } finally {
      await deleteHosts(page, origin, ids);
    }
  });
});
