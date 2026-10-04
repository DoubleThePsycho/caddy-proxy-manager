/**
 * The impact summary of a change request (ee/approvals/impact.ts).
 */
import { describe, expect, it } from 'vitest';
import { computeChangeImpact } from '@/ee/approvals/impact';
import type { WindowStatus } from '@/ee/approvals/types';

const open: WindowStatus = { restricted: false, open: true, nextOpenAt: null, description: null };
const closed: WindowStatus = { restricted: true, open: false, nextOpenAt: '2026-10-05T07:00:00.000Z', description: 'Mon–Thu 09:00–17:00 (Europe/Rome)' };
const reach = { mode: 'master' as const, nodes: 3, instances: [{ id: 1, name: 'edge-2', syncMode: 'push' as const }, { id: 2, name: 'edge-3', syncMode: 'pull' as const }], heldBack: [] };
const standalone = { mode: 'standalone' as const, nodes: 1, instances: [], heldBack: [] };

function impact(overrides: Partial<Parameters<typeof computeChangeImpact>[0]> = {}) {
  return computeChangeImpact({
    targetType: 'proxy_host',
    targetId: 7,
    targetName: 'app.example.com',
    operation: 'update',
    operations: ['update'],
    status: 'pending',
    change: { host: { upstreams: ['app-v2:8080'] } },
    base: { host: { domains: ['app.example.com'], upstreams: ['app:8080'], certificateId: null, enabled: true } },
    window: closed,
    appliedAt: null,
    reach,
    ...overrides,
  });
}

describe('change impact', () => {
  it('names the one host, the nodes that reload and when it applies', () => {
    const result = impact();
    expect(result.hosts).toEqual([{ type: 'proxy_host', id: 7, name: 'app.example.com', domains: ['app.example.com'], change: 'update', operations: ['update'] }]);
    expect(result.otherHosts).toBe(0);
    expect(result.caddy).toEqual({ reloads: true, nodes: 3, instances: ['edge-2', 'edge-3'], heldBack: [], certificateRequests: [], l4PortsChange: false });
    expect(result.schedule).toEqual({
      state: 'next_window',
      at: '2026-10-05T07:00:00.000Z',
      windows: 'Mon–Thu 09:00–17:00 (Europe/Rome)',
      description: 'At the next change window after approval: 2026-10-05 07:00 UTC.',
    });
    expect(result.lines.map((line) => line.text)).toEqual([
      'app.example.com. No other host changes.',
      'Reloads its configuration on all 3 nodes.',
      'At the next change window after approval: 2026-10-05 07:00 UTC.',
    ]);
  });

  it('lists the certificates Caddy will request for new domains of a host without an imported certificate', () => {
    const created = impact({
      operation: 'create',
      operations: ['create'],
      targetId: null,
      targetName: 'paperless.example.com',
      change: { host: { domains: ['paperless.example.com', '10.0.0.4', 'nas.local'], certificateId: null } },
      base: null,
      window: open,
      reach: standalone,
    });
    expect(created.caddy.certificateRequests).toEqual(['paperless.example.com']);
    expect(created.schedule).toMatchObject({ state: 'on_approval', description: 'As soon as it is approved. No change window applies.' });
    expect(created.lines[0].text).toBe('paperless.example.com, a new proxy host. No other host changes.');
    expect(created.lines[1].text).toBe('Reloads its configuration on this node. Requests a certificate for paperless.example.com.');

    const imported = impact({ change: { host: { domains: ['app.example.com', 'new.example.com'] } }, base: { host: { domains: ['app.example.com'], certificateId: 4 } } });
    expect(imported.caddy.certificateRequests).toEqual([]);
  });

  it('flags L4 port changes and instances held back by promotion-only environments', () => {
    const result = impact({
      targetType: 'l4_proxy_host',
      targetName: 'Postgres',
      change: { host: { listenAddress: ':6432' } },
      base: { host: { listenAddress: ':5432', protocol: 'tcp' } },
      reach: { ...reach, heldBack: [{ id: 3, name: 'prod-1', environment: 'Production' }] },
    });
    expect(result.caddy).toMatchObject({ l4PortsChange: true, heldBack: ['prod-1'] });
    expect(result.lines[1].text).toContain('The L4 listening ports change and must be applied');
    expect(result.lines[1].text).toContain('1 instance gets it only through promotion.');
  });

  it('follows the request through approval and application', () => {
    expect(impact({ status: 'approved' }).schedule).toMatchObject({ state: 'waiting', at: '2026-10-05T07:00:00.000Z' });
    expect(impact({ status: 'approved', window: { ...closed, open: true, nextOpenAt: null } }).schedule.state).toBe('now');
    expect(impact({ status: 'applied', appliedAt: '2026-10-05T07:01:00.000Z' }).schedule).toEqual({
      state: 'done', at: '2026-10-05T07:01:00.000Z', windows: closed.description, description: 'Applied 2026-10-05 07:01 UTC.',
    });
    expect(impact({ status: 'rejected' }).schedule).toMatchObject({ state: 'done', description: 'This request is closed; nothing more will be applied.' });
    expect(impact({ operation: 'delete', operations: ['delete'], change: {} }).hosts[0]).toMatchObject({ change: 'delete', domains: ['app.example.com'] });
  });
});
