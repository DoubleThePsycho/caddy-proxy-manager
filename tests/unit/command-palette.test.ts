/**
 * The command palette (src/components/command-palette/CommandPalette.tsx)
 * and the pure helpers it uses on search results (src/lib/search-results.ts):
 * match highlighting, grouping, the recent list read back from browser
 * storage, and the panel's markup and ARIA wiring. Also the OpenAPI entry of
 * GET /api/v1/search.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import {
  CommandPalettePanel,
  orderPaletteItems,
  useCommandPalette,
  type PaletteItem,
} from '@/src/components/command-palette/CommandPalette';
import {
  groupSearchResults,
  MAX_RECENT_ITEMS,
  normalizeSearchQuery,
  rememberRecent,
  sanitizeRecentItems,
  splitMatch,
  type SearchResult,
} from '@/src/lib/search-results';
import { matchRank } from '@/src/lib/search';
import { DOCUMENTATION_URL, documentationUrl } from '@/src/lib/brand';
import { GET as openApi } from '@/app/api/v1/openapi.json/route';

function result(overrides: Partial<SearchResult> & Pick<SearchResult, 'id' | 'group' | 'title'>): SearchResult {
  return { kind: 'page', subtitle: null, href: '/', external: false, mono: false, run: null, verb: 'Open', ...overrides };
}

const HOST = result({ id: 'proxy_host:1', group: 'hosts', kind: 'proxy_host', title: 'app.example.com', subtitle: 'Proxy host', href: '/proxy-hosts?search=app.example.com', mono: true });
const ACTION = result({ id: 'action:apply-config', group: 'actions', kind: 'action', title: 'Apply the configuration to Caddy', href: '/settings', run: 'apply_config', verb: 'Run' });
const PAGE = result({ id: 'page:/analytics', group: 'pages', title: 'Analytics', href: '/analytics', subtitle: 'Observe' });
const DOC = result({ id: 'doc:mfa', group: 'docs', kind: 'doc', title: 'Multi-factor authentication', href: documentationUrl('documentation/mfa.md'), external: true, verb: 'Read' });

describe('search result helpers', () => {
  it('normalises the query', () => {
    expect(normalizeSearchQuery('  app   example ')).toBe('app example');
    expect(normalizeSearchQuery(null)).toBe('');
    expect(normalizeSearchQuery('x'.repeat(500))).toHaveLength(100);
  });

  it('splits a title around the first case-insensitive match', () => {
    expect(splitMatch('email.example.com', 'EXAMPLE')).toEqual({ pre: 'email.', hit: 'example', post: '.com' });
    expect(splitMatch('Analytics', '')).toEqual({ pre: 'Analytics', hit: '', post: '' });
    expect(splitMatch('Analytics', 'zzz')).toEqual({ pre: 'Analytics', hit: '', post: '' });
  });

  it('groups results in the palette order and drops empty groups', () => {
    const grouped = groupSearchResults([DOC, PAGE, ACTION, HOST]);
    expect(grouped.map((group) => group.title)).toEqual(['Hosts', 'Actions', 'Go to', 'Documentation']);
    expect(grouped[0].results).toEqual([HOST]);
  });

  it('ranks text matches: title prefix, then title, then every word anywhere', () => {
    expect(matchRank('geo', 'Global Geoblocking', ['geo', 'country'])).toBe(1);
    expect(matchRank('glob', 'Global Geoblocking')).toBe(0);
    expect(matchRank('country', 'Global Geoblocking', ['geo', 'country'])).toBe(2);
    expect(matchRank('block country', 'Global Geoblocking', ['country'])).toBe(2);
    expect(matchRank('stripe', 'Global Geoblocking', ['country'])).toBeNull();
  });

  it('keeps only safe recent items read back from browser storage', () => {
    const stored = [
      { id: 'page:/analytics', kind: 'page', title: 'Analytics', href: '/analytics' },
      { id: 'page:/analytics', kind: 'page', title: 'Duplicate', href: '/analytics' },
      { id: 'x1', kind: 'page', title: 'Elsewhere', href: '//evil.example.com/' },
      { id: 'x2', kind: 'page', title: 'Script', href: 'javascript:alert(1)' },
      { id: 'x3', kind: 'page', title: 'Other site', href: 'https://example.com/' },
      { id: 'x4', kind: 'page', title: 'Backslash', href: '/\\evil.example.com' },
      { id: 'x5', kind: 'unknown', title: 'Bad kind', href: '/' },
      { id: 'x6', kind: 'page', title: '   ', href: '/' },
      'not an object',
      { id: 'doc:mfa', kind: 'doc', title: 'Multi-factor authentication', href: documentationUrl('documentation/mfa.md'), external: false, mono: 'yes' },
    ];
    const items = sanitizeRecentItems(stored, DOCUMENTATION_URL);
    expect(items.map((item) => item.id)).toEqual(['page:/analytics', 'doc:mfa']);
    expect(items[1]).toMatchObject({ external: true, mono: false });
    expect(sanitizeRecentItems('nope', DOCUMENTATION_URL)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `page:${i}`, kind: 'page', title: `Page ${i}`, href: `/p${i}` }));
    expect(sanitizeRecentItems(many, DOCUMENTATION_URL)).toHaveLength(MAX_RECENT_ITEMS);
  });

  it('moves an opened result to the front of the recent list and never remembers client-run actions', () => {
    const first = rememberRecent([], PAGE);
    const second = rememberRecent(first, HOST);
    expect(second.map((item) => item.id)).toEqual(['proxy_host:1', 'page:/analytics']);
    expect(rememberRecent(second, PAGE).map((item) => item.id)).toEqual(['page:/analytics', 'proxy_host:1']);
    expect(rememberRecent(second, ACTION)).toEqual(second);
    expect(Object.keys(second[0]).sort()).toEqual(['external', 'href', 'id', 'kind', 'mono', 'title']);
  });

  it('puts recent items first and leaves suggestions already listed there out', () => {
    const items = orderPaletteItems([ACTION, PAGE], [{ id: PAGE.id, kind: 'page', title: PAGE.title, href: PAGE.href, external: false, mono: false }]);
    expect(items.map((item) => `${item.group}:${item.id}`)).toEqual(['recent:page:/analytics', 'actions:action:apply-config']);
    expect(items[0].subtitle).toBe('Page');
  });
});

function panel(items: PaletteItem[], props: Partial<Parameters<typeof CommandPalettePanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(CommandPalettePanel, {
      idPrefix: 'p',
      query: 'example',
      items,
      activeIndex: 0,
      status: 'idle',
      onQueryChange: () => {},
      onClear: () => {},
      ...props,
    })
  );
}

describe('command palette panel', () => {
  it('wires the combobox to the listbox and the selected option', () => {
    const html = panel(orderPaletteItems([HOST, ACTION]));
    expect(html).toContain('<label for="p-query" class="sr-only">Search hosts, actions, settings and documentation</label>');
    expect(html).toMatch(/<input[^>]*id="p-query"[^>]*role="combobox"[^>]*aria-expanded="true"[^>]*aria-controls="p-results"[^>]*aria-autocomplete="list"[^>]*aria-activedescendant="p-option-0"/);
    expect(html).toContain('id="p-results" role="listbox" aria-label="Results"');
    expect(html).toMatch(/role="group" aria-labelledby="p-group-hosts"/);
    expect(html).toMatch(/<div id="p-group-hosts"[^>]*><span>Hosts<\/span>/);
    expect(html).toMatch(/id="p-option-0" href="\/proxy-hosts\?search=app.example.com" role="option" aria-selected="true"/);
    expect(html).toMatch(/id="p-option-1" href="\/settings" role="option" aria-selected="false"/);
    expect(html).toMatch(/<span class="ml-auto" role="status">2 results<\/span>/);
  });

  it('highlights the matched part, shows hosts in mono and the verb on the selected row', () => {
    const html = panel(orderPaletteItems([HOST, ACTION]));
    expect(html).toMatch(/<span class="[^"]*\bnum\b[^"]*">app\.<span class="font-bold underline[^"]*">example<\/span>\.com<\/span>/);
    expect(html).toMatch(/Open<kbd[^>]*>↵<\/kbd>/);
    expect(html).not.toMatch(/Run<kbd/);
    expect(panel(orderPaletteItems([HOST, ACTION]), { activeIndex: 1 })).toMatch(/Run<kbd[^>]*>↵<\/kbd>/);
  });

  it('opens documentation in a new tab', () => {
    const html = panel(orderPaletteItems([DOC]), { query: 'factor' });
    expect(html).toContain(`href="${documentationUrl('documentation/mfa.md')}"`);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it('says when nothing matches and offers to clear the query', () => {
    const html = panel([], { query: 'zzz' });
    expect(html).toContain('Nothing matches “zzz”. Try a host name, an action or a setting.');
    expect(html).toContain('>Clear the search</button>');
    expect(html).toContain('0 results');
    expect(panel([], { query: 'zzz', status: 'loading' })).not.toContain('Nothing matches');
    expect(panel([], { query: '', status: 'loading' })).toContain('Searching…');
  });

  it('keeps the results and shows the error when a search fails', () => {
    const html = panel(orderPaletteItems([HOST]), { status: 'error', error: 'The search failed (500)' });
    expect(html).toContain('app.');
    expect(html).toContain('The search failed (500). Results may be out of date');
  });

  it('is a no-op outside the provider', () => {
    let api: ReturnType<typeof useCommandPalette> | null = null;
    renderToStaticMarkup(createElement(() => { api = useCommandPalette(); return null; }));
    expect(() => api!.open('x')).not.toThrow();
    expect(() => api!.close()).not.toThrow();
  });
});

describe('OpenAPI: search', () => {
  it('documents GET /api/v1/search and every reference resolves', async () => {
    const doc = await (await openApi({ headers: { get: () => null } } as never)).json();
    const operation = doc.paths['/api/v1/search'].get;
    expect(Object.keys(doc.paths['/api/v1/search'])).toEqual(['get']);
    expect(operation.tags).toEqual(['Search']);
    expect(operation.parameters.map((p: { name: string }) => p.name)).toEqual(['q']);
    expect(operation.description).toMatch(/limited to what the caller's role can read/);
    expect(doc.tags.map((tag: { name: string }) => tag.name)).toContain('Search');
    const documented = JSON.stringify([operation, doc.components.schemas.SearchResponse, doc.components.schemas.SearchResult]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], doc), ref).toBeDefined();
    }
    expect(doc.components.schemas.SearchResult.properties.group.enum).not.toContain('recent');
  });
});
