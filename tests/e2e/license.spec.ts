import { test, expect } from '@playwright/test';

/**
 * The license page on the E2E stack, which runs without a license: the
 * Community state, the edition matrix and its filters, the verify step,
 * which checks a key on the server and installs nothing, the online check,
 * which has nothing to confirm without a key bought online, and automatic
 * updates, which stay off (the stack never contacts a license server).
 */
test.describe('License', () => {
  test('shows the Community state and every paid feature by edition', async ({ page }) => {
    await page.goto('/license');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'License', level: 1 })).toBeVisible();
    const current = page.getByRole('region', { name: 'Current license' });
    await expect(current.getByText('No license', { exact: true })).toBeVisible();
    await expect(current.getByText('Community', { exact: true })).toBeVisible();
    await expect(current.getByRole('button', { name: 'Remove key' })).toHaveCount(0);

    const matrix = page.getByRole('region', { name: 'What each edition includes' });
    await expect(matrix.getByRole('rowheader', { name: /Fleet management/ })).toBeVisible();
    await expect(matrix.getByRole('rowheader', { name: /White-label/ })).toBeVisible();

    const filters = matrix.getByRole('group', { name: 'Show features' });
    await filters.getByRole('button', { name: /^Not licensed/ }).click();
    await expect(filters.getByRole('button', { name: /^Not licensed/ })).toHaveAttribute('aria-pressed', 'true');
    // Never set up on the stack: approval policies cannot be created without a license.
    await expect(matrix.getByRole('rowheader', { name: /Change approvals/ })).toBeVisible();
    await filters.getByRole('button', { name: /^Not set up/ }).click();
    await expect(matrix.getByText('No feature in this view.')).toBeVisible();
  });

  test('verifies a pasted key or a key file before installing, and refuses an invalid one', async ({ page }) => {
    await page.goto('/license');
    const install = page.getByRole('region', { name: 'Install a key' });
    const verify = install.getByRole('button', { name: 'Verify key' });
    await expect(verify).toBeDisabled();

    await install.getByLabel('License key').fill('v1.not.valid');
    await verify.click();
    await expect(install.getByRole('status')).toContainText('The license key is not valid');
    await expect(install.getByRole('button', { name: 'Install key' })).toHaveCount(0);

    await install.getByRole('button', { name: 'Start over' }).click();
    await install.locator('input[type="file"]').setInputFiles({
      name: 'license.key',
      mimeType: 'text/plain',
      buffer: Buffer.from('Your key:\nv1.bm90.YXZhbGlka2V5\n'),
    });
    await expect(install.getByText('license.key')).toBeVisible();
    await expect(install.getByText('Ready to verify')).toBeVisible();
    await verify.click();
    await expect(install.getByRole('status')).toContainText('not valid');

    // Nothing was installed.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Current license' }).getByText('No license', { exact: true })).toBeVisible();
  });

  test('REST API: verify checks a key without installing it', async ({ page }) => {
    const verify = await page.request.post('/api/v1/license/verify', {
      data: { key: 'v1.not.valid' },
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(verify.status()).toBe(200);
    expect(await verify.json()).toMatchObject({ installable: false, status: 'invalid', error: 'The license key is not valid' });

    const empty = await page.request.post('/api/v1/license/verify', {
      data: { key: '' },
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(empty.status()).toBe(400);

    const license = await page.request.get('/api/v1/license');
    expect(await license.json()).toMatchObject({ status: 'unlicensed', onlineCheck: { required: false, state: null } });

    // Nothing to confirm online without a key bought online.
    const check = await page.request.post('/api/v1/license/check', { headers: { Origin: 'http://localhost:3000' } });
    expect(check.status()).toBe(409);
    expect((await check.json()).error).toBe('No license key is installed');
  });

  test('automatic updates are off by default and never return a refresh token', async ({ page }) => {
    await page.goto('/license');
    const card = page.getByRole('region', { name: 'Automatic updates' });
    await expect(card.getByRole('switch', { name: 'Keep the license up to date automatically' })).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByText('https://license.ingres.si')).toBeVisible();

    const view = await page.request.get('/api/v1/license/auto-update');
    expect(view.status()).toBe(200);
    expect(await view.json()).toMatchObject({ enabled: false, hasRefreshToken: false, status: expect.any(String) });

    const bad = await page.request.put('/api/v1/license/auto-update', {
      data: { enabled: true, refreshToken: 'lrt_not-a-token' },
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(bad.status()).toBe(400);

    const check = await page.request.post('/api/v1/license/auto-update/check', { headers: { Origin: 'http://localhost:3000' } });
    expect(check.status()).toBe(409);
  });
});
