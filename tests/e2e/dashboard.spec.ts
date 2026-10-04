/**
 * E2E tests: the overview (/).
 *
 * The set-up overview, with the setup checklist hidden for these tests and
 * put back as it was afterwards: the header with the date, the range control
 * and the primary action, what needs attention, the traffic figures (or why
 * there are none), the busiest hosts, the nodes and recent changes. Then the
 * first-run layout, while the checklist is neither complete nor hidden.
 * Works with and without ClickHouse (playwright.no-clickhouse.config.ts).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

const ORIGIN = 'http://localhost:3000';
const JSON_HEADERS = { 'Content-Type': 'application/json', Origin: ORIGIN };

type Checklist = { complete: boolean; dismissed: boolean; steps: { key: string; done: boolean; doneBy: string | null }[] };

async function readChecklist(request: APIRequestContext): Promise<Checklist> {
  const response = await request.get('/api/v1/setup-checklist');
  expect(response.status()).toBe(200);
  return response.json();
}

async function setDismissed(request: APIRequestContext, dismissed: boolean): Promise<Checklist> {
  const response = await request.put('/api/v1/setup-checklist', { headers: JSON_HEADERS, data: { dismissed } });
  expect(response.status()).toBe(200);
  return response.json();
}

async function analyticsStatus(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/analytics/query?range=24h');
  expect(response.status()).toBe(200);
  return (await response.json()).status;
}

test.describe.serial('Overview', () => {
  let wasDismissed = false;

  test.beforeAll(async ({ request }) => {
    wasDismissed = (await readChecklist(request)).dismissed;
    await setDismissed(request, true);
  });

  test.afterAll(async ({ request }) => {
    await setDismissed(request, wasDismissed);
  });

  test('shows the date, the range control and the primary action', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByTestId('overview-date')).toContainText(/ · \d{2}:\d{2} /);
    const range = page.getByRole('group', { name: 'Time range' });
    for (const label of ['1h', '24h', '7d']) await expect(range.getByRole('button', { name: label })).toBeVisible();
    await expect(range.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');
    // The header's primary action; a fresh install's setup checklist offers the same link.
    const create = page.getByRole('main').getByRole('link', { name: 'New proxy host' });
    await expect(create.first()).toHaveAttribute('href', '/proxy-hosts?create=1');
    for (const link of await create.all()) await expect(link).toHaveAttribute('href', '/proxy-hosts?create=1');
  });

  test('switches the range through the address', async ({ page, request }) => {
    const status = await analyticsStatus(request);
    await page.goto('/');
    await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7d' }).click();
    await expect(page).toHaveURL(/\/\?range=7d$/);
    await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    if (status === 'ok') await expect(page.getByRole('heading', { name: 'Traffic, last 7 days' })).toBeVisible();
    await page.goto('/?range=1h');
    await expect(page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('lists what needs attention, as the attention API does', async ({ page, request }) => {
    const view = await (await request.get('/api/v1/overview/attention')).json();
    await page.goto('/');
    const section = page.getByRole('region', { name: 'Needs attention' });
    await expect(section).toBeVisible();
    if (view.items.length === 0) {
      await expect(section.getByText('Nothing needs attention right now')).toBeVisible();
    } else {
      // The page collects the list again, so an item may come or go in between; the first one is there.
      await expect(section.getByTestId('attention-list').getByRole('listitem').first()).toBeVisible();
      await expect(section.getByText(view.items[0].title, { exact: false }).first()).toBeVisible();
    }
  });

  test('shows the traffic figures, or explains why there are none', async ({ page, request }) => {
    const status = await analyticsStatus(request);
    await page.goto('/');
    if (status === 'disabled') {
      await expect(page.getByText('Analytics are off', { exact: true })).toBeVisible();
      await expect(page.getByTestId('overview-kpis')).toHaveCount(0);
      return;
    }
    test.skip(status !== 'ok', 'ClickHouse did not answer on this stack');
    const kpis = page.getByTestId('overview-kpis');
    for (const label of ['Requests', 'Mitigated', '5xx error rate', 'Bandwidth']) await expect(kpis.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Traffic, last 24 hours' })).toBeVisible();
    await kpis.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/analytics\?range=24h/);
  });

  test('lists the busiest hosts and leads to all of them', async ({ page }) => {
    await page.goto('/');
    const section = page.getByRole('region', { name: 'Busiest hosts' });
    await expect(section).toBeVisible();
    if (await section.getByText('No proxy hosts yet').count()) {
      await expect(section.getByRole('link', { name: 'New proxy host' })).toHaveAttribute('href', '/proxy-hosts?create=1');
      return;
    }
    await expect(section.getByRole('columnheader', { name: 'Requests' })).toBeVisible();
    await section.getByRole('link', { name: /^All \d+ hosts?$/ }).click();
    await expect(page).toHaveURL(/\/proxy-hosts$/);
  });

  test('shows this server and the latest changes', async ({ page }) => {
    await page.goto('/');
    const nodes = page.getByRole('region', { name: 'Nodes' });
    await expect(nodes.getByText('This server')).toBeVisible();
    const changes = page.getByRole('region', { name: 'Recent changes' });
    await expect(changes.getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/audit-log');
    await expect(changes.getByTestId('recent-changes').or(changes.getByText('No changes recorded yet'))).toBeVisible();
  });

  test('a fresh install shows the setup checklist until it is hidden', async ({ page, request }) => {
    const state = await setDismissed(request, false);
    test.skip(state.complete, 'Every setup step is done on this stack');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: /^Welcome, / })).toBeVisible();
    const setup = page.getByRole('region', { name: 'Set up this install' });
    await expect(setup).toBeVisible();
    await expect(setup.getByRole('progressbar', { name: 'Setup steps done' })).toBeVisible();

    // Marking a step done and taking it back. Skipped when that step is the
    // last one not done: finishing setup swaps in the normal overview.
    const domain = state.steps.find((step) => step.key === 'domain');
    const othersDone = state.steps.every((step) => step.key === 'domain' || step.done);
    if (domain && domain.doneBy !== 'data' && !othersDone) {
      const toggle = setup.getByRole('button', { name: /: Point a domain at this server$/ });
      const before = (await toggle.getAttribute('aria-pressed')) ?? 'false';
      const after = before === 'true' ? 'false' : 'true';
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', after);
      expect((await readChecklist(request)).steps.find((step) => step.key === 'domain')?.doneBy).toBe(after === 'true' ? 'manual' : null);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', before);
    }

    await page.getByRole('button', { name: 'Hide the checklist' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    expect((await readChecklist(request)).dismissed).toBe(true);
  });
});
