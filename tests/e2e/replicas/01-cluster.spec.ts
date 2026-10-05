/**
 * Two replicas on one PostgreSQL (tests/playwright.replicas.config.ts):
 * exactly one leads the background jobs, and both say so the same way
 * (ee/docs/high-availability.md, "PostgreSQL replicas").
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { REPLICAS, healthStatus, soleLeader, type ClusterNodesView, type Replica } from '../../helpers/replicas';

async function clusterNodes(request: APIRequestContext, replica: Replica): Promise<ClusterNodesView> {
  const response = await request.get(`${replica.url}/api/v1/cluster/nodes`);
  expect(response.status(), `${replica.nodeId}: GET /api/v1/cluster/nodes`).toBe(200);
  return (await response.json()) as ClusterNodesView;
}

test.describe('Two replicas: the leader', () => {
  test('exactly one replica answers the leader health check; both serve', async ({ request }) => {
    const leader = await soleLeader();
    for (const replica of REPLICAS) {
      expect(await healthStatus(replica), `${replica.nodeId}: /api/health`).toBe(200);
      expect(await healthStatus(replica, 'request-path'), `${replica.nodeId}: scope=request-path`).toBe(200);
      const response = await request.get(`${replica.url}/api/health?scope=leader`);
      if (replica === leader) {
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ status: 'ok', role: 'leader' });
      } else {
        expect(response.status()).toBe(503);
        expect(await response.json()).toEqual({ status: 'follower', role: 'follower' });
      }
    }
  });

  test('the cluster API of either replica lists both live replicas and the same leader', async ({ request }) => {
    const leader = await soleLeader();
    for (const replica of REPLICAS) {
      // The leader flag is written when the lead changes; give a fresh term a heartbeat to land.
      await expect
        .poll(async () => (await clusterNodes(request, replica)).leaderNodeId, { timeout: 15_000 })
        .toBe(leader.nodeId);
      const view = await clusterNodes(request, replica);
      expect(view).toMatchObject({
        enabled: true,
        nodeId: replica.nodeId,
        role: replica === leader ? 'leader' : 'follower',
        leaderNodeId: leader.nodeId,
        liveReplicas: 2,
        refusal: null,
      });
      const live = view.nodes.filter((node) => node.status === 'live');
      expect(live.map((node) => node.id).sort()).toEqual(REPLICAS.map((r) => r.nodeId).sort());
      expect(live.filter((node) => node.leader).map((node) => node.id)).toEqual([leader.nodeId]);
      expect(live.filter((node) => node.thisNode).map((node) => node.id)).toEqual([replica.nodeId]);
      // One version and one schema: both replicas run the same image.
      expect(new Set(live.map((node) => `${node.version}/${node.schemaVersion}`)).size).toBe(1);
    }
  });

  test('High availability shows both replicas and the license rule', async ({ page }) => {
    const leader = await soleLeader();
    for (const replica of REPLICAS) {
      await page.goto(`${replica.url}/high-availability`);
      const group = page.getByRole('main');
      await expect(group.getByRole('heading', { name: 'Dashboard cluster' })).toBeVisible();
      await expect(group.getByText('PostgreSQL mode').first()).toBeVisible();
      for (const other of REPLICAS) {
        const row = group.getByRole('row').filter({ hasText: other.nodeId });
        await expect(row).toBeVisible();
        await expect(row.getByText(other === leader ? 'Leader' : 'Follower', { exact: true })).toBeVisible();
        await expect(row.getByText('this replica', { exact: true })).toHaveCount(other === replica ? 1 : 0);
      }
      // Two live replicas and no license: the rule for a third one is spelled out.
      await expect(group.getByText(/^Adding a replica needs an active .+ license\.$/)).toBeVisible();
      await expect(group.getByText('No replica leads.')).toHaveCount(0);
    }
  });
});
