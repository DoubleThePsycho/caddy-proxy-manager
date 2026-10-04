/**
 * Server-side render of the Virtual patches section of the WAF page: the
 * feed status and subscription, each patch with its CVEs and mode, the
 * read-only view without a license (only turning off stays possible), the
 * replica view, and the warnings (WAF off, feed expired, no trusted key,
 * failed fetch).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { VirtualPatchesSection } from '@/ee/rule-feed/ui/VirtualPatchesSection';
import type { VirtualPatchingView, VirtualPatchView } from '@/ee/rule-feed/types';

function patch(overrides: Partial<VirtualPatchView> = {}): VirtualPatchView {
  return {
    id: 'ivp-2021-44228',
    title: 'Apache Log4j JNDI lookup injection (Log4Shell)',
    summary: 'Apache Log4j 2 evaluates lookups in the strings it logs.',
    cves: ['CVE-2021-44228', 'CVE-2021-45046'],
    severity: 'critical',
    affected: [{ product: 'Apache Log4j 2', versions: '2.0-beta9 to 2.15.0', fixed: '2.16.0' }],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2021-44228'],
    publishedAt: '2021-12-10T00:00:00Z',
    updatedAt: '2021-12-14T00:00:00Z',
    defaultMode: 'block',
    mode: 'detect',
    modeChangedAt: '2026-10-03T06:00:00.000Z',
    ruleIds: [1800000101],
    rules: ['SecRule ARGS "@rx jndi" "id:1800000101,phase:2"'],
    samples: { positive: [{ method: 'GET', path: '/?q=x' }], negative: [] },
    example: true,
    inspectsBody: true,
    withdrawnAt: null,
    firstSeenAt: '2026-10-03T06:00:00.000Z',
    feedSequence: 100,
    ...overrides,
  };
}

function view(overrides: Partial<VirtualPatchingView> = {}): VirtualPatchingView {
  return {
    settings: { subscribed: true, feedUrl: 'https://feed.ingres.si/v1/feed.json', autoBlockCritical: false },
    feed: {
      installed: {
        kid: '2026-10', sequence: 100, digest: 'a'.repeat(64), issuedAt: '2026-10-02T00:00:00.000Z', expiresAt: '2099-11-01T00:00:00.000Z',
        source: 'fetch', installedAt: '2026-10-03T06:00:00.000Z', packs: 2,
      },
      expired: false,
      lastCheck: { at: '2026-10-03T06:00:00.000Z', source: 'fetch', outcome: 'updated', error: null, sequence: 100, added: 2, updated: 0, withdrawn: 0 },
      trustedKeyIds: ['2026-10'],
    },
    patches: [patch(), patch({ id: 'ivp-2021-41773', cves: ['CVE-2021-41773'], title: 'Apache HTTP Server path traversal', severity: 'high', mode: 'block', withdrawnAt: '2026-10-03T00:00:00.000Z', example: false })],
    counts: { total: 2, detect: 1, block: 1, off: 0, withdrawn: 1 },
    configurable: true,
    editable: true,
    source: 'local',
    ...overrides,
  };
}

const render = (value: VirtualPatchingView, props: { canWrite?: boolean; wafInUse?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(VirtualPatchesSection, { view: value, canWrite: props.canWrite ?? true, editionLabel: 'Enterprise', wafInUse: props.wafInUse ?? true })
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('Virtual patches section', () => {
  it('shows the feed, the subscription and every patch with its mode', () => {
    const html = render(view());
    const page = text(html);
    expect(html).toContain('id="virtual-patches"');
    expect(page).toContain('Feed sequence 100, fetched 3 Oct 2026, 06:00 UTC, expires 1 Nov 2099');
    expect(page).toContain('Last fetch 3 Oct 2026, 06:00 UTC: 2 new, 0 updated, 0 withdrawn');
    expect(page).toContain('1 blocking, 1 detecting');
    expect(html).toContain('value="https://feed.ingres.si/v1/feed.json"');
    expect(page).toContain('Block new critical patches automatically');
    expect(page).toContain('CVE-2021-44228');
    expect(page).toContain('Withdrawn by the publisher');
    expect(page).toContain('Example');
    expect(html).toContain('id="virtual-patch-ivp-2021-44228"');
    expect(html).toMatch(/<div role="group" aria-label="Mode of CVE-2021-44228, CVE-2021-45046"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Detect</);
    expect(page).toContain('Import feed file');
    expect(page).toContain('Fetch now');
    expect(page).not.toContain('needs an active Enterprise license');
  });

  it('is read-only without the license, except turning patches and the subscription off', () => {
    const html = render(view({ configurable: false }));
    expect(text(html)).toContain('Virtual patching needs an active Enterprise license.');
    expect(html).toContain('href="/license"');
    expect(text(html)).not.toContain('Import feed file');
    // Off stays enabled; detect and block are disabled.
    expect(html).toMatch(/<button type="button" aria-pressed="false" class="[^"]*">Off<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="false" disabled=""[^>]*>Block<\/button>/);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Feed URL"|<input[^>]*aria-label="Feed URL"[^>]*disabled=""/);
  });

  it('shows a replica the master\'s patches without controls', () => {
    const html = render(view({ editable: false, source: 'master', feed: { installed: null, expired: false, lastCheck: null, trustedKeyIds: [] } }));
    const page = text(html);
    expect(page).toContain('This node is a sync replica.');
    expect(page).not.toContain('Fetch daily from');
    expect(page).not.toContain('trusts no feed signing key');
  });

  it('warns when no host runs the WAF, the feed expired, no key is trusted or the last fetch failed', () => {
    const page = text(
      render(
        view({
          feed: {
            ...view().feed,
            expired: true,
            trustedKeyIds: [],
            lastCheck: { at: '2026-10-04T06:00:00.000Z', source: 'fetch', outcome: 'failed', error: 'The feed URL answered with HTTP 503', sequence: null, added: 0, updated: 0, withdrawn: 0 },
          },
        }),
        { wafInUse: false }
      )
    );
    expect(page).toContain('No host runs the WAF, so no patch applies.');
    expect(page).toContain('The installed feed expired on 1 Nov 2099.');
    expect(page).toContain('This build trusts no feed signing key yet.');
    expect(page).toContain('Last fetch 4 Oct 2026, 06:00 UTC failed.');
    expect(page).toContain('The feed URL answered with HTTP 503. Nothing was changed.');
  });

  it('says how to start when there are no patches', () => {
    const page = text(render(view({ patches: [], counts: { total: 0, detect: 0, block: 0, off: 0, withdrawn: 0 }, feed: { ...view().feed, installed: null, lastCheck: null } })));
    expect(page).toContain('No virtual patches yet');
    expect(page).toContain('No feed installed yet');
    expect(page).toContain('Waiting for the first fetch');
  });
});
