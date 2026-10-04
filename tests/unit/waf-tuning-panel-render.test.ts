/**
 * Server-side render of the WAF page's "Tuning suggestions" panel.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/ee/ai/ui/tuning-actions', () => ({
  generateTuningSuggestionsAction: vi.fn(),
  applyTuningSuggestionAction: vi.fn(),
  dismissTuningSuggestionAction: vi.fn(),
}));

import TuningSuggestions from '@/ee/ai/ui/TuningSuggestions';
import type { WafTuningSuggestionView } from '@/ee/ai/types';

const suggestion: WafTuningSuggestionView = {
  id: '942100-0123456789ab',
  host: 'app.example.com',
  proxyHost: { id: 4, name: 'App' },
  ruleId: 942100,
  ruleMessage: 'SQL Injection Attack Detected via libinjection',
  ruleFamily: 'SQL injection',
  attackCritical: true,
  confidence: 'medium',
  score: 64,
  reasons: ['Matched 300 times for 40 different clients on 9 days'],
  exclusion: { type: 'host_rule_suppression', proxyHostId: 4, ruleId: 942100, description: 'Turn WAF rule 942100 off for every request to proxy host "App" (app.example.com).' },
  evidence: {
    windowDays: 14,
    events: 300,
    clients: 40,
    activeDays: 9,
    blockedEvents: 30,
    detectionOnlyEvents: 270,
    criticalEvents: 0,
    averageAnomalyScore: null,
    cleanClients: 38,
    normalClients: 35,
    firstSeen: '2026-09-20T00:00:00.000Z',
    lastSeen: '2026-10-02T09:00:00.000Z',
    pathPrefixes: [{ prefix: '/search', events: 300, clients: 40, examplePaths: ['/search', '<img src=x onerror=alert(1)>'] }],
  },
  explanation: { label: 'AI-generated risk assessment', text: 'The rule blocks SQL injection in search terms.' },
  status: 'open',
  generatedAt: '2026-10-02T10:00:00.000Z',
};

function render(canConfigure: boolean) {
  return renderToStaticMarkup(
    createElement(TuningSuggestions, { initialSuggestions: [suggestion], canConfigure, analyticsEnabled: true, aiConfigured: true })
  );
}

describe('Tuning suggestions panel', () => {
  it('shows evidence, the proposed exclusion and the labeled AI assessment', () => {
    const html = render(true);
    expect(html).toContain('Rule 942100');
    expect(html).toContain('medium confidence');
    expect(html).toContain('Critical attack class');
    expect(html).toContain('38 of 40');
    expect(html).toContain('90%');
    expect(html).toContain('Turn WAF rule 942100 off');
    expect(html).toContain('AI-generated risk assessment: </span>The rule blocks SQL injection');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('needs a license');
  });

  it('keeps stored suggestions visible but not actionable without a license', () => {
    const html = render(false);
    expect(html).toContain('needs a license that includes the AI analyst');
    expect(html).toContain('Rule 942100');
    expect(html.match(/<button[^>]*disabled=""[^>]*>Apply<\/button>/)).not.toBeNull();
  });
});
