/**
 * E2E tests: the Access lists pages.
 *
 * Covers: the list of lists (what each one does, where it is used, search,
 * pages, create, delete), a list's page (rules in order and Everyone else,
 * validation, the plain-language summary and its warnings, basic-auth
 * users, the denied response, where it is used, unsaved changes, delete)
 * and the global Blocked sources tab (block, edit, unblock, search).
 *
 * Runs as admin (testadmin).
 */
import { test, expect, type Page } from '@playwright/test';

const API = 'http://localhost:3000/api/v1/access-lists';
const HEADERS = { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' };

type ListBody = {
  id: number;
  name: string;
  defaultAction: string;
  denyStatus: number;
  denyBody: string | null;
  rules: { id: number; action: string; kind: string; values: string[]; note: string | null; expiresAt: string | null }[];
  entries: { id: number; username: string }[];
};

async function apiCreateList(page: Page, name: string, data: Record<string, unknown> = {}): Promise<ListBody> {
  const res = await page.request.post(API, { headers: HEADERS, data: { name, ...data } });
  expect(res.ok(), `API create list "${name}" failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as ListBody;
}

async function apiGetList(page: Page, id: number): Promise<ListBody> {
  const res = await page.request.get(`${API}/${id}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ListBody;
}

async function apiDeleteList(page: Page, id: number) {
  await page.request.delete(`${API}/${id}`, { headers: { Origin: 'http://localhost:3000' } }).catch(() => undefined);
}

async function openList(page: Page, list: { id: number; name: string }) {
  await page.goto(`/access-lists/${list.id}`);
  await expect(page.getByRole('heading', { name: list.name, exact: true, level: 1 })).toBeVisible({ timeout: 10_000 });
}

function saveBar(page: Page) {
  return page.getByTestId('access-list-save-bar');
}

async function saveList(page: Page) {
  await saveBar(page).getByRole('button', { name: 'Save list' }).click();
  await expect(saveBar(page).getByText('No unsaved changes')).toBeVisible({ timeout: 10_000 });
}

test.describe('Access lists — list', () => {
  test('shows the tabs, the columns and what each list does', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Overview ${Date.now()}`, {
      defaultAction: 'deny',
      rules: [{ action: 'allow', kind: 'ip', values: ['203.0.113.0/26'] }],
      users: [{ username: 'alice', password: 'Alice-Passw0rd!' }],
    });
    try {
      await page.goto('/access-lists');
      await expect(page).not.toHaveURL(/login/);
      await expect(page.getByRole('heading', { name: /^Access lists/, level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New access list' })).toBeVisible();
      const tabs = page.getByRole('navigation', { name: 'Access list sections' });
      await expect(tabs.getByRole('link', { name: /^Lists/ })).toHaveAttribute('aria-current', 'page');
      await expect(tabs.getByRole('link', { name: /^Blocked sources/ })).toBeVisible();
      for (const column of ['Name', 'What it does', 'Used by']) {
        await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
      }
      await page.getByLabel('Search access lists').fill(list.name);
      const row = page.getByTestId('access-list-row').filter({ hasText: list.name }).first();
      await expect(row).toContainText('Allows only 203.0.113.0/26 · basic auth for 1 user');
      await expect(row).toContainText('Not used');
    } finally {
      await apiDeleteList(page, list.id);
    }
  });

  test('finds lists by name, rule value and host, and pages through them', async ({ page }) => {
    const stamp = Date.now();
    const created: ListBody[] = [];
    try {
      for (let i = 1; i <= 27; i++) {
        created.push(await apiCreateList(page, `E2E Page ${stamp} ${String(i).padStart(2, '0')}`));
      }
      const special = await apiCreateList(page, `E2E Find ${stamp}`, {
        rules: [{ action: 'deny', kind: 'ip', values: ['198.51.100.77'] }],
      });
      created.push(special);
      const hostRes = await page.request.post('http://localhost:3000/api/v1/proxy-hosts', {
        headers: HEADERS,
        data: { name: 'E2E Find Host', domains: [`find-${stamp}.example.com`], upstreams: ['localhost:9876'], accessListId: special.id },
      });
      expect(hostRes.ok()).toBeTruthy();
      const host = (await hostRes.json()) as { id: number };
      try {
        await page.goto('/access-lists');
        const search = page.getByLabel('Search access lists');

        await search.fill(`E2E Page ${stamp}`);
        await expect(page.getByTestId('access-list-row').filter({ visible: true })).toHaveCount(25);
        const pager = page.getByRole('navigation', { name: 'Pages of access lists' });
        await expect(pager).toContainText('1–25 of 27 lists');
        await pager.getByRole('link', { name: 'Next page' }).click();
        await expect(page).toHaveURL(/page=2/);
        await expect(page.getByTestId('access-list-row').filter({ visible: true })).toHaveCount(2);
        await expect(pager).toContainText('26–27 of 27 lists');

        // A new search starts again at the first page.
        await search.fill('198.51.100.77');
        await expect(page).not.toHaveURL(/page=2/);
        await expect(page.getByTestId('access-list-row').filter({ visible: true })).toHaveCount(1);
        await expect(page.getByTestId('access-list-row').filter({ visible: true })).toContainText(special.name);

        await search.fill(`find-${stamp}.example`);
        const row = page.getByTestId('access-list-row').filter({ visible: true });
        await expect(row).toHaveCount(1);
        await expect(row.getByRole('link', { name: `find-${stamp}.example.com` })).toHaveAttribute('href', `/proxy-hosts/${host.id}`);

        await search.fill(`nothing-${stamp}`);
        await expect(page.getByText('No access list matches this search')).toBeVisible();
        await page.getByRole('button', { name: 'Clear search' }).click();
        await expect(search).toHaveValue('');
      } finally {
        await page.request.delete(`http://localhost:3000/api/v1/proxy-hosts/${host.id}`, { headers: { Origin: 'http://localhost:3000' } });
      }
    } finally {
      for (const list of created) await apiDeleteList(page, list.id);
    }
  });

  test('deletes a list from its row after confirming', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Row Delete ${Date.now()}`);
    await page.goto('/access-lists');
    await page.getByLabel('Search access lists').fill(list.name);
    await page.getByRole('button', { name: `More actions for ${list.name}` }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Delete ${list.name}?`);
    await dialog.getByRole('button', { name: 'Delete list' }).click();
    await expect(page.getByText(`Deleted ${list.name}`)).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await page.request.get(`${API}/${list.id}`)).status()).toBe(404);
    await expect(page.getByTestId('access-list-row').filter({ hasText: list.name })).toHaveCount(0);
  });
});

