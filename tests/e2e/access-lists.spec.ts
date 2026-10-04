/**
 * E2E tests: Access lists page (list table and editor panel).
 *
 * Covers: page structure, creating a list, selecting lists, ordered rules
 * (add, edit, move, remove, validation), the unmatched behaviour and the
 * deny response, members, the dirty/saved state, discarding, deleting,
 * where a list is used, and the global Blocked sources list.
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
  rules: { id: number; action: string; kind: string; values: string[] }[];
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

async function openList(page: Page, name: string) {
  await page.goto('/access-lists');
  await page.getByRole('button', { name, exact: true }).click();
  const editor = page.getByTestId('access-list-editor');
  await expect(editor.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 10_000 });
  return editor;
}

const SAVED = 'Saved · matches the running configuration';

test.describe('Access lists — page', () => {
  test('shows the heading, the summary, the table and the Blocked sources row', async ({ page }) => {
    await page.goto('/access-lists');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: /^Access lists/, level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New access list' })).toBeVisible();
    await expect(page.getByText('Stopped by access lists, last 24 hours')).toBeVisible();
    for (const column of ['List', 'Type', 'Rules', 'Used by', 'Stopped, 24 h']) {
      await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Blocked sources', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What was stopped, last 24 hours' })).toBeVisible();
  });
});

test.describe('Access lists — create', () => {
  test('Create list stays disabled without a name', async ({ page }) => {
    await page.goto('/access-lists');
    await page.getByRole('button', { name: 'New access list' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /create list/i })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('creates an allowlist and opens it in the editor', async ({ page }) => {
    const name = `E2E Create ${Date.now()}`;
    await page.goto('/access-lists');
    await page.getByRole('button', { name: 'New access list' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Description').fill('Created from the dialog');
    await dialog.getByLabel('When no rule matches').click();
    await page.getByRole('option', { name: /Deny the request/ }).click();
    await dialog.getByRole('button', { name: /create list/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    const editor = page.getByTestId('access-list-editor');
    await expect(editor.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();

    const lists = (await (await page.request.get(API)).json()) as ListBody[];
    const created = lists.find((list) => list.name === name)!;
    expect(created.defaultAction).toBe('deny');
    await apiDeleteList(page, created.id);
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

  test('shows the rules in order and is saved', async ({ page }) => {
    const editor = await openList(page, list.name);
    const rows = editor.getByTestId('access-list-rule');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Allow');
    await expect(rows.nth(0)).toContainText('203.0.113.0/26');
    await expect(rows.nth(1)).toContainText('Deny');
    await expect(editor.getByText(SAVED)).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Save list' })).toBeDisabled();
  });

  test('adds a country rule, moves it first and saves the order', async ({ page }) => {
    const editor = await openList(page, list.name);
    await editor.getByRole('button', { name: 'Add rule' }).click();
    await editor.getByLabel('Values', { exact: true }).fill('kp, ir');
    await expect(editor.getByText('Iran')).toBeVisible();
    await editor.getByRole('button', { name: /^Done editing/ }).click();
    await expect(editor.getByText('Unsaved changes')).toBeVisible();

    await editor.getByRole('button', { name: /^Move up: Deny countries KP, IR/ }).click();
    await editor.getByRole('button', { name: /^Move up: Deny countries KP, IR/ }).click();
    await editor.getByRole('button', { name: 'Save list' }).click();
    await expect(editor.getByText(SAVED)).toBeVisible({ timeout: 10_000 });

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
    const editor = await openList(page, list.name);
    await editor.getByRole('button', { name: 'Add rule' }).click();
    await editor.getByLabel('Match by', { exact: true }).click();
    await page.getByRole('option', { name: 'Address or network' }).click();
    await editor.getByLabel('Values', { exact: true }).fill('10.0.0.300');
    await expect(editor.getByText('"10.0.0.300" is not an IP address or CIDR range')).toBeVisible();
    await editor.getByRole('button', { name: 'Save list' }).click();
    await expect(page.getByText(/Rule 3: "10.0.0.300" is not an IP address/)).toBeVisible();
    expect((await apiGetList(page, list.id)).rules).toHaveLength(2);
  });

  test('removes a rule, and Discard brings it back', async ({ page }) => {
    const editor = await openList(page, list.name);
    await editor.getByRole('button', { name: /^Remove rule: Deny network/ }).click();
    await expect(editor.getByTestId('access-list-rule')).toHaveCount(1);
    await editor.getByRole('button', { name: 'Discard' }).click();
    await expect(editor.getByTestId('access-list-rule')).toHaveCount(2);
    await expect(editor.getByText(SAVED)).toBeVisible();
  });

  test('saves the unmatched behaviour and the deny response', async ({ page }) => {
    const editor = await openList(page, list.name);
    await editor.getByLabel('When no rule matches').click();
    await page.getByRole('option', { name: 'Deny the request' }).click();
    await editor.getByLabel('Status', { exact: true }).fill('451');
    await editor.getByLabel('Body', { exact: true }).fill('Not from here');
    await editor.getByRole('button', { name: 'Save list' }).click();
    await expect(editor.getByText(SAVED)).toBeVisible({ timeout: 10_000 });
    const saved = await apiGetList(page, list.id);
    expect(saved).toMatchObject({ defaultAction: 'deny', denyStatus: 451, denyBody: 'Not from here' });
  });
});

test.describe('Access lists — members', () => {
  let list: ListBody;

  test.beforeEach(async ({ page }) => {
    list = await apiCreateList(page, `E2E Members ${Date.now()}`, {
      users: [{ username: 'alice', password: 'Alice-Passw0rd!' }],
    });
  });

  test.afterEach(async ({ page }) => {
    await apiDeleteList(page, list.id);
  });

  test('adds a member with a generated password and removes another', async ({ page }) => {
    const editor = await openList(page, list.name);
    await expect(editor.getByTestId('access-list-member')).toHaveCount(1);
    await editor.getByLabel('Username', { exact: true }).fill('bob');
    await editor.getByRole('button', { name: 'Generate' }).click();
    await expect(editor.getByLabel('Password', { exact: true })).not.toHaveValue('');
    await editor.getByRole('button', { name: 'Add member' }).click();
    await expect(editor.getByText('Not saved yet')).toBeVisible();

    await editor.getByRole('button', { name: 'Remove alice' }).click();
    await expect(editor.getByText('Removed when you save')).toBeVisible();
    await editor.getByRole('button', { name: 'Save list' }).click();
    await expect(editor.getByText(SAVED)).toBeVisible({ timeout: 10_000 });

    const saved = await apiGetList(page, list.id);
    expect(saved.entries.map((entry) => entry.username)).toEqual(['bob']);
  });

  test('shows the type and the member count in the table', async ({ page }) => {
    await page.goto('/access-lists');
    const row = page.getByTestId('access-list-row').filter({ hasText: list.name });
    await expect(row).toContainText('Basic auth');
    await expect(row).toContainText('1 user');
  });
});

test.describe('Access lists — where it is used', () => {
  test('lists the hosts using a list', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Usage ${Date.now()}`);
    const hostRes = await page.request.post('http://localhost:3000/api/v1/proxy-hosts', {
      headers: HEADERS,
      data: { name: 'E2E Usage Host', domains: ['usage-test.example.com'], upstreams: ['localhost:9876'], accessListId: list.id },
    });
    expect(hostRes.ok()).toBeTruthy();
    const host = (await hostRes.json()) as { id: number };
    try {
      const editor = await openList(page, list.name);
      await expect(editor.getByRole('link', { name: 'usage-test.example.com' })).toBeVisible();
      await expect(page.getByTestId('access-list-row').filter({ hasText: list.name })).toContainText('1 host');
    } finally {
      await page.request.delete(`http://localhost:3000/api/v1/proxy-hosts/${host.id}`, { headers: { Origin: 'http://localhost:3000' } });
      await apiDeleteList(page, list.id);
    }
  });

  test('shows when no host uses a list', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Unused ${Date.now()}`);
    try {
      const editor = await openList(page, list.name);
      await expect(editor.getByText('No host uses this list yet.')).toBeVisible();
    } finally {
      await apiDeleteList(page, list.id);
    }
  });
});

test.describe('Access lists — delete', () => {
  test('deletes a list after confirming', async ({ page }) => {
    const list = await apiCreateList(page, `E2E Delete ${Date.now()}`);
    const editor = await openList(page, list.name);
    await editor.getByRole('button', { name: 'More actions for this list' }).click();
    await page.getByRole('menuitem', { name: 'Delete list' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Delete ${list.name}?`);
    await dialog.getByRole('button', { name: 'Delete list' }).click();
    await expect(page.getByText(`Deleted ${list.name}`)).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await page.request.get(`${API}/${list.id}`)).status()).toBe(404);
  });
});

test.describe('Access lists — Blocked sources', () => {
  test.afterEach(async ({ page }) => {
    const entries = (await (await page.request.get(`${API}/blocked-sources/entries`)).json()) as { id: number }[];
    for (const entry of entries) {
      await page.request.delete(`${API}/blocked-sources/entries/${entry.id}`, { headers: { Origin: 'http://localhost:3000' } });
    }
  });

  test('blocks an address from the editor, everywhere, with only deny rules', async ({ page }) => {
    const editor = await openList(page, 'Blocked sources');
    await expect(editor.getByLabel('When no rule matches')).toHaveCount(0);
    await expect(editor.getByRole('heading', { name: 'Members' })).toHaveCount(0);
    await expect(editor.getByText('Every host', { exact: true })).toBeVisible();

    await editor.getByRole('button', { name: 'Add rule' }).click();
    await editor.getByLabel('Values', { exact: true }).fill('198.51.100.19');
    await editor.getByLabel('Reason', { exact: true }).fill('Scanner');
    await editor.getByRole('button', { name: 'Save list' }).click();
    await expect(editor.getByText(SAVED)).toBeVisible({ timeout: 10_000 });

    const entries = (await (await page.request.get(`${API}/blocked-sources/entries`)).json()) as { action: string; values: string[]; note: string }[];
    expect(entries).toEqual([expect.objectContaining({ action: 'deny', values: ['198.51.100.19'], note: 'Scanner' })]);
  });

  test('shows an address blocked through the API', async ({ page }) => {
    const res = await page.request.post(`${API}/blocked-sources/entries`, {
      headers: HEADERS,
      data: { address: '203.0.113.140', reason: 'Probed /.env.backup', expiresInSeconds: 3600 },
    });
    expect(res.status()).toBe(201);
    const editor = await openList(page, 'Blocked sources');
    const row = editor.getByTestId('access-list-rule').filter({ hasText: '203.0.113.140' });
    await expect(row).toContainText('Probed /.env.backup');
    await expect(row).toContainText('Expires');
  });
});

test.describe('Access lists — unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access to /access-lists redirects to /login', async ({ page }) => {
    await page.goto('/access-lists');
    await expect(page).toHaveURL(/\/login/);
  });
});
