/**
 * Filters on the analytics page: + and − on a top list row add a filter,
 * the filter bar adds one by hand, every filter lives in the URL (the back
 * button undoes it) and the lists follow them.
 *
 * Seeds traffic for two hosts straight into ClickHouse, all on one path
 * unique to the run, and opens the page filtered to that path so the hosts
 * list holds just the two.
 */
import { test, expect, type Page } from '@playwright/test';
import { createClient, type ClickHouseClient } from '@clickhouse/client';

// ClickHouse HTTP port is exposed to the host by tests/docker-compose.test.yml.
function makeClient(): ClickHouseClient {
  return createClient({
    url: 'http://localhost:8123',
    username: 'ingressi',
    password: 'test-clickhouse-password-2026',
    database: 'analytics',
  });
}

function chDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

const hostsPanel = (page: Page) => page.getByRole('region', { name: 'Hosts' });

test.describe('Analytics filters', () => {
  test('adds, removes and steps back through filters', async ({ page }) => {
    const tag = `filters-${Date.now()}`;
    const path = `/${tag}`;
    const hostA = `${tag}-a.example.com`;
    const hostB = `${tag}-b.example.com`;
    const ch = makeClient();
    const now = Math.floor(Date.now() / 1000);
    const row = (host: string, i: number) => ({
      ts: chDateTime(now - i),
      client_ip: '203.0.113.7',
      host,
      method: 'GET',
      uri: path,
      status: 200,
      proto: 'HTTP/2.0',
      bytes_sent: 100,
      user_agent: 'analytics-filters-e2e',
      is_blocked: 0,
    });

    try {
      await ch.insert({
        table: 'traffic_events',
        format: 'JSONEachRow',
        values: [row(hostA, 1), row(hostA, 2), row(hostA, 3), row(hostB, 4), row(hostB, 5)],
      });

      const start = `/analytics?range=1h&filter=${encodeURIComponent(`path:${path}`)}`;
      await page.goto(start);
      await expect(page.getByRole('button', { name: `Remove filter: Path is ${path}` })).toBeVisible();
      await expect(hostsPanel(page).getByText(hostA, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).toBeVisible();

      // + on a row: only that host is left.
      await hostsPanel(page).getByRole('button', { name: `Filter: Host is ${hostA}` }).click();
      await expect(page).toHaveURL(new RegExp(`filter=host%3A${hostA.replace(/\./g, '\\.')}`));
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostA}` })).toBeVisible();
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).not.toBeVisible({ timeout: 15_000 });

      // Back undoes it.
      await page.goBack();
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostA}` })).not.toBeVisible();
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).toBeVisible({ timeout: 15_000 });

      // − on a row excludes it; the chip removes it again.
      await hostsPanel(page).getByRole('button', { name: `Exclude: Host is ${hostB}` }).click();
      const chip = page.getByRole('button', { name: `Remove filter: Host is not ${hostB}` });
      await expect(chip).toBeVisible();
      await expect(hostsPanel(page).getByText(hostB, { exact: true })).not.toBeVisible({ timeout: 15_000 });
      await chip.click();
      await expect(chip).not.toBeVisible();
      await expect(page).not.toHaveURL(/filter=%21host/);

      // The filter bar adds one by hand, and refuses a value the API would.
      const bar = page.getByRole('group', { name: 'Filters' });
      await bar.getByRole('button', { name: 'Add filter' }).click();
      await page.getByRole('group', { name: 'Filter by' }).getByRole('button', { name: 'Country', exact: true }).click();
      await page.getByLabel('Country value').fill('Germany');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByText('Country must be a two-letter code, LAN or XX')).toBeVisible();

      await bar.getByRole('button', { name: 'Add filter' }).click();
      await page.getByRole('group', { name: 'Filter by' }).getByRole('button', { name: 'Host', exact: true }).click();
      await page.getByLabel('Host value').fill(hostB);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('button', { name: `Remove filter: Host is ${hostB}` })).toBeVisible();
      await expect(hostsPanel(page).getByText(hostA, { exact: true })).not.toBeVisible({ timeout: 15_000 });
    } finally {
      await ch
        .command({
          query: `ALTER TABLE traffic_events DELETE WHERE uri = {p:String} SETTINGS mutations_sync = 2`,
          query_params: { p: path },
        })
        .catch(() => {
          /* best-effort cleanup */
        });
      await ch.close();
    }
  });
});
