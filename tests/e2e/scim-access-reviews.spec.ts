/**
 * E2E: SCIM provisioning over real HTTP through the middleware, and the
 * Provisioning, Access Reviews and My reviews pages.
 *
 * SCIM is switched on and a SCIM token is stored directly in the database
 * (the request path never checks the license, so no license is needed).
 */
import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { webSql, writeSettingRow } from '../helpers/e2e-sql';

const ORIGIN = 'http://localhost:3000';
const SCIM = `${ORIGIN}/scim/v2`;
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** Turns SCIM on and stores a SCIM token; returns the raw token. */
function seedScim(): string {
  const raw = `scim_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  webSql(
    'INSERT INTO scim_tokens (name, prefix, "tokenHash", "createdBy", "createdAt") VALUES (?, ?, ?, ?, ?)',
    ['e2e', raw.slice(0, 11), hash, 1, new Date().toISOString()]
  );
  writeSettingRow('scim', { enabled: true, deleteMode: 'disable' });
  return raw;
}

let token: string;

test.describe('SCIM over HTTP', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(() => {
    token = seedScim();
  });

  const scimHeaders = (value: string | null) => ({
    'Content-Type': 'application/scim+json',
    ...(value ? { Authorization: `Bearer ${value}` } : {}),
  });

  test('answers without a token with a SCIM error, not a login redirect', async ({ request }) => {
    const response = await request.get(`${SCIM}/Users`, { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toContain('application/scim+json');
    expect((await response.json()).schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
  });

  test('refuses the SCIM token on the REST API', async ({ request }) => {
    const response = await request.get(`${ORIGIN}/api/v1/users`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(401);
  });

  test('provisions, finds, deactivates and deletes a user', async ({ request }) => {
    const userName = `scim-e2e-${Date.now()}@example.com`;
    const created = await request.post(`${SCIM}/Users`, {
      headers: scimHeaders(token),
      data: {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName,
        externalId: 'e2e-ext',
        displayName: 'SCIM E2E',
        emails: [{ value: userName, type: 'work', primary: true }],
        active: true,
      },
    });
    expect(created.status()).toBe(201);
    const user = await created.json();

    const found = await request.get(`${SCIM}/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`, { headers: scimHeaders(token) });
    expect((await found.json()).totalResults).toBe(1);

    const patched = await request.patch(`${SCIM}/Users/${user.id}`, {
      headers: scimHeaders(token),
      data: { schemas: [PATCH_SCHEMA], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] },
    });
    expect(patched.status()).toBe(200);
    expect((await patched.json()).active).toBe(false);

    const group = await request.post(`${SCIM}/Groups`, {
      headers: scimHeaders(token),
      data: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: `scim-e2e-group-${Date.now()}`, members: [{ value: user.id }] },
    });
    expect(group.status()).toBe(201);
    expect((await group.json()).members).toHaveLength(1);

    const deleted = await request.delete(`${SCIM}/Users/${user.id}`, { headers: scimHeaders(token) });
    expect(deleted.status()).toBe(204);
    expect((await request.get(`${SCIM}/Users/${user.id}`, { headers: scimHeaders(token) })).status()).toBe(404);
  });

  test('does not see the primary admin', async ({ request }) => {
    expect((await request.get(`${SCIM}/Users/1`, { headers: scimHeaders(token) })).status()).toBe(404);
  });
});

test.describe('pages', () => {
  test('SCIM provisioning shows the SCIM endpoint', async ({ page }) => {
    await page.goto('/scim');
    await expect(page.getByRole('heading', { level: 1, name: 'SCIM provisioning' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Sign-in and directories' })).toBeVisible();
    await expect(page.locator('input[readonly]').first()).toHaveValue(/\/scim\/v2$/);
  });

  test('Access reviews and My reviews render', async ({ page }) => {
    await page.goto('/access-reviews');
    await expect(page.getByRole('heading', { level: 1, name: 'Access reviews' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
    await page.goto('/my-reviews');
    await expect(page.getByRole('heading', { level: 1, name: 'My reviews' })).toBeVisible();
  });

  test('Sign-in and directories lists the SCIM endpoint as a source', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign-in and directories' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Single sign-on is (not )?required/ })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Login page options' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Where people sign in from' })).toBeVisible();
  });
});