test.describe('Access lists — create', () => {
  test('Create list stays disabled without a name', async ({ page }) => {
    await page.goto('/access-lists');
    await page.getByRole('button', { name: 'New access list' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /create list/i })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('creates an allowlist and opens its page', async ({ page }) => {
    const name = `E2E Create ${Date.now()}`;
    await page.goto('/access-lists');
    await page.getByRole('button', { name: 'New access list' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel(/^Description/).fill('Created from the dialog');
    await dialog.getByRole('radio', { name: /Allowlist/ }).check();
    await dialog.getByRole('button', { name: /create list/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    await expect(page).toHaveURL(/\/access-lists\/\d+$/);
    await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible({ timeout: 10_000 });
    // No rule lets anyone in yet: the page says so.
    await expect(page.getByTestId('access-list-summary')).toHaveText('Denies everyone');
    await expect(page.getByText('Every request is denied.')).toBeVisible();

    const id = Number(new URL(page.url()).pathname.split('/').pop());
    const created = await apiGetList(page, id);
    expect(created).toMatchObject({ name, defaultAction: 'deny' });
    await apiDeleteList(page, id);
  });
});

test.describe('Access lists — rules', () => {
  let list: ListBody;

  test.beforeEach(async ({ page }) => {
    list = await apiCreateList(page, `E2E Rules ${Date.now()}`, {
      rules: [
        { action: 'allow', kind: 'ip', values: ['203.0.113.0/26'], note: 'Office' },
        { action: 'deny', kind: 'ip', values: ['0.0.0.0/0', '::/0'], note: 'Everything else' },
      ],
    });
  });

  test.afterEach(async ({ page }) => {
    await apiDeleteList(page, list.id);
  });

  test('shows the rules in order, then everyone else', async ({ page }) => {
    await openList(page, list);
    const rows = page.getByTestId('access-list-rule');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Allow');
    await expect(rows.nth(0)).toContainText('203.0.113.0/26');
    await expect(rows.nth(1)).toContainText('Deny');
    await expect(page.getByTestId('access-list-everyone-else')).toContainText('Allow');
    await expect(page.getByTestId('access-list-summary')).toHaveText('Allows 203.0.113.0/26, then denies 0.0.0.0/0 and ::/0; allows everyone else');
    await expect(saveBar(page).getByText('No unsaved changes')).toBeVisible();
    await expect(saveBar(page).getByRole('button', { name: 'Save list' })).toBeDisabled();
  });

  test('adds a country rule, moves it first and saves the order', async ({ page }) => {
    await openList(page, list);
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Match by', { exact: true }).click();
    await page.getByRole('option', { name: 'Country' }).click();
    await page.getByLabel('Values', { exact: true }).fill('kp, ir');
    await expect(page.getByText('Iran')).toBeVisible();
    await page.getByRole('button', { name: /^Done editing/ }).click();
    await expect(saveBar(page).getByText('Unsaved changes')).toBeVisible();

    await page.getByRole('button', { name: /^Move up: Deny countries KP, IR/ }).click();
    await page.getByRole('button', { name: /^Move up: Deny countries KP, IR/ }).click();
    await saveList(page);

    const saved = await apiGetList(page, list.id);
    expect(saved.rules.map((rule) => [rule.action, rule.kind, rule.values.join(',')])).toEqual([
      ['deny', 'country', 'KP,IR'],
      ['allow', 'ip', '203.0.113.0/26'],
      ['deny', 'ip', '0.0.0.0/0,::/0'],
    ]);
    // The rules kept their ids.
    expect(saved.rules[1].id).toBe(list.rules[0].id);
  });

  test('explains a value that does not parse and does not save it', async ({ page }) => {
    await openList(page, list);
    await page.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Values', { exact: true }).fill('10.0.0.300');
    await expect(page.getByText('"10.0.0.300" is not an IP address or CIDR range')).toBeVisible();
    await saveBar(page).getByRole('button', { name: 'Save list' }).click();
    await expect(page.getByText(/Rule 3: "10.0.0.300" is not an IP address/)).toBeVisible();
    expect((await apiGetList(page, list.id)).rules).toHaveLength(2);
  });

  test('removes a rule, and Discard brings it back', async ({ page }) => {
    await openList(page, list);
    await page.getByRole('button', { name: /^Remove rule: Deny network/ }).click();
    await expect(page.getByTestId('access-list-rule')).toHaveCount(1);
    await saveBar(page).getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByTestId('access-list-rule')).toHaveCount(2);
    await expect(saveBar(page).getByText('No unsaved changes')).toBeVisible();
  });

  test('saves everyone else, the deny response and a new name', async ({ page }) => {
    await openList(page, list);
    await page.getByLabel('Everyone else').click();
    await page.getByRole('option', { name: 'Deny' }).click();
    await expect(page.getByTestId('access-list-summary')).toHaveText('Allows only 203.0.113.0/26');
    await page.getByLabel('Status', { exact: true }).fill('451');
    await page.getByLabel('Body', { exact: true }).fill('Not from here');
    const renamed = `${list.name} renamed`;
    await page.getByLabel('Name', { exact: true }).fill(renamed);
    await saveList(page);
    await expect(page.getByRole('heading', { name: renamed, exact: true, level: 1 })).toBeVisible();
    const saved = await apiGetList(page, list.id);
    expect(saved).toMatchObject({ name: renamed, defaultAction: 'deny', denyStatus: 451, denyBody: 'Not from here' });
  });

  test('warns when allow rules change nothing', async ({ page }) => {
    await openList(page, list);
    await page.getByRole('button', { name: /^Remove rule: Deny network/ }).click();
    await expect(page.getByText('The allow rules change nothing.')).toBeVisible();
    await expect(page.getByTestId('access-list-summary')).toHaveText('Lets everyone in');
  });
});

test.describe('Access lists — basic auth', () => {
  let list: ListBody;

  test.beforeEach(async ({ page }) => {
    list = await apiCreateList(page, `E2E Members ${Date.now()}`, {
      users: [{ username: 'alice', password: 'Alice-Passw0rd!' }],
    });
  });

  test.afterEach(async ({ page }) => {
    await apiDeleteList(page, list.id);
  });

  test('adds a user with a generated password and removes another', async ({ page }) => {
    await openList(page, list);
    await expect(page.getByTestId('access-list-member')).toHaveCount(1);
    await page.getByLabel('Username', { exact: true }).fill('bob');
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByLabel('Password', { exact: true })).not.toHaveValue('');
    await page.getByRole('button', { name: 'Add user' }).click();
    await expect(page.getByText('Not saved yet')).toBeVisible();
    await expect(page.getByText('Copy new passwords before you save: they are not shown again.')).toBeVisible();

    await page.getByRole('button', { name: 'Remove alice' }).click();
    await expect(page.getByText('Removed when you save')).toBeVisible();
    await saveList(page);

    const saved = await apiGetList(page, list.id);
    expect(saved.entries.map((entry) => entry.username)).toEqual(['bob']);
  });

  test('shows basic auth in the list', async ({ page }) => {
    await page.goto('/access-lists');
    await page.getByLabel('Search access lists').fill(list.name);
    const row = page.getByTestId('access-list-row').filter({ hasText: list.name }).first();
    await expect(row).toContainText('Basic auth for 1 user');
  });
});

test.describe('Access lists — where it is used', () => {
  test('lists the hosts using a list, with links', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Usage ${Date.now()}`);
    const hostRes = await page.request.post('http://localhost:3000/api/v1/proxy-hosts', {
      headers: HEADERS,
      data: { name: 'E2E Usage Host', domains: ['usage-test.example.com'], upstreams: ['localhost:9876'], accessListId: list.id },
    });
    expect(hostRes.ok()).toBeTruthy();
    const host = (await hostRes.json()) as { id: number };
    try {
      await openList(page, list);
      const usedBy = page.getByRole('region', { name: /^Used by/ });
      await expect(usedBy.getByRole('link', { name: 'usage-test.example.com' })).toHaveAttribute('href', `/proxy-hosts/${host.id}`);
      await page.goto('/access-lists');
      await page.getByLabel('Search access lists').fill(list.name);
      await expect(page.getByTestId('access-list-row').filter({ hasText: list.name }).first()).toContainText('usage-test.example.com');
    } finally {
      await page.request.delete(`http://localhost:3000/api/v1/proxy-hosts/${host.id}`, { headers: { Origin: 'http://localhost:3000' } });
      await apiDeleteList(page, list.id);
    }
  });

  test('shows when no host uses a list', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Unused ${Date.now()}`);
    try {
      await openList(page, list);
      await expect(page.getByText("No host uses this list. Choose it in a proxy host's Access settings.")).toBeVisible();
    } finally {
      await apiDeleteList(page, list.id);
    }
  });
});

test.describe('Access lists — delete', () => {
  test('deletes a list from its page after confirming', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Delete ${Date.now()}`);
    await openList(page, list);
    await page.getByRole('button', { name: 'Delete list' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Delete ${list.name}?`);
    await dialog.getByRole('button', { name: 'Delete list' }).click();
    await expect(page.getByText(`Deleted ${list.name}`)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/access-lists$/);
    await expect.poll(async () => (await page.request.get(`${API}/${list.id}`)).status()).toBe(404);
  });

  test('a missing list is not found', async ({ page }) => {
    const res = await page.goto('/access-lists/2147483000');
    expect(res?.status()).toBe(404);
  });
});

test.describe('Access lists — Blocked sources', () => {
  test.afterEach(async ({ page }) => {
    const entries = (await (await page.request.get(`${API}/blocked-sources/entries`)).json()) as { id: number }[];
    for (const entry of entries) {
      await page.request.delete(`${API}/blocked-sources/entries/${entry.id}`, { headers: { Origin: 'http://localhost:3000' } });
    }
  });

  test('blocks a source from the dialog, everywhere', async ({ page }) => {
    await page.goto('/access-lists');
    await page.getByRole('navigation', { name: 'Access list sections' }).getByRole('link', { name: /^Blocked sources/ }).click();
    await expect(page).toHaveURL(/\/access-lists\?tab=blocked-sources$/);
    await expect(page.getByText('Denied on every host before anything else', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'Block a source' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Values', { exact: true }).fill('198.51.100.19');
    await dialog.getByLabel(/^Reason/).fill('Scanner');
    await dialog.getByRole('button', { name: '24 hours' }).click();
    await dialog.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    const row = page.getByTestId('blocked-source-row').filter({ visible: true }).filter({ hasText: '198.51.100.19' });
    await expect(row).toContainText('Scanner');
    const entries = (await (await page.request.get(`${API}/blocked-sources/entries`)).json()) as { action: string; values: string[]; note: string; expiresAt: string | null }[];
    expect(entries).toEqual([expect.objectContaining({ action: 'deny', values: ['198.51.100.19'], note: 'Scanner' })]);
    expect(entries[0].expiresAt).not.toBeNull();
  });

  test('shows, finds, edits and unblocks a source blocked through the API', async ({ page }) => {
    for (const [address, reason] of [['203.0.113.140', 'Probed /.env.backup'], ['203.0.113.141', 'Scanner']]) {
      const res = await page.request.post(`${API}/blocked-sources/entries`, {
        headers: HEADERS,
        data: { address, reason, expiresInSeconds: 3600 },
      });
      expect(res.status()).toBe(201);
    }
    await page.goto('/access-lists?tab=blocked-sources');
    await expect(page.getByTestId('blocked-source-row').filter({ visible: true })).toHaveCount(2);

    await page.getByLabel('Search blocked sources').fill('env.backup');
    const row = page.getByTestId('blocked-source-row').filter({ visible: true });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('203.0.113.140');

    await row.getByRole('button', { name: 'More actions for 203.0.113.140' }).click();
    await page.getByRole('menuitem', { name: 'Edit reason or expiry' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Reason/).fill('Probing for secrets');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    await page.getByLabel('Search blocked sources').fill('');
    await expect(page.getByTestId('blocked-source-row').filter({ visible: true }).filter({ hasText: '203.0.113.140' })).toContainText('Probing for secrets');

    await page.getByRole('button', { name: 'More actions for 203.0.113.141' }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name: 'Unblock' }).click();
    await expect(page.getByText('Unblocked 203.0.113.141')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('blocked-source-row').filter({ visible: true })).toHaveCount(1);
    const entries = (await (await page.request.get(`${API}/blocked-sources/entries`)).json()) as { values: string[]; note: string }[];
    expect(entries).toEqual([expect.objectContaining({ values: ['203.0.113.140'], note: 'Probing for secrets' })]);
  });

  test('changes what a denied request gets', async ({ page }) => {
    await page.goto('/access-lists?tab=blocked-sources');
    await page.getByRole('button', { name: 'Change' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Status', { exact: true }).fill('429');
    await dialog.getByLabel('Body', { exact: true }).fill('Slow down');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('blocked-sources-response')).toContainText('429 · Slow down');
    try {
      const list = (await (await page.request.get(`${API}/blocked-sources`)).json()) as { denyStatus: number; denyBody: string };
      expect(list).toMatchObject({ denyStatus: 429, denyBody: 'Slow down' });
    } finally {
      await page.request.put(`${API}/blocked-sources`, { headers: HEADERS, data: { denyStatus: 403, denyBody: null } });
    }
  });
});

test.describe('Access lists — unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access redirects to /login', async ({ page }) => {
    for (const path of ['/access-lists', '/access-lists/1', '/access-lists?tab=blocked-sources']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });
});
