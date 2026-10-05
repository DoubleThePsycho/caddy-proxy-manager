/**
 * E2E tests: Users management page.
 *
 * Verifies user listing, search, edit, disable/enable, delete, and create functionality.
 * Runs as admin (testadmin) — the page requires admin role.
 */
import { test, expect } from '@playwright/test';
import { webDb } from '../helpers/e2e-sql';

const BASE = 'http://localhost:3000';

type CreatedUserRecord = {
  email: string;
  provider: string | null;
  subject: string | null;
  username: string | null;
  displayUsername: string | null;
  accountProviderId: string | null;
  accountId: string | null;
  accountHasPassword: boolean;
  role: string;
};

function getCreatedUserRecord(email: string): CreatedUserRecord {
  const record = webDb<CreatedUserRecord | null>(`
    const user = await db.get(
      'SELECT id, email, provider, subject, username, "displayUsername", role FROM users WHERE email = ?',
      [${JSON.stringify(email)}]
    );
    if (user) {
      const account = await db.get(
        'SELECT "providerId", "accountId", password FROM accounts WHERE "userId" = ? AND "providerId" = ?',
        [user.id, "credential"]
      );
      emit({
        email: user.email,
        provider: user.provider,
        subject: user.subject,
        username: user.username,
        displayUsername: user.displayUsername,
        accountProviderId: account?.providerId ?? null,
        accountId: account?.accountId ?? null,
        accountHasPassword: !!account?.password,
        role: user.role,
      });
    }
  `);
  if (!record) throw new Error(`User not found: ${email}`);
  return record;
}

async function loginWithCredentials(
  browser: import('@playwright/test').Browser,
  username: string,
  password: string,
) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });

  return { context, page };
}

