import { test, expect } from '@playwright/test';

/**
 * API monetization on the E2E stack: every tab renders (postpaid,
 * failed-answer credits, x402, replica serving and retention included), and
 * the REST API reads and changes the settings, x402 and plans, putting back
 * what it changed. Nothing here calls Stripe or the x402 facilitator.
 */
const ORIGIN = { Origin: 'http://localhost:3000' };

test.describe('API monetization', () => {
  test('shows every tab', async ({ page }) => {
    await page.goto('/api-monetization');
    await expect(page.getByRole('heading', { name: 'API monetization', level: 1 })).toBeVisible();
    await expect(page.getByText(/needs a license|read-only without/i)).toHaveCount(0);
    for (const tab of ['Overview', 'Plans', 'Consumers', 'Hosts', 'Stripe', 'x402', 'Settings', 'Ledger']) {
      await expect(page.getByRole('tab', { name: new RegExp(`^${tab}`) })).toBeVisible();
    }

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/tab=settings/);
    await expect(page.getByText('Usage history')).toBeVisible();
    await expect(page.getByLabel('Keep for (months)')).toHaveValue('13');
    await expect(page.getByRole('combobox', { name: 'Serve monetized hosts on replicas' })).toBeVisible();
    await expect(page.getByText('Failed-answer credits').first()).toBeVisible();

    await page.getByRole('tab', { name: 'x402' }).click();
    await expect(page.getByText('x402 pay-per-request')).toBeVisible();
    await expect(page.getByText('Stripe receives the payments.')).toBeVisible();
    await expect(page.getByText('No x402 payments yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();

    await page.getByRole('tab', { name: 'Stripe' }).click();
    for (const event of ['setup_intent.succeeded', 'payment_intent.payment_failed', 'charge.dispute.created']) {
      await expect(page.getByText(event).first()).toBeVisible();
    }
  });

  test('REST API: reads and changes the settings, x402 and plans', async ({ page }) => {
    const settings = await page.request.get('/api/v1/monetization/settings');
    expect(settings.status()).toBe(200);
    expect(await settings.json()).toMatchObject({ usageRetentionMonths: 13, replicas: { mode: 'off' }, analyticsAvailable: expect.any(Boolean) });
    const retention = await page.request.put('/api/v1/monetization/settings', { data: { usageRetentionMonths: 6 }, headers: ORIGIN });
    expect(retention.status()).toBe(200);
    expect(await retention.json()).toMatchObject({ usageRetentionMonths: 6 });
    expect((await page.request.put('/api/v1/monetization/settings', { data: { usageRetentionMonths: 13 }, headers: ORIGIN })).status()).toBe(200);
    expect((await page.request.put('/api/v1/monetization/settings', { data: { replicas: { mode: 'off' } }, headers: ORIGIN })).status()).toBe(200);

    const x402 = await page.request.get('/api/v1/monetization/x402');
    expect(x402.status()).toBe(200);
    const view = await x402.json();
    expect(view).toMatchObject({ enabled: false, configured: false, hasCdpKeySecret: false, network: 'eip155:8453', priceCents: 1, depositAddress: null, stripeReady: false });
    expect(JSON.stringify(view)).not.toContain('"cdpKeySecret"');
    expect(view.networks).toEqual([{ id: 'eip155:8453', label: 'Base' }]);
    const price = await page.request.put('/api/v1/monetization/x402', { data: { priceCents: 5 }, headers: ORIGIN });
    expect(price.status()).toBe(200);
    expect(await price.json()).toMatchObject({ enabled: false, priceCents: 5 });
    expect((await page.request.put('/api/v1/monetization/x402', { data: { priceCents: 1 }, headers: ORIGIN })).status()).toBe(200);
    // Turning x402 on needs the CDP facilitator's credentials first.
    expect((await page.request.put('/api/v1/monetization/x402', { data: { enabled: true }, headers: ORIGIN })).status()).toBe(400);
    expect((await page.request.delete('/api/v1/monetization/x402', { headers: ORIGIN })).status()).toBe(200);

    const payments = await page.request.get('/api/v1/monetization/x402/payments');
    expect(await payments.json()).toMatchObject({ payments: [], total: 0 });
    expect((await page.request.get('/api/v1/monetization/payments')).status()).toBe(200);
    const overview = await (await page.request.get('/api/v1/monetization/overview')).json();
    expect(overview.x402).toEqual({ settled: 0, failed: 0, pending: 0, amountCents: 0 });
    expect(overview.thisMonth).toMatchObject({ creditedMicros: 0, payments: 0 });

    const plan = await page.request.post('/api/v1/monetization/plans', {
      data: { name: 'Metered', pricePerRequestMicros: 1000, billing: 'postpaid', postpaidCapMicros: 50_000_000 },
      headers: ORIGIN,
    });
    expect(plan.status()).toBe(201);
    const created = await plan.json();
    expect(created).toMatchObject({ name: 'Metered', billing: 'postpaid', postpaidCapMicros: 50_000_000 });
    expect((await page.request.delete(`/api/v1/monetization/plans/${created.id}`, { headers: ORIGIN })).status()).toBe(204);
  });

  test('OpenAPI documents the new endpoints', async ({ page }) => {
    const spec = await (await page.request.get('/api/v1/openapi.json')).json();
    for (const path of [
      '/api/v1/monetization/settings',
      '/api/v1/monetization/payments',
      '/api/v1/monetization/x402',
      '/api/v1/monetization/x402/payments',
      '/api/v1/monetization/consumers/{id}/billing/charge',
      '/api/v1/monetization/consumers/{id}/billing/resume',
      '/api/v1/monetization/consumers/{id}/billing/card',
    ]) {
      expect(spec.paths[path], path).toBeDefined();
    }
  });

  test('the public allowance endpoint grants nothing on an instance that is not a master', async ({ page }) => {
    const response = await page.request.post('/api/monetization/replica/allowance', {
      data: { v: 1, hostId: 1, key: 'ik_000000000000_none', want: 1 },
      headers: { Authorization: `Bearer mza_${'A'.repeat(43)}` },
    });
    // The E2E stack runs standalone: refused before any credential is looked at.
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_master' });
  });
});
