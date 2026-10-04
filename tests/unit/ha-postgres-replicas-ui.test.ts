/**
 * Server-side render of Settings → High availability on PostgreSQL
 * (ee/high-availability/ui/PostgresReplicasSection.tsx through
 * ClusterSection): "PostgreSQL mode", the replicas with their role, last
 * heartbeat, version and schema, which one leads, read-only, the license
 * rule, and the warnings (refused, no leader, mixed versions, election
 * reconnecting). The SQLite cluster card is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(),
}));

import ClusterSection, { clusterSummaryLabel } from '@/ee/high-availability/ui/ClusterSection';
import type { ClusterView, PostgresReplicasView, ReplicaReport } from '@/ee/high-availability/cluster/types';

const NOW = '2026-10-04T10:00:00.000Z';

function replica(id: string, overrides: Partial<ReplicaReport> = {}): ReplicaReport {
  return {
    id,
    hostname: `${id}.example.com`,
    version: '1.4.0',
    schemaVersion: '0053_cluster_nodes',
    firstSeenAt: NOW,
    startedAt: NOW,
    lastHeartbeatAt: NOW,
    stoppedAt: null,
    status: 'live',
    leader: false,
    leaderSince: null,
    thisNode: false,
    ...overrides,
  };
}

function postgres(overrides: Partial<PostgresReplicasView> = {}): PostgresReplicasView {
  return {
    nodeId: 'web-1',
    role: 'leader',
    refusal: null,
    leaderNodeId: 'web-1',
    election: { state: 'leader', leader: true, leaderSince: NOW, lastHeartbeatAt: NOW, terms: 1, lastError: null, lastErrorAt: null },
    liveReplicas: 2,
    nodes: [
      replica('web-1', { leader: true, leaderSince: NOW, thisNode: true }),
      replica('web-2'),
      replica('web-3', { status: 'gone' }),
      replica('web-4', { status: 'stopped', stoppedAt: NOW }),
    ],
    heartbeatSeconds: 10,
    goneAfterSeconds: 45,
    pruneAfterDays: 30,
    ...overrides,
  };
}

function view(pg: PostgresReplicasView | null, configurable = true): ClusterView {
  return { enabled: false, configurable, error: null, node: null, lease: null, replication: null, lastRestore: null, nodes: [], config: null, postgres: pg };
}

const render = (v: ClusterView) => renderToStaticMarkup(createElement(ClusterSection, { view: v, editionLabel: 'Enterprise' }));

describe('Settings → High availability on PostgreSQL', () => {
  it('shows PostgreSQL mode: the replicas, who leads, heartbeats, versions and schema, read-only', () => {
    const html = render(view(postgres()));
    expect(html).toContain('PostgreSQL mode');
    expect(html).toContain('Dashboard cluster');
    for (const id of ['web-1', 'web-2', 'web-3', 'web-4']) expect(html).toContain(id);
    expect(html).toContain('this replica');
    expect(html).toContain('web-2.example.com');
    for (const label of ['Leader', 'Follower', 'Gone', 'Stopped']) expect(html).toContain(label);
    expect(html).toContain('0053_cluster_nodes');
    expect(html).toContain('1.4.0');
    expect(html).toContain('every 10 s');
    expect(html).toContain('checked once, when it joins');
    expect(html).not.toContain('High availability is off on this node');
    expect(html).not.toMatch(/<(input|select|textarea)\b/);
    expect(html).not.toContain('No replica leads');
  });

  it('says when the license would refuse another replica, without touching the running ones', () => {
    expect(render(view(postgres(), false))).toContain('Adding a replica needs an active Enterprise license.');
    expect(render(view(postgres(), true))).not.toContain('Adding a replica needs');
  });

  it('warns about a refused replica, a missing leader, mixed versions and a reconnecting election', () => {
    const refused = render(view(postgres({ role: 'refused', refusal: 'This replica was not admitted: example reason', nodeId: 'web-9' })));
    expect(refused).toContain('This replica was not admitted.');
    expect(refused).toContain('example reason');
    expect(refused).toContain('Not admitted');

    const leaderless = render(
      view(postgres({ leaderNodeId: null, nodes: [replica('web-1', { thisNode: true }), replica('web-2', { version: '1.5.0' })] }))
    );
    expect(leaderless).toContain('No replica leads.');
    expect(leaderless).toContain('The replicas run different versions.');

    const reconnecting = render(
      view(
        postgres({
          role: 'follower',
          election: {
            state: 'connecting',
            leader: false,
            leaderSince: null,
            lastHeartbeatAt: null,
            terms: 1,
            lastError: 'The leader election connection was lost',
            lastErrorAt: NOW,
          },
        })
      )
    );
    expect(reconnecting).toContain('This replica is reconnecting to the leader election.');
    expect(reconnecting).toContain('The leader election connection was lost');
  });

  it('labels the group, and keeps the SQLite cluster card as it was', () => {
    expect(clusterSummaryLabel(view(postgres()))).toBe('PostgreSQL mode');
    expect(clusterSummaryLabel(view(null))).toBe('Off');
    const sqlite = render(view(null));
    expect(sqlite).toContain('High availability is off on this node');
    expect(sqlite).not.toContain('PostgreSQL mode');
  });
});
