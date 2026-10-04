/**
 * What the Fleet page derives from the overview: times, versions, node
 * health, a node against its environment and the running rollout, and the
 * short "what changes" summary (secrets never shown).
 */
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatDuration,
  formatVersion,
  formatWhen,
  isBehind,
  nodeConfiguration,
  nodeHealth,
  nodeStorage,
} from '@/ee/fleet/ui/fleet-view';
import { summarizeConfigDiff } from '@/ee/fleet/ui/RolloutPanel';
import type { EnvironmentView, FleetInstanceView, FleetOverview, RolloutView } from '@/ee/fleet/types';

const now = Date.parse('2026-10-03T11:36:00.000Z');

const instance: FleetInstanceView = {
  id: 3, name: 'edge-3', baseUrl: 'https://edge-3.example.com', syncMode: 'push', pull: null, enabled: true, environmentId: 2,
  revisionId: 47, pushedAt: '2026-10-02T16:05:00.000Z', lastSyncAt: '2026-10-02T16:05:00.000Z', lastSyncError: null,
  drift: { status: 'in_sync', checkedAt: '2026-10-03T11:35:00.000Z', since: null, detail: null, reportedVersion: '2.0.2', localChanges: false },
};

const production: EnvironmentView = {
  id: 2, name: 'Production', description: null, position: 1, promotionOnly: true, revisionId: 47,
  canary: { enabled: true, waitSeconds: 600, checkCaddyStatus: true }, instanceIds: [2, 3], activeRolloutId: 19, createdAt: '', updatedAt: '',
};

const rollout: RolloutView = {
  id: 19, environmentId: 2, environmentName: 'Production', revisionId: 48, fromRevisionId: 47, kind: 'promotion', sourceEnvironmentId: 1,
  rollbackOfId: null, status: 'running', phase: 'observing', canary: { instanceId: 2, waitSeconds: 600, checkCaddyStatus: true, observeUntil: null },
  error: null, startedBy: 1, startedByName: 'Admin', createdAt: '', updatedAt: '', finishedAt: null,
  targets: [
    { instanceId: 2, instanceName: 'edge-2', role: 'canary', status: 'synced', error: null, syncedAt: '' },
    { instanceId: 3, instanceName: 'edge-3', role: 'rest', status: 'pending', error: null, syncedAt: null },
  ],
};

describe('Fleet page helpers', () => {
  it('formats times in UTC: the time today, the day this year, the date before', () => {
    expect(formatWhen('2026-10-03T11:35:20.000Z', now)).toBe('11:35:20');
    expect(formatWhen('2026-10-02T16:05:00.000Z', now)).toBe('2 Oct 16:05');
    expect(formatWhen('2025-12-31T23:00:00.000Z', now)).toBe('31 Dec 2025');
    expect(formatWhen('not a date', now)).toBe('');
  });

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(560)).toBe('9 min 20 s');
    expect(formatDuration(7500)).toBe('2 h 5 min');
    expect(formatDuration(-3)).toBe('0 s');
  });

  it('compares release versions and leaves anything else alone', () => {
    expect(compareVersions('2.0.2', '2.0.3')).toBe(-1);
    expect(compareVersions('v2.1.0', '2.0.9')).toBe(1);
    expect(compareVersions('2.0.3', 'v2.0.3')).toBe(0);
    expect(compareVersions('2.0.3', 'unknown')).toBeNull();
    expect(formatVersion('2.0.3')).toBe('v2.0.3');
    expect(formatVersion('unknown')).toBe('unknown');
  });

  it('places a node against its environment and the rollout running there', () => {
    expect(nodeConfiguration(instance, production, rollout)).toMatchObject({ label: 'Revision', revisionId: 47, note: 'takes #48 after the canary' });
    expect(nodeConfiguration(instance, production, { ...rollout, phase: 'rolling' }).note).toBe('takes #48 now');
    expect(nodeConfiguration({ ...instance, id: 2, revisionId: 48 }, production, rollout).note).toBe('ahead of Production');
    // No rollout: a node on another revision than its environment is behind it.
    expect(nodeConfiguration({ ...instance, revisionId: 45 }, production, null)).toMatchObject({ note: 'Behind its environment', tone: 'warn' });
    expect(isBehind({ ...instance, revisionId: 45 }, production, null)).toBe(true);
    expect(isBehind({ ...instance, revisionId: 45 }, production, rollout)).toBe(false);
    expect(isBehind({ ...instance, revisionId: 45, enabled: false }, production, null)).toBe(false);
    expect(nodeConfiguration({ ...instance, revisionId: null, pushedAt: null }, null, null).label).toBe('Nothing pushed yet');
  });

  it('derives health from drift checks and pull reports', () => {
    expect(nodeHealth(instance, undefined, now)).toMatchObject({ tone: 'ok', label: 'Healthy', note: 'checked 11:35' });
    expect(nodeHealth({ ...instance, drift: { ...instance.drift, status: 'unreachable' } }, undefined, now)).toMatchObject({ tone: 'bad', label: 'Unreachable' });
    expect(nodeHealth({ ...instance, enabled: false }, undefined, now)).toMatchObject({ tone: 'off', label: 'Disabled' });
    const pull = { ...instance, syncMode: 'pull' as const, pull: { lastSeenAt: '2026-10-03T11:20:00.000Z', pollIntervalSeconds: 30, checkIn: 'missed' as const, hasCredential: true } };
    expect(nodeHealth(pull, undefined, now)).toMatchObject({ tone: 'bad', label: 'Not checking in', note: 'last check-in 11:20:00' });
  });

  it('reads a node certificate storage from what it last received', () => {
    const overview = {
      master: { version: '2.0.3', certificateStorage: { backend: 'redis', redisMode: 'sentinel' }, driftCheckIntervalSeconds: 300, rolloutStepSeconds: 10 },
      revisionStorage: { '47': { backend: 'local', redisMode: null } },
    } as unknown as FleetOverview;
    expect(nodeStorage(instance, overview)).toEqual({ backend: 'local', redisMode: null });
    expect(nodeStorage({ ...instance, revisionId: null }, overview)).toEqual({ backend: 'redis', redisMode: 'sentinel' });
    expect(nodeStorage({ ...instance, revisionId: null, pushedAt: null }, overview)).toBeNull();
  });

  it('summarises what a rollout changes without showing secrets', () => {
    const lines = summarizeConfigDiff({
      entities: [
        {
          entity: 'settings', label: 'Settings', added: [], removed: [],
          changed: [{ id: 'certificate_storage', label: 'Certificate storage', changes: [{ path: 'backend', before: 'local', after: 'redis' }, { path: 'redis.password', secret: true }] }],
        },
        { entity: 'proxyHosts', label: 'Proxy hosts', added: [{ id: 3, label: 'shop.example.com' }], removed: [], changed: [] },
      ],
      totals: { added: 1, removed: 0, changed: 1 },
    });
    expect(lines).toEqual([
      { kind: 'head', text: 'Settings · Certificate storage' },
      { kind: 'remove', text: 'backend: local' },
      { kind: 'add', text: 'backend: redis' },
      { kind: 'note', text: '  redis.password: changed (secret, not shown)' },
      { kind: 'add', text: 'Proxy hosts · shop.example.com (added)' },
    ]);
  });
});
