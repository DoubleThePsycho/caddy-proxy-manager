/**
 * Server-side render of the WAF settings page (/waf): its sections, the
 * tuning shown as written, the per-host and exclusion tables, and the
 * read-only view for a role without waf:write.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/app/(dashboard)/waf/actions', () => ({
  saveWafSettingsAction: vi.fn(),
  setWafHostModeAction: vi.fn(),
  createWafExclusionAction: vi.fn(),
  deleteWafExclusionAction: vi.fn(),
  explainWafEventAction: vi.fn(),
}));

import WafSettingsClient from '@/app/(dashboard)/waf/WafSettingsClient';
import type { WafSettingsPageData } from '@/app/(dashboard)/waf/waf-settings-shared';

function data(overrides: Partial<WafSettingsPageData> = {}): WafSettingsPageData {
  return {
    settings: {
      enabled: false,
      mode: 'On',
      load_owasp_crs: true,
      custom_directives: 'SecRule REQUEST_HEADERS:User-Agent "@contains badbot" "id:9002,phase:1,deny,status:403,log"',
      paranoia_level: 2,
      detection_paranoia_level: 3,
      inbound_anomaly_threshold: 7,
    },
    savedAt: '2026-10-02T18:31:00.000Z',
    canWrite: true,
    analyticsEnabled: true,
    hosts: [
      {
        id: 1, name: 'Wiki', domains: ['wiki.example.com'], hostEnabled: true, mode: 'inherit', configured: true, rules: 'merge',
        effectiveMode: 'block', loadOwaspCrs: true, settings: 'merges', differences: ['1 rule exclusion'], exclusions: 1,
        events: { count: 73, blocked: 73 },
      },
      {
        id: 2, name: 'Grafana', domains: ['grafana.example.com'], hostEnabled: true, mode: 'detection_only', configured: true, rules: 'merge',
        effectiveMode: 'detection_only', loadOwaspCrs: true, settings: 'merges', differences: ['detection only'], exclusions: 0,
        events: { count: 1, blocked: 0 },
      },
      {
        id: 3, name: 'Mail', domains: ['mail.example.com'], hostEnabled: true, mode: 'inherit', configured: false, rules: 'merge',
        effectiveMode: 'off', loadOwaspCrs: false, settings: 'follows', differences: [], exclusions: 0,
        events: { count: 0, blocked: 0 },
      },
    ],
    exclusions: [
      {
        id: 4, ruleId: 942100, scope: 'host', proxyHostId: 1, host: { id: 1, name: 'Wiki', domains: ['wiki.example.com'] },
        pathMatch: null, path: null, variable: 'ARGS:content', reason: 'Runbook pages quote SQL queries', createdBy: { id: 1, name: 'admin' },
        createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z', ruleMessage: 'SQL Injection Attack Detected via libinjection',
      },
    ],
    week: {
      from: 1790400000,
      to: 1791004800,
      summary: { total: 5206, blocked: 5205, uniqueClientIps: 107, rules: 28, hosts: 7 },
      daily: [{ day: '2026-10-01', count: 1187, blocked: 1187 }],
      topRules: [{ ruleId: 930130, count: 2183, message: 'Restricted File Access Attempt' }],
    },
    droppedDirectives: [],
    ...overrides,
  };
}

const render = (value: WafSettingsPageData) => renderToStaticMarkup(createElement(WafSettingsClient, { data: value }));

describe('WAF settings page', () => {
  it('renders every section with the stored tuning', () => {
    const html = render(data());
    for (const heading of ['WAF settings', 'Global mode', 'Rule set', 'Request bodies', 'What the rules stopped', 'Per-host settings', 'Rule exclusions', 'Custom rules']) {
      expect(html).toContain(`>${heading}</h`);
    }
    expect(html).toContain('Written as tx.blocking_paranoia_level=2, tx.detection_paranoia_level=3, tx.inbound_anomaly_score_threshold=7, tx.outbound_anomaly_score_threshold=4');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>.*Blocking/);
    expect(html).toContain('Also log level <span class="font-mono">3</span> matches without blocking them');
    expect(html).toContain('1 rule, checked: nothing dropped');
  });

  it('lists hosts by mode and exclusions with scope, reason and author', () => {
    const html = render(data());
    expect(html).toContain('Blocking on 1 host, detection only on 1 host');
    expect(html).toContain('Runbook pages quote SQL queries');
    expect(html).toContain('ARGS:content');
    expect(html).toContain('aria-label="Remove exclusion of rule 942100 on wiki.example.com"');
    expect(html).toContain('Restricted File Access Attempt');
  });

  it('is read-only without waf:write', () => {
    const html = render(data({ canWrite: false }));
    expect(html).toContain('Changing them needs the WAF write permission');
    expect(html).not.toContain('Save and apply');
    expect(html).not.toContain('Add exclusion');
    expect(html).not.toContain('Remove exclusion');
  });

  it('renders before the WAF was ever set up and without analytics', () => {
    const html = render(data({ settings: null, savedAt: null, analyticsEnabled: false, hosts: [], exclusions: [] }));
    expect(html).toContain('No rule is excluded');
    expect(html).toContain('Event counts need ClickHouse analytics, which are off.');
  });
});
