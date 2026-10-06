/**
 * Server-side render of the Alerts page: the Community notice, firing alerts
 * and the last 7 days, the rules table, channels without credentials (paid
 * ones read-only but deletable), labelled AI text, the digest, read-only
 * roles, and the page's pure helpers (episodes, links, destinations).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/alerts',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/ee/alerting/ui/actions', () => ({
  saveAlertChannelAction: vi.fn(),
  deleteAlertChannelAction: vi.fn(),
  setAlertChannelEnabledAction: vi.fn(),
  testAlertChannelAction: vi.fn(),
  saveAlertRuleAction: vi.fn(),
  deleteAlertRuleAction: vi.fn(),
  setAlertRuleEnabledAction: vi.fn(),
  silenceAlertAction: vi.fn(),
  endAlertSilenceAction: vi.fn(),
  saveAiSettingsAction: vi.fn(),
  removeAiSettingsAction: vi.fn(),
  testAiProviderAction: vi.fn(),
}));
vi.mock('@/ee/ai/ui/digest-actions', () => ({
  saveDigestSettingsAction: vi.fn(),
  previewDigestAction: vi.fn(),
  sendDigestAction: vi.fn(),
}));

import AlertsClient, { type AlertsTab } from '@/ee/alerting/ui/AlertsClient';
import {
  auditLogAround,
  buildEpisodes,
  channelDestination,
  conditionLine,
  formatDuration,
  formatMinutes,
  subjectLink,
} from '@/ee/alerting/ui/format';
import type { AlertChannelView, AlertEventView, AlertRuleView, FiringAlertView } from '@/ee/alerting/types';
import type { DigestSettingsView } from '@/ee/ai/types';

const stamp = '2026-10-02T10:00:00.000Z';
const now = Date.parse('2026-10-02T11:00:00.000Z');
const channels: AlertChannelView[] = [
  { id: 1, name: 'Ops mail', type: 'email', enabled: true, config: { host: 'smtp.example.com', port: 587, secure: false, user: 'alerts', from: 'a@example.com', to: ['ops@example.com'], hasPassword: true }, lastDeliveryAt: stamp, lastDeliveryError: null, createdAt: stamp, updatedAt: stamp },
  { id: 2, name: 'Ops Slack', type: 'slack', enabled: true, config: { hasWebhookUrl: true, webhookUrlHint: 'https://hooks.slack.com' }, lastDeliveryAt: stamp, lastDeliveryError: 'The endpoint answered with HTTP 404', createdAt: stamp, updatedAt: stamp },
];
const rules: AlertRuleView[] = [
  { id: 1, name: 'Certificates', type: 'cert_expiring', enabled: true, params: { days: 14, includeClientCertificates: true }, channelIds: [1], cooldownMinutes: 1440, notifyOnResolve: true, explain: false, scope: { type: 'all' }, scopeLabel: 'All certificates, client certificates too', forMinutes: 0, firing: [], pending: [], lastFiredAt: null, mute: null, createdAt: stamp, updatedAt: stamp },
  { id: 2, name: 'Upstreams', type: 'upstream_down', enabled: true, params: { minFails: 1 }, channelIds: [2], cooldownMinutes: 60, notifyOnResolve: true, explain: true, scope: { type: 'hosts', proxyHostIds: [4] }, scopeLabel: 'Upstreams of 1 proxy host', forMinutes: 5, firing: [{ subjectKey: 'upstream:10.0.0.5:8080', title: 'Upstream 10.0.0.5:8080 failing', firedAt: stamp }], pending: [], lastFiredAt: stamp, mute: null, createdAt: stamp, updatedAt: stamp },
];
const events: AlertEventView[] = [
  { id: 1, ruleId: 2, ruleName: 'Upstreams', ruleType: 'upstream_down', subjectKey: 'upstream:10.0.0.5:8080', status: 'firing', severity: 'critical', title: 'Upstream 10.0.0.5:8080 is failing', message: 'Check it.', explanation: 'The backend stopped answering.', notified: true, deliveries: [{ channelId: 2, channelName: 'Ops Slack', ok: false, error: 'The endpoint answered with HTTP 404' }], createdAt: stamp, resolvedAt: null, silenced: null },
];
const firing: FiringAlertView[] = [
  { ruleId: 2, ruleName: 'Upstreams', ruleType: 'upstream_down', subjectKey: 'upstream:10.0.0.5:8080', severity: 'critical', title: 'Upstream 10.0.0.5:8080 is failing', message: 'Check it.', firedAt: stamp, deliveries: events[0].deliveries, silenced: null, eventId: 1, notifyOnResolve: true, dismissal: null, mute: null },
];

const digest: DigestSettingsView = {
  enabled: true,
  timeOfDay: '07:30',
  timeZone: 'Europe/Rome',
  channelIds: [2],
  ai: true,
  nextRunAt: '2026-10-03T05:30:00.000Z',
  lastRun: { at: stamp, trigger: 'scheduled', narrative: 'added', deliveries: [{ channelId: 2, channelName: 'Ops Slack', ok: true, error: null }] },
};

type Extra = {
  canWrite?: boolean;
  firing?: FiringAlertView[];
  rules?: AlertRuleView[];
  channels?: AlertChannelView[];
  history?: { events: AlertEventView[]; total: number; page: number; perPage: number };
};

function render(tab: AlertsTab, license = { alerting: false, aiAnalyst: false }, extra: Extra = {}) {
  return renderToStaticMarkup(
    createElement(AlertsClient, {
      initialTab: tab,
      channels: extra.channels ?? channels,
      rules: extra.rules ?? rules,
      firing: extra.firing ?? firing,
      recent: events,
      history: extra.history ?? { events, total: 1, page: 1, perPage: 25 },
      ai: { enabled: true, provider: 'anthropic', model: 'claude-opus-5', baseUrl: null, hasApiKey: true, configured: true, defaultModel: 'claude-opus-5' },
      digest,
      license,
      canWrite: extra.canWrite,
      proxyHosts: [{ id: 4, name: 'app.example.com' }],
      now,
    })
  );
}

describe('Alerts page', () => {
  it('explains the Community carve-out when unlicensed', () => {
    const html = render('firing');
    expect(html).toContain('Community includes e-mail channels');
    expect(html).toContain('can still be disabled or deleted');
    expect(html).toContain('href="/license"');
    expect(render('firing', { alerting: true, aiAnalyst: true })).not.toContain('Community includes e-mail channels');
  });

  it('shows the tabs with counts and the New rule button', () => {
    const html = render('firing');
    expect(html).toMatch(/role="tab"[^>]*>Firing <span[^>]*bg-warn-tint[^>]*>1<\/span>/);
    expect(html).toContain('New rule');
    expect(html).toMatch(/role="tab"[^>]*>AI</);
  });

  it('lists what is firing now and the last 7 days', () => {
    const html = render('firing');
    expect(html).toContain('Firing now');
    expect(html).toContain('Upstream 10.0.0.5:8080 is failing');
    expect(html).toContain('Critical');
    expect(html).toContain('Ops Slack: failed');
    // The paid rule cannot be changed without the license; with it, the card offers its editor.
    expect(html).not.toContain('Edit rule');
    expect(render('firing', { alerting: true, aiAnalyst: true })).toContain('Edit rule');
    expect(html).toContain('href="/proxy-hosts?search=10.0.0.5%3A8080"');
    expect(html).toContain('A resolve notice goes to the same channel');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('href="/alerts?tab=history"');
    // Collapsed: the AI text is only in the expanded row.
    expect(html).not.toContain('The backend stopped answering.');
  });

  it('says when nothing is firing', () => {
    expect(render('firing', undefined, { firing: [] })).toContain('Nothing is firing');
  });

  it('shows rules with scope, duration, severity, channels and when they fired', () => {
    const html = render('rules');
    expect(html).toMatch(/<span class="num">2<\/span> of <span class="num">2<\/span> enabled/);
    expect(html).toContain('Certificate expiring · Within 14 days · cooldown 24 h · notice when it clears');
    expect(html).toContain('All certificates, client certificates too');
    expect(html).toContain('Upstreams of 1 proxy host');
    expect(html).toContain('At once');
    expect(html).toContain('5 min');
    expect(html).toContain('critical under 3 days');
    expect(html).toContain('AI explanation');
    expect(html).toContain('Firing (1) since');
    expect(html).toContain('Never');
    // The paid rule is read-only without a license but can still be deleted.
    expect(html).toMatch(/title="Needs a license with Alerting"[^>]*aria-label="Edit rule Upstreams"/);
    expect(html.match(/title="Delete"/g)?.length).toBe(2);
  });

  it('lists channels without credentials and keeps paid ones read-only but deletable', () => {
    const html = render('channels');
    expect(html).toContain('smtp.example.com:587');
    expect(html).toContain('STARTTLS when offered · to ops@example.com');
    expect(html).toContain('hooks.slack.com');
    expect(html).toContain('Incoming webhook, URL stored');
    expect(html).toContain('The endpoint answered with HTTP 404');
    expect(html).toContain('Ops Slack could not deliver');
    expect(html).toContain('1 rule');
    expect(html.match(/title="Needs a license with Alerting"/g)?.length).toBe(2); // test + edit of the Slack channel
    expect(html.match(/title="Delete"/g)?.length).toBe(2);
    // The failing Slack channel is paid: its banner offers no Edit button without a license.
    expect(html).not.toContain('Edit Ops Slack');
    expect(render('channels', { alerting: true, aiAnalyst: true })).toContain('Edit Ops Slack');
    expect(html).not.toContain('hasPassword');
  });

  it('labels AI explanations in the history', () => {
    const html = render('history');
    expect(html).toContain('Alert history');
    expect(html).toContain('AI-generated explanation');
    expect(html).toContain('The backend stopped answering.');
    expect(html).toContain('Ops Slack: failed');
    expect(html).toContain('Firing alerts');
    // One page: no pager.
    expect(html).not.toContain('aria-label="Pages of alert history"');
  });

  it('pages the history with the shared pager, linking each page', () => {
    const html = render('history', undefined, { history: { events, total: 60, page: 2, perPage: 25 } });
    expect(html).toContain('aria-label="Pages of alert history"');
    expect(html.replace(/<[^>]+>/g, '')).toContain('26–50 of 60 alerts');
    expect(html).toContain('href="/alerts?tab=history"');
    expect(html).toContain('href="/alerts?tab=history&amp;page=3"');
  });

  it('searches and pages the rules and the channels', () => {
    const manyRules = Array.from({ length: 30 }, (_, i) => ({ ...rules[0], id: 100 + i, name: `Rule ${i}` }));
    const rulesHtml = render('rules', { alerting: true, aiAnalyst: true }, { rules: manyRules });
    expect(rulesHtml).toContain('aria-label="Search rules"');
    expect(rulesHtml).toContain('aria-label="Pages of rules"');
    expect(rulesHtml.replace(/<[^>]+>/g, '')).toContain('1–25 of 30 rules');
    expect(rulesHtml.match(/aria-label="Edit rule /g)?.length).toBe(25);

    const manyChannels = Array.from({ length: 27 }, (_, i) => ({ ...channels[0], id: 100 + i, name: `Mail ${i}` }));
    const channelsHtml = render('channels', { alerting: true, aiAnalyst: true }, { channels: manyChannels });
    expect(channelsHtml).toContain('aria-label="Search channels"');
    expect(channelsHtml).toContain('aria-label="Pages of channels"');
    expect(channelsHtml.replace(/<[^>]+>/g, '')).toContain('1–25 of 27 channels');
  });

  it('is read-only without alerts:write', () => {
    const html = render('rules', { alerting: true, aiAnalyst: true }, { canWrite: false });
    expect(html).not.toContain('New rule');
    expect(html).not.toContain('title="Delete"');
    const channelsHtml = render('channels', { alerting: true, aiAnalyst: true }, { canWrite: false });
    expect(channelsHtml).not.toContain('Add channel');
    expect(channelsHtml).not.toContain('Send test');
  });

  it('offers to remove the AI provider without a license', () => {
    const html = render('ai');
    expect(html).toContain('Remove provider');
    expect(html).toContain('Setting up the AI analyst needs a license');
    expect(html).not.toContain('sk-');
  });

  it('shows the digest read-only without a license, with a way to turn it off', () => {
    const html = render('ai');
    expect(html).toContain('Daily security digest');
    expect(html).toContain('Setting up the digest needs a license');
    expect(html).toContain('Turn off');
    expect(html).toContain('value="Europe/Rome"');
    expect(html).toContain('Ops Slack delivered');
    expect(html).toContain('with AI summary');
    // PagerDuty channels are never offered for digests; the e-mail and Slack channels are.
    expect(html).toContain('Ops mail');
  });

  it('lets a licensed admin configure, preview and send the digest', () => {
    const html = render('ai', { alerting: true, aiAnalyst: true });
    expect(html).not.toContain('Setting up the digest needs a license');
    expect(html).not.toContain('Turn off');
    expect(html).toContain('Preview');
    expect(html).toContain('Send now');
  });
});

describe('Alerts page helpers', () => {
  it('pairs firing events with the resolve event that ended them, within the window', () => {
    const fired = '2026-10-02T09:02:00.000Z';
    const resolvedAt = '2026-10-02T09:04:00.000Z';
    const list: AlertEventView[] = [
      { ...events[0], id: 11, status: 'resolved', severity: 'info', createdAt: resolvedAt, notified: true, deliveries: [{ channelId: 2, channelName: 'Ops Slack', ok: true, error: null }], resolvedAt: null },
      { ...events[0], id: 10, createdAt: fired, resolvedAt },
      { ...events[0], id: 3, createdAt: '2026-09-20T09:00:00.000Z', resolvedAt: null },
    ];
    const episodes = buildEpisodes(list, Date.parse('2026-09-25T00:00:00.000Z'));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ id: 10, severity: 'critical', firedAt: fired, resolvedAt, resolve: { at: resolvedAt, notified: true } });
    expect(episodes[0].resolve!.deliveries).toEqual([{ channelId: 2, channelName: 'Ops Slack', ok: true, error: null }]);
  });

  it('formats durations and cooldowns', () => {
    expect(formatDuration(30_000)).toBe('under 1 min');
    expect(formatDuration(2 * 60_000)).toBe('2 min');
    expect(formatDuration(80 * 60_000)).toBe('1 h 20 min');
    expect(formatDuration(4 * 24 * 3_600_000)).toBe('4 days');
    expect(formatMinutes(0)).toBe('no cooldown');
    expect(formatMinutes(15)).toBe('15 min');
    expect(formatMinutes(1440)).toBe('24 h');
    expect(formatMinutes(7 * 1440)).toBe('7 days');
    expect(conditionLine({ ...rules[0], notifyOnResolve: false, cooldownMinutes: 0 })).toBe('Certificate expiring · Within 14 days · no cooldown');
  });

  it('links subjects to where they can be looked at, never to hosts it cannot name', () => {
    const names = new Map([[4, 'app.example.com']]);
    expect(subjectLink('proxy_host:4', names)?.href).toBe('/proxy-hosts?search=app.example.com');
    expect(subjectLink('proxy_host:9', names)).toBeNull();
    expect(subjectLink('change_request:7', names)?.href).toBe('/approvals?request=7');
    expect(subjectLink('waf', names)?.href).toBe('/security');
    expect(subjectLink('caddy', names)).toBeNull();
    expect(auditLogAround('2026-10-02T09:00:00.000Z', '2026-10-02T09:10:00.000Z')).toBe(
      '/audit-log?from=2026-10-02T08%3A30%3A00.000Z&to=2026-10-02T09%3A40%3A00.000Z'
    );
  });

  it('describes destinations by host only', () => {
    expect(channelDestination({ ...channels[1], config: { hasWebhookUrl: true, webhookUrlHint: 'https://hooks.slack.com' } })).toEqual({
      target: 'hooks.slack.com',
      detail: 'Incoming webhook, URL stored',
    });
    expect(channelDestination({ ...channels[0], type: 'pagerduty', config: { region: 'eu', hasRoutingKey: true } }).target).toBe('Events API v2, EU region');
    expect(channelDestination({ ...channels[0], type: 'ntfy', config: { serverUrl: 'https://ntfy.example.com', topic: 'edge', hasToken: false } })).toEqual({
      target: 'ntfy.example.com',
      detail: 'Topic edge · no access token',
    });
  });
});
