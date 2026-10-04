/**
 * The license rule (ee/docs/high-availability.md, "License rule"): a node id
 * the cluster does not know joins next to live replicas only with an
 * Enterprise license that includes high availability. The stack has none, so
 * a third node is refused: it answers every request but the liveness check
 * with 503 and the reason, it runs nothing, and the two replicas keep
 * working. Removing it changes nothing for them either.
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
  type ClusterNodesView,
} from '../../helpers/replicas';

const REFUSAL =
  /^This replica was not admitted: another replica is already running on this PostgreSQL database, and more than one replica needs an active Enterprise license with high availability\./;

test.describe.serial('Two replicas: a third node without a license', () => {
  test.afterAll(() => {
    replicaCompose(['rm', '--stop', '--force', REPLICA_C.service]);
  });

  test('setup: the third node starts', async () => {
    test.setTimeout(240_000);
    replicaCompose(['up', '-d', '--no-deps', REPLICA_C.service]);
    // Liveness answers while the process runs, refused or not.
    await eventually('the third node answering its liveness check', async () => ((await healthStatus(REPLICA_C, 'live')) === 200 ? true : null), 180_000, 1_000);
  });

  test('it is refused: 503 and the license rule on every path but liveness', async ({ request }) => {
    // It decides when it starts; give the join a moment after the server answers.
    await eventually('the third node refusing', async () => ((await healthStatus(REPLICA_C)) === 503 ? true : null), 30_000, 500);

    const health = await request.get(`${REPLICA_C.url}/api/health`);
    expect(health.status()).toBe(503);
    expect(await health.json()).toEqual({ status: 'refused', role: 'refused' });
    expect(await healthStatus(REPLICA_C, 'leader')).toBe(503);

    const page = await request.get(`${REPLICA_C.url}/login`, { maxRedirects: 0 });
    expect(page.status()).toBe(503);
    expect(page.headers()['x-ha-role']).toBe('refused');
    expect(page.headers()['content-type']).toContain('text/plain');
    expect(await page.text()).toMatch(REFUSAL);

    const api = await request.get(`${REPLICA_C.url}/api/v1/cluster/nodes`);
    expect(api.status()).toBe(503);
    expect(api.headers()['x-ha-role']).toBe('refused');
    const body = (await api.json()) as { error: string; role: string };
    expect(body.role).toBe('refused');
    expect(body.error).toMatch(REFUSAL);
  });

  test('the two replicas keep serving, with the same leader, and do not list it', async ({ request }) => {
    const leader = await soleLeader();
    for (const replica of REPLICAS) {
      expect(await healthStatus(replica)).toBe(200);
      const view = (await (await request.get(`${replica.url}/api/v1/cluster/nodes`)).json()) as ClusterNodesView;
      expect(view.leaderNodeId).toBe(leader.nodeId);
      expect(view.liveReplicas).toBe(2);
      expect(view.nodes.map((node) => node.id)).not.toContain(REPLICA_C.nodeId);
    }
  });

  test('the refusal is in the audit log, with the reason', async ({ request }) => {
    for (const replica of [REPLICA_A, REPLICA_B]) {
      const response = await request.get(`${replica.url}/api/v1/audit-log?action=ha_replica_refused&per_page=20`);
      expect(response.status()).toBe(200);
      const { events } = (await response.json()) as { events: Array<{ summary: string | null }> };
      expect(events.map((event) => event.summary)).toContain(
        `Replica ${REPLICA_C.nodeId} was not admitted: another replica is running and the license does not include high availability`
      );
    }
  });

  test('removing it leaves the two replicas as they were', async () => {
    replicaCompose(['rm', '--stop', '--force', REPLICA_C.service]);
    await soleLeader();
    for (const replica of REPLICAS) expect(await healthStatus(replica)).toBe(200);
  });
});
