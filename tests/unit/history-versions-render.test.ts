/**
 * The Change history page: the version timeline (titles, authors, sizes, the
 * live marker, day groups), the version header, the rollback preview in words
 * (hosts that change, later changes undone, same-host warning, refusal by an
 * approval policy) and the pure helpers behind them.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/history',
  useSearchParams: () => new URLSearchParams(),
}));

import HistoryClient from '@/ee/config-history/ui/HistoryClient';
import { RollbackSummary } from '@/ee/config-history/ui/RollbackPanel';
import {
  compareQuery,
  describeActors,
  describeRollbackHost,
  emptyCompareText,
  groupByDay,
  initials,
  parseCompareParam,
  remainingReasons,
  toDiffField,
} from '@/ee/config-history/ui/history-format';
import type { RollbackPreview, VersionView } from '@/ee/config-history/versions';

const NOW = Date.parse('2026-10-03T11:36:00.000Z');

function version(id: number, overrides: Partial<VersionView> = {}): VersionView {
  return {
    id,
    createdAt: '2026-10-03T10:58:00.000Z',
    userId: null,
    userName: null,
    reason: 'auto',
    summary: 'Updated 1 proxy host',
    fingerprint: `fp${id}`,
    sizeBytes: 431_000,
    title: `Version title ${id}`,
    titleSource: 'audit',
    actors: [{ userId: 2, name: 'l.bianchi' }],
    auditEventIds: [],
    changeRequestIds: [],
    previousId: id - 1,
    size: '1 host · 1 field',
    totals: { items: 1, fields: 1, hosts: 1, hostsAdded: 0, hostsRemoved: 0, settings: 0, other: 0 },
    touched: { hosts: [{ type: 'proxy_host', id: 12, label: 'app.example.com' }], settings: [] },
    live: false,
    ...overrides,
  };
}

const versions: VersionView[] = [
  version(212, { title: 'Changed the upstream of app.example.com', live: true }),
  version(211, { createdAt: '2026-10-03T09:41:00.000Z', reason: 'manual', title: 'Before the upgrade', actors: [{ userId: 1, name: 'admin' }], size: 'No changes' }),
  version(207, { createdAt: '2026-10-02T13:30:00.000Z', changeRequestIds: [13], actors: [{ userId: 3, name: 'j.moretti' }] }),
  version(204, { createdAt: '2026-09-29T14:08:00.000Z', actors: [] }),
];

function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(HistoryClient, {
      now: NOW,
      versions: { versions, total: 40, limit: 25, offset: 0, liveId: 212, recording: { enabled: true, retention: 200 } },
      page: 1,
      perPage: 25,
      oldest: { id: 13, createdAt: '2026-08-06T08:00:00.000Z' },
      backups: { destinations: [] },
      settings: { enabled: true, retention: 200 },
      isSlave: false,
      limits: { minRetention: 1, maxRetention: 10000, minPassphraseLength: 12 },
      ...overrides,
    })
  );
}

describe('Change history page', () => {
  it('shows the timeline with titles, authors, sizes, day groups and the live version selected', () => {
    const html = render();
    expect(html).toContain('Change history');
    expect(html).toContain('Govern');
    expect(html).toContain('Changed the upstream of app.example.com');
    expect(html).toContain('Before the upgrade');
    expect(html).toContain('Today, Sat 3 Oct');
    expect(html).toContain('Yesterday, Fri 2 Oct');
    expect(html).toMatch(/Tue 29 Sept?</);
    expect(html).toContain('Manual');
    expect(html).toContain('System');
    expect(html).toContain('1 host · 1 field');
    expect(html).toContain('Approval request <span class="num">#13</span>');
    // The live version is selected by default and marked live.
    expect(buttonTag(html, '#212')).toContain('aria-pressed="true"');
    expect(buttonTag(html, '#211')).toContain('aria-pressed="false"');
    expect(html).toContain('>Live<');
    expect(html).toContain('Version #212');
    expect(html).toMatch(/<span class="num">1<\/span>–<span class="num">25<\/span> of <span class="num">40<\/span> versions/);
    expect(html).toContain('aria-label="Pages of versions"');
    expect(html).toContain('href="/history?page=2"');
  });

  it('shows recording, retention and the oldest version kept, and the actions the role allows', () => {
    const html = render();
    expect(html).toContain('Recording on');
    expect(html).not.toContain('No new versions are recorded');
    expect(html).toMatch(/oldest kept <span class="num">#13<\/span>/);
    expect(html).toContain('Save a version now');
    expect(html).toContain('Export or import');
    expect(html).toContain('Delete version');
    const readOnly = render({ allowed: { backups: false, export: false, import: false, write: false, restore: false } });
    expect(readOnly).not.toContain('Save a version now');
    expect(readOnly).not.toContain('Export or import');
    expect(readOnly).not.toContain('Delete version');
    // Without backups:read, no backups line linking to the Backups page.
    expect(html).toContain('href="/backups"');
    expect(readOnly).not.toContain('href="/backups"');
  });

  it('opens the version from the URL and links its change request', () => {
    const html = render({ initialVersionId: 207 });
    expect(html).toContain('Version #207');
    expect(html).toContain('href="/approvals?request=13"');
  });

  it('explains that a sync slave records no history', () => {
    const html = render({ isSlave: true });
    expect(html).toContain('This instance is a sync slave');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="A sync slave records no history"/);
  });

  it('has an empty state without versions', () => {
    const html = render({ versions: { versions: [], total: 0, limit: 25, offset: 0, liveId: null, recording: { enabled: false, retention: 200 } }, settings: { enabled: false, retention: 200 }, oldest: null });
    expect(html).toContain('No versions yet');
    expect(html).toContain('Recording off');
  });
});

const preview: RollbackPreview = {
  target: version(207),
  liveId: 212,
  identical: false,
  hosts: [
    { type: 'proxy_host', id: 12, name: 'app.example.com', kind: 'changed', fields: ['upstreams', 'meta.waf.excluded_rule_ids'] },
    { type: 'proxy_host', id: 14, name: 'new.example.com', kind: 'removed', fields: [] },
  ],
  settings: [{ key: 'waf', label: 'WAF', kind: 'changed', fields: ['enabled'] }],
  other: [],
  undoes: [{ id: 212, title: 'Changed the upstream of app.example.com', createdAt: '2026-10-03T10:58:00.000Z', actors: [{ userId: 2, name: 'l.bianchi' }], reason: 'auto', changeRequestIds: [] }],
  undoesUnrecordedChanges: true,
  sameHostWarnings: [{ versionId: 212, title: 'Changed the upstream of app.example.com', createdAt: '2026-10-03T10:58:00.000Z', actors: [{ userId: 2, name: 'l.bianchi' }], hosts: ['app.example.com'] }],
  blocked: {
    message: 'Approval policies protect hosts this rollback changes, so it would be refused.',
    hosts: [{ type: 'proxy_host', id: 12, name: 'app.example.com', operations: ['update'], policies: [{ id: 1, name: 'Production' }] }],
  },
  reload: { nodes: 3, instances: ['edge-2', 'edge-3'], heldBack: [] },
  canRestore: false,
  reasons: ['Protected by an approval policy: proxy host "app.example.com".'],
};

/** The opening tag of the button whose label is `label`. */
function buttonTag(html: string, label: string): string | undefined {
  return html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`, 's'))?.[0].match(/^<button[^>]*>/)?.[0];
}

function summary(overrides: Partial<RollbackPreview> = {}, target: VersionView = version(207), canRestore = true) {
  return renderToStaticMarkup(
    createElement(RollbackSummary, { version: target, preview: { ...preview, ...overrides }, canRestore, pending: false, onRollBack: vi.fn(), onShowLiveDiff: vi.fn() })
  );
}

describe('rollback preview', () => {
  it('lists the hosts that change, the later changes it undoes and the reload', () => {
    const html = summary();
    expect(html).toContain('Caddy reloads it on');
    expect(html).toContain('all 3 nodes');
    expect(html).toContain('Hosts that change');
    expect(html).toContain('upstreams, meta.waf.excluded_rule_ids');
    expect(html).toContain('Removed: it did not exist yet');
    expect(html).toContain('Settings › WAF');
    expect(html).toContain('Later changes it undoes');
    expect(html).toContain('they are undone');
    expect(html).toContain('Show the full diff against live');
  });

  it('warns about later changes to the same host and shows the policy refusal', () => {
    const html = summary();
    expect(html).toContain('A later change touched the same host');
    expect(html).toContain('This rollback is refused while approval policies protect these hosts');
    expect(html).toContain('policy Production (update)');
    // The policy reason is in the banner, not repeated in the reasons list.
    expect(html).not.toContain('Rolling back is not possible here');
    expect(buttonTag(html, 'Roll back to #207')).toContain('disabled=""');
  });

  it('enables the rollback when nothing refuses it', () => {
    const html = summary({ blocked: null, reasons: [], canRestore: true, sameHostWarnings: [] });
    expect(buttonTag(html, 'Roll back to #207')).toBeDefined();
    expect(buttonTag(html, 'Roll back to #207')).not.toContain('disabled=""');
    expect(html).not.toContain('A later change touched the same host');
  });

  it('says so for the live version and an identical one', () => {
    expect(summary({}, version(212, { live: true }))).toContain('This is the live configuration.');
    expect(summary({ identical: true, liveId: null })).toContain('This version matches the live configuration, so rolling back would change nothing.');
  });

  it('shows reasons other than the policy, such as a missing permission', () => {
    const html = summary({ blocked: null, canRestore: false, reasons: ['Rolling back needs the config_history:restore permission.'] });
    expect(html).toContain('Rolling back is not possible here');
    expect(html).toContain('config_history:restore');
  });
});

describe('history helpers', () => {
  it('groups by day in the time zone, with today and yesterday', () => {
    const groups = groupByDay(versions, NOW, 'UTC');
    // ICU spells September "Sep" or "Sept" depending on its version.
    expect(groups.map((group) => group.label.replace('Sept', 'Sep'))).toEqual(['Today, Sat 3 Oct', 'Yesterday, Fri 2 Oct', 'Tue 29 Sep']);
    expect(groups[0].items.map((item) => item.id)).toEqual([212, 211]);
    // Late on 2 October in UTC is already 3 October in Tokyo.
    expect(groupByDay([version(1, { createdAt: '2026-10-02T20:00:00.000Z' })], NOW, 'Asia/Tokyo')[0].label).toBe('Today, Sat 3 Oct');
    expect(groupByDay([version(1, { createdAt: '2025-12-30T12:00:00.000Z' })], NOW, 'UTC')[0].label).toBe('Tue 30 Dec 2025');
  });

  it('names actors and their initials', () => {
    expect(initials('j.moretti')).toBe('JM');
    expect(initials('admin')).toBe('AD');
    expect(initials('Alice Brown')).toBe('AB');
    expect(initials('ops@example.com')).toBe('OP');
    expect(describeActors([])).toBe('System');
    expect(describeActors([{ userId: 1, name: 'admin' }, { userId: 2, name: null }])).toBe('admin and User #2');
    expect(describeActors([{ userId: 1, name: 'a' }, { userId: 2, name: 'b' }, { userId: 3, name: 'c' }])).toBe('a and 2 others');
  });

  it('builds comparisons and reads the URL', () => {
    expect(parseCompareParam('live')).toBe('live');
    expect(parseCompareParam('207')).toBe(207);
    expect(parseCompareParam('previous')).toBe('previous');
    expect(parseCompareParam('0; drop')).toBe('previous');
    expect(compareQuery(212, 'live')).toBe('from=current&to=212');
    expect(compareQuery(212, 'previous')).toBe('from=previous&to=212');
    expect(compareQuery(212, 204)).toBe('from=204&to=212');
  });

  it('shows references with their names and keeps secrets masked', () => {
    expect(toDiffField({ path: 'accessListId', before: null, after: 4, beforeLabel: null, afterLabel: 'Media admins' })).toEqual({ path: 'accessListId', before: null, after: 'Media admins (#4)' });
    expect(toDiffField({ path: 'meta.password', secret: true })).toEqual({ path: 'meta.password', before: undefined, after: undefined, secret: true });
  });

  it('explains empty comparisons by reason', () => {
    expect(emptyCompareText(version(211, { reason: 'manual', title: 'Before the upgrade' }), 'previous', 210)).toBe(
      'No differences from #210. A manual version saves the configuration as it was, with the note “Before the upgrade”.'
    );
    expect(emptyCompareText(version(211), 'live', 210)).toBe('No differences: #211 matches the live configuration.');
    expect(emptyCompareText(version(211), 204, 210)).toBe('No differences between #204 and #211.');
  });

  it('describes hosts and filters the reasons the banners already show', () => {
    expect(describeRollbackHost({ type: 'proxy_host', id: 1, name: 'a', kind: 'added', fields: [] })).toBe('Added back');
    expect(remainingReasons({ ...preview, reasons: ['This version matches the running configuration: rolling back would change nothing.', 'x'] })).toEqual(['x']);
  });
});