test.describe('Users page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/users');
  });

  /** Opens the row menu of the first user whose row contains `text`. */
  async function rowMenu(page: import('@playwright/test').Page, text: string) {
    const row = page.getByRole('row').filter({ hasText: text }).first();
    await row.getByRole('button', { name: /^More actions for / }).click();
  }

  test('page loads with the Users and groups heading and tabs', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: 'Users and groups' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Users/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /^Groups/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Roles/ })).toBeVisible();
  });

  test('displays at least one user (the admin)', async ({ page }) => {
    await expect(page.getByRole('region', { name: 'Users' }).getByRole('row').nth(1)).toBeVisible({ timeout: 5000 });
    for (const header of ['User', 'Role', 'Comes from', 'Second factor', 'Last sign-in', 'Status']) {
      await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
    }
  });

  test('search input filters users', async ({ page }) => {
    const search = page.getByPlaceholder('Name, e-mail, role or source');
    await search.fill('testadmin');
    // The header row and the one match.
    await expect(page.getByRole('region', { name: 'Users' }).getByRole('row')).toHaveCount(2, { timeout: 5000 });

    await search.fill('nonexistent-zzz');
    await expect(page.getByText('No user matches these filters.')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
  });

  test('filters by administrators', async ({ page }) => {
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Administrators/ }).click();
    await expect(page.getByRole('cell', { name: /Admin/ }).first()).toBeVisible();
  });

  test('admin user shows the Admin role', async ({ page }) => {
    await page.getByPlaceholder('Name, e-mail, role or source').fill('testadmin');
    await expect(page.getByRole('row').filter({ hasText: 'testadmin' }).getByText('Admin', { exact: true })).toBeVisible();
  });

  test('opening a user shows the panel with role, MFA and sessions', async ({ page }) => {
    await page.getByPlaceholder('Name, e-mail, role or source').fill('testadmin');
    await page.getByRole('row').filter({ hasText: 'testadmin' }).first().getByRole('button').first().click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByRole('heading', { name: 'Role' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Multi-factor authentication' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    // The signed-in administrator cannot change their own role.
    await expect(panel.getByText('You cannot change your own role.')).toBeVisible();
    await expect(panel.getByText('This session')).toBeVisible({ timeout: 10_000 });
  });

  test('Edit user opens the details form in the panel', async ({ page }) => {
    await rowMenu(page, '@');
    await page.getByRole('menuitem', { name: 'Edit user' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByPlaceholder('Display name')).toBeVisible();
    await expect(panel.getByPlaceholder('Email address')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByPlaceholder('Display name')).not.toBeVisible();
    await expect(panel.getByRole('button', { name: 'Edit details' })).toBeVisible();
  });

  test('row menu offers the account actions', async ({ page }) => {
    await rowMenu(page, '@');
    await expect(page.getByRole('menuitem', { name: 'Open details' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Edit user' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sign out everywhere' })).toBeVisible();
  });

  // ── Create user (UI) ──────────────────────────────────────────────────

  test('Add user button is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Add user' })).toBeVisible();
  });

  test('clicking Add user shows the create form', async ({ page }) => {
    await page.getByRole('button', { name: 'Add user' }).click();

    await expect(page.getByTestId('create-email')).toBeVisible();
    await expect(page.getByTestId('create-name')).toBeVisible();
    await expect(page.getByTestId('create-role')).toBeVisible();
    await expect(page.getByTestId('create-password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('clicking Cancel hides the create form', async ({ page }) => {
    await page.getByRole('button', { name: 'Add user' }).click();
    await expect(page.getByTestId('create-email')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('create-email')).not.toBeVisible();
  });

  test('creating a user via the form provisions a working credential account', async ({ page, browser }) => {
    const email = `newuser-ui-${Date.now()}@test.local`;
    const password = 'SecurePass2026!';
    const expectedUsername = email;

    await page.getByRole('button', { name: 'Add user' }).click();

    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-name').fill('New Test User');
    await page.getByTestId('create-password').fill(password);

    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page.getByTestId('create-email')).not.toBeVisible();
    await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('New Test User')).toBeVisible({ timeout: 5000 });

    const created = getCreatedUserRecord(email);
    expect(created.provider).toBe('credentials');
    expect(created.subject).toBe(expectedUsername);
    expect(created.username).toBe(expectedUsername);
    expect(created.displayUsername).toBe('New Test User');
    expect(created.accountProviderId).toBe('credential');
    expect(created.accountId).not.toBeNull();
    expect(created.accountHasPassword).toBe(true);

    const { context, page: loginPage } = await loginWithCredentials(browser, expectedUsername, password);
    await expect(loginPage).not.toHaveURL(/\/login/, { timeout: 10000 });
    await context.close();
  });

  test('creating a user with a specific role shows the role and email login works', async ({ page, browser }) => {
    const email = `viewer-ui-${Date.now()}@test.local`;
    const password = 'ViewerPass2026!';
    const expectedUsername = email;

    await page.getByRole('button', { name: 'Add user' }).click();

    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-name').fill('Viewer User');
    await page.getByTestId('create-password').fill(password);

    // Select Viewer role
    await page.getByTestId('create-role').click();
    await page.getByRole('option', { name: 'Viewer' }).click();

    await page.getByRole('button', { name: 'Create', exact: true }).click();

    const row = page.getByRole('row').filter({ hasText: email });
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row.getByText('Viewer', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(row.getByText('Invited')).toBeVisible();

    const created = getCreatedUserRecord(email);
    expect(created.role).toBe('viewer');
    expect(created.provider).toBe('credentials');
    expect(created.subject).toBe(expectedUsername);
    expect(created.username).toBe(expectedUsername);

    const { context } = await loginWithCredentials(browser, expectedUsername, password);
    await context.close();
  });

  test('a new user can be disabled and enabled from the row menu', async ({ page }) => {
    const email = `toggle-ui-${Date.now()}@test.local`;
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-password').fill('TogglePass2026!');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });

    await rowMenu(page, email);
    await page.getByRole('menuitem', { name: 'Disable user' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disable user' }).click();
    await expect(page.getByRole('row').filter({ hasText: email }).getByText('Disabled')).toBeVisible({ timeout: 5000 });

    await rowMenu(page, email);
    await page.getByRole('menuitem', { name: 'Enable user' }).click();
    await expect(page.getByRole('row').filter({ hasText: email }).getByText('Disabled')).not.toBeVisible({ timeout: 5000 });
  });

  test('the edit form has a role select with Admin, User, Viewer in the panel of another user', async ({ page }) => {
    const email = `role-ui-${Date.now()}@test.local`;
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByTestId('create-email').fill(email);
    await page.getByTestId('create-password').fill('RolePass2026!x');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });

    await rowMenu(page, email);
    await page.getByRole('menuitem', { name: 'Open details' }).click();
    const roleTrigger = page.locator('[data-testid^="edit-role-"]').first();
    await expect(roleTrigger).toBeVisible();
    await roleTrigger.click();
    await expect(page.getByRole('option', { name: 'Admin' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'User' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Viewer' })).toBeVisible();
  });

  test('the Roles tab lists the built-in roles', async ({ page }) => {
    await page.getByRole('tab', { name: /^Roles/ }).click();
    await expect(page).toHaveURL(/\/users\?tab=roles/);
    const roles = page.getByRole('region', { name: 'Roles' });
    for (const name of ['Admin', 'User', 'Viewer']) {
      await expect(roles.getByText(name, { exact: true }).first()).toBeVisible();
    }
    await roles.getByRole('button', { name: /^Admin/ }).click();
    await expect(page.getByText('Built-in roles cannot be edited or deleted.')).toBeVisible();
  });
});

test.describe('Users page — unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated access to /users redirects to /login', async ({ page }) => {
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login/);
  });
});

