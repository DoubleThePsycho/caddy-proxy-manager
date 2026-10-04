/**
 * High availability, phase 2: the dashboard cluster
 * (ee/high-availability/cluster). The test stack runs one dashboard without
 * HA_ENABLED, so this checks that nothing changes there: the health check
 * answers as before, standby answers never appear, and Settings and the API
 * say high availability is off. The cluster itself (lease, Litestream,
 * failover) is covered by the unit tests with fakes.
 */
import { test, expect } from '@playwright/test';

test.describe('High availability: dashboard cluster (off on the test stack)', () => {
  test('the health check answers as it always did', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    const scoped = await request.get('/api/health?scope=request-path');
    expect(scoped.status()).toBe(200);
  });

  test('the API reports high availability off, without secrets', async ({ page }) => {
    const response = await page.request.get('/api/v1/high-availability/cluster');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, node: null, lease: null, nodes: [], config: null });
    expect(response.headers()['x-ha-role']).toBeUndefined();
  });

  test('Settings shows the cluster group with how to set it up', async ({ page }) => {
    // On PostgreSQL the group shows the replicas instead (postgres-replicas.spec.ts).
    const nodes = await page.request.get('/api/v1/cluster/nodes');
    test.skip((await nodes.json()).enabled === true, 'The test stack runs on PostgreSQL');
    await page.goto('/settings?section=high-availability');
    const group = page.locator('section[data-settings-group="high-availability"]');
    await expect(group.getByRole('heading', { name: 'Dashboard cluster' })).toBeVisible();
    await expect(group.getByText('High availability is off on this node')).toBeVisible();
    await expect(group.getByRole('link', { name: 'Read the setup guide' })).toHaveAttribute('href', /ee\/docs\/high-availability\.md$/);
  });
});
