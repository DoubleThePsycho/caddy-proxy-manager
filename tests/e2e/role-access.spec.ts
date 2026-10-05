/**
 * E2E tests: Role-based access control.
 *
 * Verifies that:
 * - Non-admin users (user, viewer) CAN access / and /profile
 * - Non-admin users CANNOT access admin-only pages
 * - Unauthenticated users are redirected to /login everywhere
 * - Admin users can access all pages
 *
 * Test setup:
 * - Creates "testuser" (role=user) and "testviewer" (role=viewer) in the database
 *   (tests/helpers/e2e-sql.ts).
 * - Logs in as each role in separate browser contexts.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { ensureLocalUser } from '../helpers/e2e-sql';

/**
 * The settings pages next to what they configure: each needs settings:read,
 * which neither the user nor the viewer role holds (title: their heading).
 */
const SETTINGS_PAGES = [
  { path: '/certificates/settings', title: 'Certificate settings' },
  { path: '/proxy-hosts/defaults', title: 'Host defaults' },
  { path: '/geo-blocking', title: 'Geo blocking' },
  { path: '/rate-limiting', title: 'Rate limiting' },
  { path: '/analytics/settings', title: 'Analytics settings' },
  { path: '/oauth-providers', title: 'OAuth providers' },
  { path: '/instances', title: 'Instance sync' },
  { path: '/high-availability', title: 'High availability' },
  { path: '/backups', title: 'Backups' },
] as const;

// Pages that require admin role (via requireAdmin in their own page.tsx)
const ADMIN_ONLY_PAGES = [
  '/proxy-hosts',
  '/l4-proxy-hosts',
  '/certificates',
  '/access-lists',
  '/analytics',
  '/waf',
  '/security',
  '/audit-log',
  '/settings',
  '/users',
  '/groups',
  '/api-docs',
  ...SETTINGS_PAGES.map((entry) => entry.path),
];

// Pages accessible to any authenticated user
const USER_ACCESSIBLE_PAGES = [
  '/',
  '/profile',
];

// All dashboard pages (union of both sets)
const ALL_DASHBOARD_PAGES = [...USER_ACCESSIBLE_PAGES, ...ADMIN_ONLY_PAGES];

/** Creates (or resets) a local test user with the given role in the stack's database. */
function ensureTestUser(username: string, password: string, role: string) {
  ensureLocalUser({ username, password, role });
}

/**
 * Log in as the given user and return an authenticated browser context.
 */
async function loginAs(
  browser: import('@playwright/test').Browser,
  username: string,
  password: string
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('http://localhost:3000/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // The login client does a full-page window.location.replace('/') on success — wait for that
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 60_000 });
  await page.close();
  return context;
}

// ── Unauthenticated access ────────────────────────────────────────────────

