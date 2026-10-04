/**
 * PostgreSQL replicas (ee/docs/high-availability.md#postgresql-replicas).
 * The test stack runs one dashboard: on PostgreSQL it is the only replica
 * and leads the background jobs; on SQLite nothing of this runs. Two
 * replicas, the handover and the license rule are covered by
 * tests/integration/pg/ and tests/integration/cluster-nodes.test.ts.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

async function clusterNodes(request: APIRequestContext) {
  const response = await request.get('/api/v1/cluster/nodes');
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    enabled: boolean;
    nodeId: string | null;
    role: string | null;
    leaderNodeId: string | null;
    liveReplicas: number;
    refusal: string | null;
    nodes: Array<{ id: string; status: string; leader: boolean; thisNode: boolean }>;
  };
}

test.describe('PostgreSQL replicas (one dashboard on the test stack)', () => {
  test('the health check says this dashboard runs the background jobs', async ({ request }) => {
    expect((await request.get('/api/health?scope=leader')).status()).toBe(200);
    const plain = await request.get('/api/health');
    expect(plain.status()).toBe(200);
    expect(await plain.json()).toEqual({ status: 'ok' });
  });

  test('the API lists the one replica, which leads, or says the stack runs on SQLite', async ({ page }) => {
    const body = await clusterNodes(page.request);
    if (!body.enabled) {
      expect(body.nodes).toEqual([]);
      return;
    }
    expect(body).toMatchObject({ role: 'leader', liveReplicas: 1, refusal: null });
    expect(body.leaderNodeId).toBe(body.nodeId);
    expect(body.nodes.filter((node) => node.status === 'live')).toEqual([
      expect.objectContaining({ id: body.nodeId, leader: true, thisNode: true }),
    ]);
  });

  test('Settings shows PostgreSQL mode with the replica', async ({ page }) => {
    const body = await clusterNodes(page.request);
    test.skip(!body.enabled, 'The test stack runs on SQLite');
    await page.goto('/settings?section=high-availability');
    const group = page.locator('section[data-settings-group="high-availability"]');
    await expect(group.getByRole('heading', { name: 'Dashboard cluster' })).toBeVisible();
    await expect(group.getByText('PostgreSQL mode').first()).toBeVisible();
    await expect(group.getByText('this replica', { exact: true })).toBeVisible();
    await expect(group.getByText('High availability is off on this node')).toHaveCount(0);
  });
});
