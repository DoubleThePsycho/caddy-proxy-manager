import { test, expect } from '@playwright/test';

/**
 * Compliance page and API on the E2E stack, which runs without a license:
 * everything is readable, generating and drafting are refused with 403.
 */
test.describe('Compliance', () => {
  test('page loads with the license notice, overview, tabs and control mapping', async ({ page }) => {
    await page.goto('/compliance');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { name: 'Compliance', level: 1 })).toBeVisible();
    await expect(page.getByText(/needs a license with compliance reports/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /generate report/i })).toBeDisabled();

    // Overview: schedule, last report, live controls, test restores and the incident register.
    await expect(page.getByRole('heading', { name: 'Next scheduled report' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();
    await expect(page.getByText('TLS on every host')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Test restores' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Incident register' })).toBeVisible();
    await expect(page.getByRole('button', { name: /record an incident/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /record a test restore/i })).toBeDisabled();

    await page.getByRole('tab', { name: /control mapping/i }).click();
    await expect(page.getByText('does not by itself show compliance', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('A.5.15').first()).toBeVisible();

    await page.getByRole('tab', { name: /reports/i }).click();
    await expect(page.getByRole('heading', { name: 'Report schedules' })).toBeVisible();
    await expect(page.getByRole('button', { name: /new schedule/i })).toBeDisabled();
  });

  test('switches the control references between NIS2 and ISO/IEC 27001', async ({ page }) => {
    await page.goto('/compliance');
    await expect(page.getByRole('columnheader', { name: 'NIS2 article' })).toBeVisible();
    await page.getByRole('group', { name: 'Framework' }).getByRole('button', { name: 'ISO/IEC 27001' }).click();
    await expect(page.getByRole('columnheader', { name: 'ISO/IEC 27001 control' })).toBeVisible();
    await expect(page).toHaveURL(/framework=iso27001/);
  });

  test('the earlier tab names still open the page', async ({ page }) => {
    await page.goto('/compliance?tab=incidents');
    await expect(page.getByRole('heading', { name: 'Incident register' })).toBeVisible();
    await page.goto('/compliance?tab=controls');
    await expect(page.getByText('A.5.15').first()).toBeVisible();
  });

  test('sidebar links to the page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Compliance' }).first().click();
    await expect(page).toHaveURL(/\/compliance$/);
  });

  test('API reads without a license and refuses to generate', async ({ page }) => {
    const list = await page.request.get('/api/v1/compliance/reports');
    expect(list.status()).toBe(200);
    expect(await list.json()).toMatchObject({ reports: [], page: 1 });

    const controls = await page.request.get('/api/v1/compliance/controls');
    expect(controls.status()).toBe(200);

    const generate = await page.request.post('/api/v1/compliance/reports', {
      data: { type: 'access_review' },
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(generate.status()).toBe(403);
    expect((await generate.json()).error).toMatch(/Enterprise license/);

    const draft = await page.request.post('/api/v1/compliance/incidents', {
      data: { title: 'E2E incident' },
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(draft.status()).toBe(403);
  });

  test('print views of missing items answer 404', async ({ page }) => {
    const response = await page.goto('/print/compliance/reports/999999');
    expect(response?.status()).toBe(404);
  });
});