test.describe('Unauthenticated access', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ALL_DASHBOARD_PAGES) {
    test(`${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    });
  }
});

// ── Role-based access ─────────────────────────────────────────────────────

test.describe('Role-based access control', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let userContext: BrowserContext;
  let viewerContext: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    // Create test users with non-admin roles
    ensureTestUser('testuser', 'TestUserPass2026!', 'user');
    ensureTestUser('testviewer', 'TestViewerPass2026!', 'viewer');

    // Log in as each role
    userContext = await loginAs(browser, 'testuser', 'TestUserPass2026!');
    viewerContext = await loginAs(browser, 'testviewer', 'TestViewerPass2026!');
  });

  test.afterAll(async () => {
    await userContext?.close();
    await viewerContext?.close();
  });

  // ── "user" role — can access / and /profile ─────────────────────────

  test('user role: / loads the overview', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  test('user role: / shows no admin sections', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({ timeout: 5_000 });
      // No permissions: what needs their attention and their account, no hosts, traffic or changes
      await expect(page.getByRole('link', { name: /proxy host/i })).not.toBeVisible({ timeout: 3_000 });
      await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible();
      await expect(page.getByText('Nothing else to show for your role')).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('user role: sidebar only shows Overview', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({ timeout: 5_000 });
      // Overview should be in the nav
      await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
      // Admin-only nav items should not be visible
      await expect(page.getByRole('link', { name: 'Proxy hosts' })).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Users and groups', exact: true })).not.toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('user role: /profile loads successfully', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/profile');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  // ── "viewer" role — can access / and /profile ───────────────────────

  test('viewer role: / loads the overview', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  test('viewer role: / shows no admin sections', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole('link', { name: /proxy host/i })).not.toBeVisible({ timeout: 3_000 });
      await expect(page.getByRole('region', { name: 'Busiest hosts' })).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test('viewer role: sidebar only shows Overview', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Proxy hosts' })).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).not.toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('viewer role: /profile loads successfully', async () => {
    const page = await viewerContext.newPage();
    try {
      await page.goto('/profile');
      await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
      await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  // ── "user" role — blocked from admin-only pages ─────────────────────

  for (const path of ADMIN_ONLY_PAGES) {
    test(`user role: ${path} is blocked`, async () => {
      const page = await userContext.newPage();
      try {
        const response = await page.goto(path);
        // requireAdmin() throws "Administrator privileges required".
        // Next.js renders the error boundary or returns 500.
        const status = response?.status() ?? 0;
        const url = page.url();

        const isBlocked =
          status >= 400 ||
          url.includes('/login') ||
          await page.getByText(/administrator privileges|error|forbidden|not authorized/i)
            .isVisible({ timeout: 3_000 }).catch(() => false);

        expect(isBlocked).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  // ── "viewer" role — blocked from admin-only pages ───────────────────

  for (const path of ADMIN_ONLY_PAGES) {
    test(`viewer role: ${path} is blocked`, async () => {
      const page = await viewerContext.newPage();
      try {
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        const url = page.url();

        const isBlocked =
          status >= 400 ||
          url.includes('/login') ||
          await page.getByText(/administrator privileges|error|forbidden|not authorized/i)
            .isVisible({ timeout: 3_000 }).catch(() => false);

        expect(isBlocked).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  // ── Admin user — can access all pages ───────────────────────────────

  test('admin role: all dashboard pages are accessible', async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    // Use the pre-authenticated admin state from global-setup
    const adminContext = await browser.newContext({
      storageState: require('path').resolve(__dirname, '../.auth/admin.json'),
    });
    try {
      for (const path of ALL_DASHBOARD_PAGES) {
        const page = await adminContext.newPage();
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        expect(status).toBeLessThan(400);
        expect(page.url()).not.toContain('/login');
        await page.close();
      }
    } finally {
      await adminContext.close();
    }
  });

  test('admin role: sidebar shows all nav items', async ({ browser }) => {
    const adminContext = await browser.newContext({
      storageState: require('path').resolve(__dirname, '../.auth/admin.json'),
    });
    try {
      const page = await adminContext.newPage();
      await page.goto('/');
      await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Proxy hosts', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Users and groups', exact: true })).toBeVisible();
      await page.close();
    } finally {
      await adminContext.close();
    }
  });

  test('admin role: every settings page loads with its heading', async ({ browser }, testInfo) => {
    testInfo.setTimeout(90_000);
    const adminContext = await browser.newContext({
      storageState: require('path').resolve(__dirname, '../.auth/admin.json'),
    });
    try {
      const page = await adminContext.newPage();
      for (const { path, title } of SETTINGS_PAGES) {
        const response = await page.goto(path);
        expect(response?.status() ?? 0, path).toBeLessThan(400);
        await expect(page.getByRole('heading', { level: 1, name: title, exact: true }), path).toBeVisible();
      }
      await page.close();
    } finally {
      await adminContext.close();
    }
  });

  test('user role: the sidebar lists no settings page', async () => {
    const page = await userContext.newPage();
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible({ timeout: 5_000 });
      for (const { title } of SETTINGS_PAGES) {
        await expect(page.getByRole('link', { name: title, exact: true }), title).toHaveCount(0);
      }
    } finally {
      await page.close();
    }
  });

  // ── API endpoints — non-admin should be blocked ───────────────────────

  test('user role: API v1 endpoints return 401/403', async () => {
    const page = await userContext.newPage();
    try {
      const response = await page.request.get('/api/v1/proxy-hosts');
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await page.close();
    }
  });

  test('viewer role: API v1 endpoints return 401/403', async () => {
    const page = await viewerContext.newPage();
    try {
      const response = await page.request.get('/api/v1/proxy-hosts');
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await page.close();
    }
  });
});