// ── API v1 create user tests ─────────────────────────────────────────────

test.describe('Users API v1 — create user (POST)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('admin can create a user via API', async ({ page, browser }) => {
    const origin = new URL(page.url()).origin;
    const email = `api-created-${Date.now()}@test.local`;
    const password = 'ApiPass2026!';
    const expectedUsername = email;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email,
        name: 'API Created',
        password,
        role: 'user',
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.email).toBe(email);
    expect(body.name).toBe('API Created');
    expect(body.role).toBe('user');
    expect(body.passwordHash).toBeUndefined();

    const created = getCreatedUserRecord(email);
    expect(created.provider).toBe('credentials');
    expect(created.subject).toBe(expectedUsername);
    expect(created.username).toBe(expectedUsername);
    expect(created.accountProviderId).toBe('credential');
    expect(created.accountHasPassword).toBe(true);

    await page.goto('/users');
    await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });

    const { context } = await loginWithCredentials(browser, expectedUsername, password);
    await context.close();
  });

  test('admin can create a viewer via API', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const email = `api-viewer-${Date.now()}@test.local`;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email,
        name: 'API Viewer',
        password: 'ViewerPass2026!',
        role: 'viewer',
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.role).toBe('viewer');

    const created = getCreatedUserRecord(email);
    expect(created.role).toBe('viewer');
    expect(created.provider).toBe('credentials');
    expect(created.accountProviderId).toBe('credential');
  });

  test('API POST with invalid role is downgraded to user', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const email = `api-invalid-role-${Date.now()}@test.local`;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email,
        name: 'Invalid Role',
        password: 'InvalidRole2026!',
        role: 'superadmin',
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.role).toBe('user');

    const created = getCreatedUserRecord(email);
    expect(created.role).toBe('user');
  });

  test('API POST returns 400 when email is missing', async ({ page }) => {
    const origin = new URL(page.url()).origin;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        name: 'No Email',
        password: 'SomePass2026!',
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('required');
  });

  test('API POST returns 400 when password is missing', async ({ page }) => {
    const origin = new URL(page.url()).origin;

    const response = await page.request.post('http://localhost:3000/api/v1/users', {
      headers: { Origin: origin },
      data: {
        email: 'nopass@test.local',
        name: 'No Password',
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('required');
  });
});

test.describe('Users API v1 — create user (POST) — non-admin blocked', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated POST is blocked', async ({ request }) => {
    const response = await request.post('http://localhost:3000/api/v1/users', {
      data: {
        email: 'unauthed@test.local',
        name: 'Unauthed',
        password: 'Pass2026!',
      },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
  });
});
