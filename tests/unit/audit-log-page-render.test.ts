/**
 * Server-side render of the Audit log page: filters from the facets held in
 * the URL, the hash-chain banner in its states, the streaming cards with
 * their lag, the expanded detail with the before/after diff, and what a
 * reader without the chain or the sinks gets.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/audit-log',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(dashboard)/audit-log/actions', () => ({
  getAuditEventDetailAction: vi.fn(),
}));
vi.mock('@/ee/audit/ui/actions', () => ({
  verifyAuditLogAction: vi.fn(),
}));
vi.mock('@/ee/audit/ui/streaming-actions', () => ({
  createAuditSinkAction: vi.fn(),
  deleteAuditSinkAction: vi.fn(),
  saveAuditRetentionAction: vi.fn(),
  testAuditSinkAction: vi.fn(),
  updateAuditSinkAction: vi.fn(),
}));

import AuditLogClient from '@/app/(dashboard)/audit-log/AuditLogClient';
import { EventDetail } from '@/app/(dashboard)/audit-log/AuditEventsTable';
import { EMPTY_FILTERS, auditLogHref, entityTypeLabel, type AuditEventRow } from '@/src/lib/audit-log-view';
import { formatLag, type AuditSinkSummary } from '@/ee/audit/ui/sink-view';
import StreamingClient from '@/ee/audit/ui/StreamingClient';
import type { AuditChainStatus } from '@/ee/audit/chain-status';
import type { AuditSinkView } from '@/ee/audit/types';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

const events: AuditEventRow[] = [
  {
    id: 112, createdAt: '2026-10-03T10:58:02.000Z', userId: 4, actor: { kind: 'user', name: 'Laura', email: 'laura@example.com' },
    action: 'update', entityType: 'proxy_host', entityId: 12, summary: 'Changed the upstream of app.example.com', hash: HASH_B, prevHash: HASH_A,
    configChange: { beforeId: 211, afterId: 212, changeRequestId: null, pending: false },
  },
  {
    id: 111, createdAt: '2026-10-03T10:40:00.000Z', userId: null, actor: { kind: 'system', name: 'System', email: null },
    action: 'mfa_verification_failed', entityType: 'user', entityId: 9, summary: 'Second-factor sign-in step failed', hash: HASH_A, prevHash: null,
    configChange: null,
  },
];

const facets = {
  actors: [{ value: '4', label: 'Laura', events: 10 }, { value: 'system', label: 'System', events: 3 }],
  actions: ['mfa_verification_failed', 'update'],
  entityTypes: ['proxy_host', 'user'],
};

const chainOk: AuditChainStatus = {
  lastCheck: { eventId: 109, at: '2026-10-03T10:30:00.000Z', byUserId: 1, ok: true, checked: 18, firstMismatchId: null, headId: 108, headHash: HASH_A },
  eventsSinceCheck: 3,
  anchor: { id: 5, at: '2026-08-01T00:00:00.000Z' },
  head: { id: 112, at: '2026-10-03T10:58:02.000Z', hash: HASH_B },
};

const sinks: AuditSinkSummary[] = [
  {
    id: 1, name: 'SIEM', typeLabel: 'Syslog over TLS', target: 'tls://siem.example.com:6514', enabled: true, lastDeliveredId: 112, pendingEvents: 0,
    oldestPendingAt: null, lastDeliveryAt: '2026-10-03T10:58:04.000Z', lastError: null, consecutiveFailures: 0, nextAttemptAt: null,
  },
  {
    id: 2, name: 'Archive webhook', typeLabel: 'Webhook', target: 'https://hooks.example.com', enabled: true, lastDeliveredId: 100, pendingEvents: 12,
    oldestPendingAt: '2026-10-03T10:54:00.000Z', lastDeliveryAt: '2026-10-03T10:30:00.000Z', lastError: 'HTTP 503', consecutiveFailures: 6, nextAttemptAt: '2026-10-03T11:10:00.000Z',
  },
];

type Overrides = Partial<Parameters<typeof AuditLogClient>[0]>;

function render(overrides: Overrides = {}) {
  return renderToStaticMarkup(
    createElement(AuditLogClient, {
      events,
      total: 2,
      totalInRange: null,
      page: 1,
      perPage: 50,
      filters: { ...EMPTY_FILTERS, range: '24h' },
      facets,
      licensed: true,
      chain: chainOk,
      sinks,
      retentionDays: 365,
      canHistory: true,
      canApprovals: true,
      generatedAt: '2026-10-03T11:00:00.000Z',
      ...overrides,
    })
  );
}

describe('Audit log page', () => {
  it('builds the filter bar from the facets and keeps the URL state', () => {
    const html = render({ filters: { ...EMPTY_FILTERS, q: 'upstream', actor: '4', entityType: 'proxy_host', range: '7d' }, total: 1, totalInRange: 2 });
    expect(html).toContain('type="search"');
    expect(html).toContain('placeholder="Search summaries, hosts, users"');
    expect(html).toContain('value="upstream"');
    expect(html).toMatch(/<option value="4" selected="">Laura<\/option>/);
    expect(html).toContain('<option value="system">System</option>');
    expect(html).toContain('<option value="mfa_verification_failed">mfa_verification_failed</option>');
    expect(html).toMatch(/<option value="proxy_host" selected="">Proxy host<\/option>/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>7d</);
    expect(html).toContain('1 of 2 events in the last 7 days match');
    expect(html).toContain('Clear filters');
  });

  it('lists events with a diff toggle for configuration changes and details for the rest', () => {
    const html = render();
    expect(html).toContain('2 events in the last 24 hours');
    expect(html).toContain('Changed the upstream of app.example.com');
    expect(html).toContain('>Show diff');
    expect(html).toContain('>Details');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('#112');
    // A failed sign-in step is tinted as a warning.
    expect(html).toMatch(/bg-warn-tint text-warn"[^>]*>mfa_verification_failed</);
    // Everything fits on one page: no pager.
    expect(html).not.toContain('aria-label="Pages of events"');
  });

  it('pages the events with the shared pager, keeping the filters in each link', () => {
    const html = render({ total: 120, page: 2, filters: { ...EMPTY_FILTERS, actor: '4', range: '7d', page: 2 } });
    expect(html).toContain('aria-label="Pages of events"');
    expect(html).toMatch(/<span class="num">51<\/span>–<span class="num">100<\/span> of <span class="num">120<\/span> events/);
    expect(html).toContain('href="/audit-log?actor=4&amp;range=7d"');
    expect(html).toContain('href="/audit-log?actor=4&amp;range=7d&amp;page=3"');
    expect(html).toMatch(/aria-current="page"[^>]*><span class="num">2<\/span>/);
  });

  it('shows events of actions this release no longer records as they were stored', () => {
    // npm_imported and npm_import_failed were recorded by the Nginx Proxy Manager import of earlier releases.
    const laura = { kind: 'user' as const, name: 'Laura', email: 'laura@example.com' };
    const older: AuditEventRow[] = [
      {
        id: 90, createdAt: '2026-10-01T09:05:00.000Z', userId: 4, actor: laura, action: 'npm_import_failed', entityType: 'configuration', entityId: null,
        summary: 'Import from Nginx Proxy Manager undone: Caddy did not accept the configuration', hash: null, prevHash: null, configChange: null,
      },
      {
        id: 89, createdAt: '2026-10-01T09:00:00.000Z', userId: 4, actor: laura, action: 'npm_imported', entityType: 'configuration', entityId: null,
        summary: 'Imported from Nginx Proxy Manager: 2 proxy hosts, 1 access list', hash: null, prevHash: null, configChange: null,
      },
    ];
    const html = render({ events: older, total: 2, facets: { ...facets, actions: ['npm_import_failed', 'npm_imported'], entityTypes: ['configuration'] } });
    expect(html).toMatch(/bg-warn-tint text-warn"[^>]*>npm_import_failed</);
    expect(html).toMatch(/bg-raise text-muted-foreground"[^>]*>npm_imported</);
    expect(html).toContain('>Configuration<');
    expect(html).toContain('Import from Nginx Proxy Manager undone: Caddy did not accept the configuration');
    expect(html).toContain('Imported from Nginx Proxy Manager: 2 proxy hosts, 1 access list');
    expect(html).toContain('<option value="npm_imported">npm_imported</option>');
  });

  it('shows the hash chain state with Verify now', () => {
    const html = render();
    expect(html).toContain('Chain verified, 18 events, last check');
    expect(html).toContain('3 events recorded since.');
    expect(html).toContain('Anchored at #5 · newest #112 · head hash b2b2b2b2…b2b2b2b2');
    expect(html).toContain('Verify now');
    const never = render({ chain: { lastCheck: null, eventsSinceCheck: 40, anchor: null, head: null } });
    expect(never).toContain('The hash chain has not been verified yet.');
    const broken = render({ chain: { ...chainOk, lastCheck: { ...chainOk.lastCheck!, ok: false, firstMismatchId: 77 } } });
    expect(broken).toContain('found a mismatch');
    expect(broken).toContain('#77');
    expect(broken).toContain('data-tone="bad"');
  });

  it('shows the streaming destinations with their lag and a failing one', () => {
    const html = render();
    expect(html).toContain('Manage destinations');
    expect(html).toContain('Events are kept for 365 days.');
    expect(html).toContain('tls://siem.example.com:6514');
    expect(html).toContain('Failing: HTTP 503');
    expect(html).toContain('6 min');
    expect(html).toContain('Edit Archive webhook');
    expect(html).toContain('Streaming and retention');
  });

  it('shows the events without the chain or the sinks when there are none to show', () => {
    const html = render({ chain: null, sinks: null, retentionDays: null });
    expect(html).toContain('Changed the upstream of app.example.com');
    expect(html).not.toContain('Verify now');
    expect(html).not.toContain('Manage destinations');
    expect(html).not.toContain('Streaming and retention');
  });

  it('keeps export and verification read-only without a license, and names ignored filters', () => {
    const html = render({ licensed: false, invalidFilters: ['actor must be a user id or "system"'] });
    expect(html).toContain('Export, integrity verification, streaming and retention need a Business license.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Exporting needs a Business license"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Verifying needs a Business license"/);
    expect(html).toContain('Some filters were ignored.');
    expect(html).toContain('actor must be a user id or &quot;system&quot;');
  });

  it('offers to clear the filters when nothing matches', () => {
    const html = render({ events: [], total: 0, totalInRange: 4, filters: { ...EMPTY_FILTERS, action: 'update', range: '1h' } });
    expect(html).toContain('No events match these filters.');
    expect(html).not.toContain('aria-label="Pages of events"');
  });
});

describe('expanded event', () => {
  it('shows the before/after diff with the hashes, the sinks it reached and the history links', () => {
    const html = renderToStaticMarkup(
      createElement(EventDetail, {
        event: events[0],
        sinks,
        canHistory: true,
        canApprovals: true,
        mode: 'unified',
        onModeChange: () => undefined,
        state: {
          status: 'ok',
          detail: {
            id: 112,
            data: null,
            previousEventId: 111,
            configDiff: {
              beforeId: 211, afterId: 212, available: true, reason: null, filtered: true, truncated: false,
              groups: [{
                entity: 'proxyHosts', entityLabel: 'Proxy hosts', id: 12, label: 'app.example.com', kind: 'changed', host: null,
                fields: [{ path: 'upstreams.0', before: 'app-web:3000', after: 'app-web-v3:3000' }, { path: 'meta.token', secret: true }],
              }],
            },
          },
        },
      })
    );
    expect(html).toContain('Before and after');
    expect(html).toContain('From configuration versions <span class="num">#211</span> and <span class="num">#212</span>');
    expect(html).toContain('2</span> fields changed');
    expect(html).toContain('Proxy hosts');
    expect(html).toContain('app-web:3000');
    expect(html).toContain('app-web-v3:3000');
    expect(html).toContain('Secret value changed (not shown)');
    expect(html).toContain('b2b2b2b2…b2b2b2b2');
    expect(html).toContain('a1a1a1a1…a1a1a1a1');
    expect(html).toContain('#111');
    // Only the sink that received event 112.
    expect(html).toContain('>SIEM<');
    expect(html).toContain('href="/history?version=212"');
    expect(html).toContain('href="/history?version=211&amp;rollback=1"');
  });

  it('shows what was recorded with an event that changed no configuration', () => {
    const html = renderToStaticMarkup(
      createElement(EventDetail, {
        event: events[1],
        sinks: null,
        canHistory: true,
        canApprovals: false,
        mode: 'unified',
        onModeChange: () => undefined,
        state: { status: 'ok', detail: { id: 111, data: { method: 'totp' }, configDiff: null, previousEventId: null } },
      })
    );
    expect(html).toContain('Recorded with the event');
    expect(html).toContain('&quot;method&quot;: &quot;totp&quot;');
    expect(html).not.toContain('Streamed');
    expect(html).not.toContain('/history?');
  });
});

describe('audit log helpers', () => {
  it('builds filter URLs without empty values or defaults', () => {
    expect(auditLogHref({ ...EMPTY_FILTERS })).toBe('/audit-log');
    expect(auditLogHref({ ...EMPTY_FILTERS, q: ' a b ', actor: 'system', range: '24h', page: 2 })).toBe('/audit-log?q=a+b&actor=system&range=24h&page=2');
  });

  it('labels entity types and lags', () => {
    expect(entityTypeLabel('proxy_host')).toBe('Proxy host');
    expect(entityTypeLabel('some_new_thing')).toBe('Some new thing');
    expect(formatLag('2026-10-03T10:59:58.000Z', '2026-10-03T11:00:00.000Z')).toBe('2 s');
    expect(formatLag('2026-10-03T08:00:00.000Z', '2026-10-03T11:00:00.000Z')).toBe('3 h');
  });
});

describe('Audit streaming page', () => {
  const sink: AuditSinkView = {
    id: 3, name: 'Splunk', type: 'splunk_hec', enabled: true, config: { url: 'https://splunk.example.com:8088', index: 'audit' }, hasSecret: true,
    lastDeliveredId: 90, pendingEvents: 4, oldestPendingAt: '2026-10-03T10:59:30.000Z', lastDeliveryAt: '2026-10-03T10:59:00.000Z',
    lastError: 'HTTP 503', lastErrorAt: '2026-10-03T10:59:40.000Z', consecutiveFailures: 2, nextAttemptAt: '2026-10-03T11:01:00.000Z',
    createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:00.000Z',
  };

  function renderStreaming(licensed: boolean) {
    return renderToStaticMarkup(
      createElement(StreamingClient, {
        sinks: [sink],
        retention: { days: 365, lastRunAt: null, lastDeleted: null },
        licensed,
        generatedAt: '2026-10-03T11:00:00.000Z',
      })
    );
  }

  it('shows each sink with its status, waiting events and lag, never a secret', () => {
    const html = renderStreaming(true);
    expect(html).toContain('Audit streaming');
    expect(html).toContain('href="/audit-log"');
    expect(html).toContain('Splunk HEC');
    expect(html).toContain('Failing');
    expect(html).toContain('event #90');
    expect(html).toContain('30 s');
    expect(html).toContain('2 failed attempts in a row');
    expect(html).toContain('Add sink');
    expect(html).not.toContain('hasSecret');
  });

  it('stays read-only without a license but can still wind down', () => {
    const html = renderStreaming(false);
    expect(html).toContain('Setting up, changing or enabling sinks and retention needs a Business license.');
    expect(html).not.toContain('Add sink');
    expect(html).toContain('Keep events forever');
    expect(html).toContain('title="Delete sink"');
  });
});
