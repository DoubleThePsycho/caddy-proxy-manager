/**
 * A third node (ee/docs/high-availability.md, "PostgreSQL replicas"): a node
 * id the cluster does not know joins next to the live replicas. It serves,
 * follows the leader the two replicas already have, is listed by all of
 * them and recorded in the audit log. Removing it leaves the two replicas
 * as they were.
 */
import { test, expect } from '@playwright/test';
import {
  REPLICA_A,
  REPLICA_B,
  REPLICA_C,
  REPLICAS,
  eventually,
  healthStatus,
  replicaCompose,
  soleLeader,
  waitForHealthy,
  type ClusterNodesView,
} from '../../helpers/replicas';

test.describe.serial('Two replicas: a third node joins', () => {
  test.afterAll(() => {
    replicaCompose(['rm', '--stop', '--force', REPLICA_C.service]);
  });

  test('setup: the third node starts', async () => {
    test.setTimeout(240_000);
    replicaCompose(['up', '-d', '--no-deps', REPLICA_C.service]);
    await waitForHealthy(REPLICA_C);
  });

  test('it serves and follows the same leader', async ({ request }) => {
    const leader = await soleLeader();
    expect([REPLICA_A.nodeId, REPLICA_B.nodeId]).toContain(leader.nodeId);
    expect(await healthStatus(REPLICA_C)).toBe(200);
    expect(await healthStatus(REPLICA_C, 'leader')).toBe(503);

    await expect
      .poll(async () => {
        const response = await request.get(`${REPLICA_C.url}/api/v1/cluster/nodes`);
        expect(response.status()).toBe(200);
        const view = (await response.json()) as ClusterNodesView;
        return { nodeId: view.nodeId, role: view.role, refusal: view.refusal };
      }, { timeout: 30_000 })
      .toEqual({ nodeId: REPLICA_C.nodeId, role: 'follower', refusal: null });
  });

  test('every replica lists it next to the other two', async ({ request }) => {
    const leader = await soleLeader();
    for (const replica of [...REPLICAS, REPLICA_C]) {
      await expect
        .poll(async () => {
          const view = (await (await request.get(`${replica.url}/api/v1/cluster/nodes`)).json()) as ClusterNodesView;
          return {
            leader: view.leaderNodeId,
            live: view.nodes.filter((node) => node.status === 'live').map((node) => node.id).sort(),
          };
        }, { timeout: 30_000 })
        .toEqual({ leader: leader.nodeId, live: [REPLICA_A.nodeId, REPLICA_B.nodeId, REPLICA_C.nodeId].sort() });
    }
  });

  test('its joining is in the audit log', async ({ request }) => {
    for (const replica of REPLICAS) {
      const response = await request.get(`${replica.url}/api/v1/audit-log?action=ha_replica_joined&per_page=20`);
      expect(response.status()).toBe(200);
      const { events } = (await response.json()) as { events: Array<{ summary: string | null }> };
      expect(events.map((event) => event.summary)).toContain(`Replica ${REPLICA_C.nodeId} joined the cluster next to running replicas`);
    }
  });

  test('removing it leaves the two replicas as they were', async ({ request }) => {
    test.setTimeout(240_000);
    const leader = await soleLeader();
    replicaCompose(['rm', '--stop', '--force', REPLICA_C.service]);
    expect((await soleLeader()).nodeId).toBe(leader.nodeId);
    for (const replica of REPLICAS) {
      expect(await healthStatus(replica)).toBe(200);
      await eventually(
        `${replica.nodeId} listing two live replicas`,
        async () => {
          const view = (await (await request.get(`${replica.url}/api/v1/cluster/nodes`)).json()) as ClusterNodesView;
          return view.liveReplicas === 2 ? true : null;
        },
        90_000,
        1_000
      );
    }
  });
});
