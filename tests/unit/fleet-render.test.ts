/**
 * Server-side render of the Fleet page: the pipeline of environments with
 * their revision, instances and drift, the running rollout, and what a
 * read-only role sees.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/fleet',
  useSearchParams: () => navigation.search,
}));

import FleetClient from '@/ee/fleet/ui/FleetClient';
import type { FleetOverview } from '@/ee/fleet/types';

const stamp = '2026-10-02T03:00:00.000Z';
const drift = { checkedAt: stamp, since: null, detail: null, reportedVersion: '2.1.0', localChanges: false };
const later = (seconds: number) => new Date(Date.parse(stamp) + seconds * 1000).toISOString();

const overview: FleetOverview = {
  mode: 'master',
  master: { version: '2.1.0', certificateStorage: { backend: 'redis', redisMode: 'sentinel' }, driftCheckIntervalSeconds: 300, rolloutStepSeconds: 10 },
  environments: [
    { id: 1, name: 'staging', description: null, position: 0, promotionOnly: false, revisionId: null, canary: { enabled: true, waitSeconds: 300, checkCaddyStatus: true }, instanceIds: [1], activeRolloutId: null, createdAt: stamp, updatedAt: stamp },
    { id: 2, name: 'production', description: 'Customer traffic', position: 1, promotionOnly: true, revisionId: 4, canary: { enabled: true, waitSeconds: 120, checkCaddyStatus: false }, instanceIds: [2, 3], activeRolloutId: 9, createdAt: stamp, updatedAt: stamp },
  ],
  instances: [
    { id: 1, name: 'edge-staging', baseUrl: 'https://staging.example.com', syncMode: 'push', pull: null, enabled: true, environmentId: 1, revisionId: null, pushedAt: stamp, lastSyncAt: stamp, lastSyncError: null, drift: { ...drift, status: 'in_sync' } },
    { id: 2, name: 'edge-prod-1', baseUrl: 'https://prod1.example.com', syncMode: 'push', pull: null, enabled: true, environmentId: 2, revisionId: 5, pushedAt: stamp, lastSyncAt: stamp, lastSyncError: null, drift: { ...drift, status: 'drifted', since: stamp, detail: 'Its synced configuration was changed on the instance itself' } },
    { id: 3, name: 'edge-prod-2', baseUrl: 'https://prod2.example.com', syncMode: 'push', pull: null, enabled: true, environmentId: 2, revisionId: 4, pushedAt: stamp, lastSyncAt: stamp, lastSyncError: null, drift: { ...drift, status: 'older_version', reportedVersion: '2.0.2' } },
    { id: 4, name: 'edge-lab', baseUrl: 'https://lab.example.com', syncMode: 'push', pull: null, enabled: true, environmentId: null, revisionId: null, pushedAt: null, lastSyncAt: null, lastSyncError: null, drift: { ...drift, status: null, checkedAt: null, reportedVersion: null } },
  ],
  revisions: [
    { id: 5, createdAt: stamp, createdBy: 1, createdByName: 'Admin', summary: 'Proxy hosts: added “shop”', fingerprint: 'ab'.repeat(32), sizeBytes: 2048 },
    { id: 4, createdAt: stamp, createdBy: 1, createdByName: 'Admin', summary: 'Initial revision: 3 proxy hosts', fingerprint: 'cd'.repeat(32), sizeBytes: 1024 },
  ],
  rollouts: [
    {
      id: 9, environmentId: 2, environmentName: 'production', revisionId: 5, fromRevisionId: 4, kind: 'promotion', sourceEnvironmentId: 1, rollbackOfId: null,
      status: 'running', phase: 'observing', canary: { instanceId: 2, waitSeconds: 120, checkCaddyStatus: false, observeUntil: later(80) },
      error: null, startedBy: 1, startedByName: 'Admin', createdAt: stamp, updatedAt: stamp, finishedAt: null,
      targets: [
        { instanceId: 2, instanceName: 'edge-prod-1', role: 'canary', status: 'synced', error: null, syncedAt: stamp },
        { instanceId: 3, instanceName: 'edge-prod-2', role: 'rest', status: 'pending', error: null, syncedAt: null },
      ],
    },
    {
      id: 8, environmentId: 2, environmentName: 'production', revisionId: 4, fromRevisionId: null, kind: 'promotion', sourceEnvironmentId: 1, rollbackOfId: null,
      status: 'succeeded', phase: 'done', canary: { instanceId: null, waitSeconds: 0, checkCaddyStatus: false, observeUntil: null },
      error: null, startedBy: 1, startedByName: 'Admin', createdAt: stamp, updatedAt: stamp, finishedAt: stamp, targets: [],
    },
  ],
  pullReplicas: [],
  revisionStorage: { '4': { backend: 'local', redisMode: null }, '5': { backend: 'redis', redisMode: 'sentinel' } },
};

function render(props: Partial<Parameters<typeof FleetClient>[0]> = {}) {
  return renderToStaticMarkup(createElement(FleetClient, { overview, now: stamp, ...props }));
}

/** The page's text: every tag read as a space, spaces collapsed. */
function text(html: string) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('Fleet page', () => {
  it('shows the environments in promotion order with revisions, nodes, drift and the running rollout', () => {
    const html = render();
    const page = text(html);
    expect(html.indexOf('id="environment-1"')).toBeLessThan(html.indexOf('id="environment-2"'));
    expect(html).toContain('Promotion only');
    expect(html).toContain('Every change');
    expect(html).toContain('pinned to #4');
    expect(page).toContain('Drifted');
    expect(page).toContain('Older version');
    expect(page).toContain('Not checked');
    expect(page).toContain('Rollout #9 : revision #5 to production');
    expect(page).toContain('Observing the canary');
    expect(page).toContain('edge-prod-1 canary · took #5 at 03:00:00');
    expect(page).toContain('ahead of production');
    expect(page).toContain('takes #5 after the canary');
    expect(html).toContain('edge-lab');
    expect(html).toContain('Abort rollout');
    expect(html).toContain('New environment');
    expect(html).not.toContain('needs a');
  });

  it('gives every environment the anchor the sidebar environment switcher links to', () => {
    const html = render();
    for (const environment of overview.environments) expect(html).toContain(`id="environment-${environment.id}"`);
  });

  it('shows the staged rollout: canary, observation with its countdown, the rest and the pin', () => {
    const page = text(render());
    expect(page).toContain('Canary Done · 03:00:00');
    expect(page).toContain('Observe the canary 1 min 20 s left of 2 min');
    expect(page).toContain('Roll out to the rest Waiting');
    expect(page).toContain('Pin production to #5');
    expect(page).toContain('leaves the rest on #4');
    expect(page).toContain('Started 03:00:00 by Admin · replaces #4 · source: what staging runs');
    const html = render();
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="40"');
  });

  it('lists every node with its role, sync, version, configuration, health, drift and certificate storage', () => {
    const page = text(render());
    expect(page).toContain('Master this dashboard Master Source');
    expect(page).toContain('Shared Redis Sentinel');
    expect(page).toContain('Push from master prod1.example.com');
    expect(page).toContain('v2.0.2 master runs v2.1.0');
    expect(page).toContain('Live configuration every change');
    expect(page).toContain('Local on the node, until #5 reaches it');
    expect(page).toContain('Nothing pushed yet');
    expect(page).toContain('Canary');
  });

  it('marks drift and nodes behind their environment, each with a re-sync', () => {
    const finished: FleetOverview = {
      ...overview,
      environments: overview.environments.map((environment) => ({ ...environment, activeRolloutId: null })),
      rollouts: overview.rollouts.map((rollout) => (rollout.id === 9 ? { ...rollout, status: 'failed' as const, phase: 'done' as const, error: 'The canary failed' } : rollout)),
    };
    const html = render({ overview: finished });
    const page = text(html);
    expect(page).toContain('edge-prod-1 no longer runs what this master pushed.');
    expect(page).toContain('Re-sync edge-prod-1');
    expect(page).toContain('Behind its environment');
    expect(page).toContain('Failed');
    expect(page).toContain('The canary failed');
    expect(page).toContain('Roll back to #4');
    expect(html).not.toContain('Abort rollout');
  });

  it('offers a new environment to a role that may write', () => {
    const html = render();
    expect(html).toContain('New environment');
    expect(html).not.toMatch(/license/i);
  });

  it('shows a read-only role no controls', () => {
    const html = render({ allowed: { write: false, promote: false } });
    expect(html).not.toContain('Re-sync');
    expect(html).not.toContain('Abort');
    expect(html).not.toContain('Promote from');
    expect(html).not.toContain('Check drift now');
    expect(html).not.toContain('New environment');
    expect(html).not.toContain('More actions for');
    expect(html).not.toContain('Delete environment');
  });

  it('tells a slave that fleet management runs on the master', () => {
    expect(render({ overview: { ...overview, mode: 'slave' } })).toContain('works on the master instance');
  });

  it('starts an empty fleet with one action', () => {
    const empty: FleetOverview = { ...overview, environments: [], instances: [], rollouts: [], revisions: [], pullReplicas: [], revisionStorage: {} };
    const page = text(render({ overview: empty }));
    expect(page).toContain('No environments yet');
    expect(page).toContain('No replicas yet');
    expect(page).toContain('No rollouts yet');
    expect(page).toContain('No pull replicas');
  });

  it('pages a large fleet: nodes, rollouts and revisions, and caps the chips of an environment', () => {
    const nodes = Array.from({ length: 64 }, (_, index) => ({
      ...overview.instances[0], id: 100 + index, name: `edge-${String(index + 1).padStart(2, '0')}`, baseUrl: `https://edge-${index + 1}.example.com`,
    }));
    const big: FleetOverview = { ...overview, instances: nodes, rollouts: [], environments: overview.environments.map((environment) => ({ ...environment, activeRolloutId: null })) };
    const rolloutPage = { items: [overview.rollouts[1]], total: 60, page: 3 };
    const revisionPage = { items: overview.revisions, total: 52, page: 1 };

    const html = render({ overview: big, rolloutPage, revisionPage });
    const page = text(html);
    expect(html).toContain('aria-label="Filter nodes"');
    expect(html).toContain('edge-25');
    expect(html).not.toContain('>edge-26<');
    expect(page).toMatch(/1 – 25 of 64 nodes/);
    expect(html).toContain('href="/fleet?nodes=2"');
    // The environment card lists the first nodes and links to the rest.
    expect(page).toContain('52 more');
    // Rollouts and revisions are paged on the server.
    expect(page).toMatch(/51 – 60 of 60 rollouts/);
    expect(html).toContain('href="/fleet?rollouts=2"');
    expect(page).toMatch(/1 – 25 of 52 revisions/);
    expect(html).toContain('href="/fleet?revisions=2"');

    navigation.search = new URLSearchParams('nodes=3');
    try {
      const third = render({ overview: big, rolloutPage, revisionPage });
      expect(third).toContain('edge-64');
      expect(third).not.toContain('>edge-50<');
      // The master's row is on the first page only.
      expect(text(third)).not.toContain('Master this dashboard');
    } finally {
      navigation.search = new URLSearchParams();
    }
  });

  it('lists the first targets of a large rollout and offers the rest', () => {
    const targets = Array.from({ length: 30 }, (_, index) => ({
      instanceId: 200 + index, instanceName: `node-${index + 1}`, role: index === 0 ? ('canary' as const) : ('rest' as const),
      status: 'pending' as const, error: null, syncedAt: null,
    }));
    const big: FleetOverview = { ...overview, rollouts: [{ ...overview.rollouts[0], targets }, overview.rollouts[1]] };
    const page = text(render({ overview: big }));
    expect(page).toContain('node-12');
    expect(page).not.toContain('node-13 ');
    expect(page).toContain('Show all 30');
    // Steps give the number of nodes instead of every name.
    expect(page).toContain('29 nodes take #5.');
  });

  it('shows pull replicas with their check-in, credential and controls', () => {
    const replica = {
      id: 5, name: 'branch-office', enabled: true, environmentId: 2, hasCredential: true, credentialPrefix: 'pull_AbCdEf',
      credentialCreatedAt: stamp, syncKeyPin: { keyId: '0123456789abcdef', publicKey: 'A'.repeat(43) + '=', pinnedAt: stamp, source: 'first-use' },
      lastSeenAt: stamp, lastSeenAddress: '203.0.113.7', pollIntervalSeconds: 30, checkIn: 'missed' as const, reportedVersion: '2.1.0',
      caddy: { ok: false, at: stamp, code: 'CADDY_REJECTED' }, deliveredAt: stamp, deliveredRevisionId: 4, resyncPending: false,
      lastSyncAt: stamp, lastSyncError: null, createdAt: stamp,
    };
    const withPull: FleetOverview = {
      ...overview,
      instances: [
        ...overview.instances,
        {
          id: 5, name: 'branch-office', baseUrl: 'pull:00000000-0000-4000-8000-000000000000', syncMode: 'pull',
          pull: { lastSeenAt: stamp, pollIntervalSeconds: 30, checkIn: 'missed', hasCredential: true },
          enabled: true, environmentId: 2, revisionId: 4, pushedAt: stamp, lastSyncAt: stamp, lastSyncError: null, drift: { ...drift, status: 'unreachable' },
        },
      ],
      pullReplicas: [replica, { ...replica, id: 6, name: 'revoked-one', hasCredential: false, credentialPrefix: null, checkIn: 'never', caddy: null }],
    };
    const html = render({ overview: withPull });
    expect(html).toContain('Pull replicas');
    expect(html).toContain('Add pull replica');
    expect(html).toContain('pull_AbCdEf…');
    expect(html).toContain('Not checking in');
    expect(html).toContain('Never checked in');
    expect(html).toContain('Revoked');
    expect(html).toContain('Caddy apply failed');
    expect(html).toContain('Rotate');
    expect(text(html)).toContain('Pull agent every 30 s · checked in 03:00:00');
    expect(html).not.toContain('pull:00000000');

    const readOnly = render({ overview: withPull, allowed: { write: false, promote: false, replicas: false } });
    expect(readOnly).toContain('branch-office');
    expect(readOnly).not.toContain('Add pull replica');
    expect(readOnly).not.toContain('Rotate');
    expect(readOnly).not.toContain('Revoke</button>');
  });
});
