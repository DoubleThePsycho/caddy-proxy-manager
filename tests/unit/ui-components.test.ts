/**
 * Shared layout and feedback components of the redesign
 * (src/components/ui): rendered to static markup to check their structure,
 * labels and accessibility attributes.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { PageHeader } from '@/components/ui/PageHeader';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { FilterBar, FilterChip } from '@/components/ui/FilterBar';
import { StatusDot } from '@/components/ui/StatusDot';
import { ProtectionPill } from '@/components/ui/ProtectionPill';
import { Banner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionCard } from '@/components/ui/SectionCard';
import { DiffView } from '@/components/ui/DiffView';
import { Checklist } from '@/components/ui/Checklist';
import { SearchField } from '@/components/ui/SearchField';
import { diffLines } from '@/components/ui/diff';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

/** The text of the markup, tags removed and whitespace collapsed. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('PageHeader', () => {
  it('keeps the original title, description and action props working', () => {
    const html = render(h(PageHeader, { title: 'Proxy hosts', description: 'Domains and where they go.', action: { label: 'Create Host', onClick: () => {} } }));
    expect(html).toMatch(/<h1[^>]*>Proxy hosts<\/h1>/);
    expect(html).toContain('Domains and where they go.');
    expect(html).toMatch(/<button[^>]*>.*Create Host<\/button>/);
  });

  it('renders the breadcrumb as navigation, the count and the actions', () => {
    const html = render(
      h(PageHeader, {
        title: 'Proxy hosts',
        breadcrumb: [{ label: 'Traffic', href: '/proxy-hosts' }, 'Proxy hosts'],
        count: 1250,
        actions: h('a', { href: '/proxy-hosts?create=1' }, 'New proxy host'),
        children: h('div', { 'data-testid': 'tabs' }, 'tabs'),
      })
    );
    expect(html).toContain('<nav aria-label="Breadcrumb">');
    expect(html).toMatch(/<a [^>]*href="\/proxy-hosts"[^>]*>Traffic<\/a>/);
    expect(html).toContain('<li aria-hidden="true" class="select-none">/</li>');
    expect(html).toContain('aria-current="page">Proxy hosts</span>');
    expect(html).toMatch(/<span class="num[^"]*">1,250<\/span>/);
    expect(html).toContain('New proxy host');
    expect(html).toContain('data-testid="tabs"');
  });

  it('leaves out the count when it is empty', () => {
    expect(render(h(PageHeader, { title: 'Alerts', count: null }))).not.toContain('class="num');
  });
});

describe('SegmentedControl', () => {
  it('labels the group and marks the pressed option', () => {
    const html = render(
      h(SegmentedControl, {
        label: 'Time range',
        value: '24h',
        onChange: () => {},
        mono: true,
        options: [{ value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d', disabled: true }],
      })
    );
    expect(html).toContain('role="group" aria-label="Time range"');
    expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*>1h<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="true"[^>]*bg-raise[^>]*>24h<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="false" disabled=""[^>]*>7d<\/button>/);
  });
});

describe('FilterChip and FilterBar', () => {
  it('reads dimension, operator and value, with a labelled remove button', () => {
    const html = render(h(FilterChip, { dimension: 'Host', operator: 'is', value: 'app.example.com', onRemove: () => {} }));
    expect(text(html)).toBe('Host is app.example.com');
    expect(html).toContain('aria-label="Remove filter: Host is app.example.com"');
    expect(html).toContain('text-brand');
    const excluded = render(h(FilterChip, { dimension: 'Country', operator: 'is not', value: 'CN' }));
    expect(excluded).toContain('text-waf-ink');
    expect(excluded).not.toContain('Remove filter');
  });

  it('shows chips with dimension labels, the add button and the trailing slot', () => {
    const html = render(
      h(FilterBar, {
        filters: [{ dimension: 'host', operator: 'is', value: 'app.example.com' }],
        dimensions: [{ key: 'host', label: 'Host' }, { key: 'country', label: 'Country' }],
        onAdd: () => {},
        onRemove: () => {},
        trailing: h('a', { href: '#save' }, 'Save view'),
      })
    );
    expect(html).toContain('role="group" aria-label="Filters"');
    expect(html).toContain('aria-label="Remove filter: Host is app.example.com"');
    expect(html).toContain('Add filter');
    expect(html).toContain('Save view');
  });

  it('has no add button without onAdd', () => {
    const html = render(h(FilterBar, { filters: [], dimensions: [{ key: 'host', label: 'Host' }] }));
    expect(html).not.toContain('Add filter');
  });
});

describe('StatusDot and ProtectionPill', () => {
  it('tints warn and bad labels and keeps healthy in the body colour', () => {
    expect(render(h(StatusDot, { tone: 'ok', label: 'Healthy' }))).toContain('text-foreground');
    expect(render(h(StatusDot, { tone: 'warn', label: 'Degraded' }))).toContain('text-warn');
    expect(render(h(StatusDot, { tone: 'bad', label: 'Down' }))).toContain('bg-bad');
    expect(render(h(StatusDot, { tone: 'off', srLabel: 'Disabled' }))).toContain('<span class="sr-only">Disabled</span>');
  });

  it('colours the protection dot by kind or by a given colour', () => {
    expect(render(h(ProtectionPill, { kind: 'waf', label: 'WAF · Block' }))).toContain('bg-waf');
    expect(render(h(ProtectionPill, { kind: 'rate-limit', label: 'Rate limit' }))).toContain('bg-rl');
    expect(render(h(ProtectionPill, { color: 'var(--served)', label: 'mTLS' }))).toContain('background:var(--served)');
  });
});

describe('Banner', () => {
  it.each([
    ['ok', 'bg-ok-tint', 'text-ok'],
    ['info', 'bg-brand-tint', 'text-brand'],
    ['warn', 'bg-warn-tint', 'text-warn'],
    ['bad', 'bg-bad-tint', 'text-bad'],
    ['neutral', 'bg-panel2', 'text-muted-foreground'],
  ] as const)('tints the whole box for %s', (tone, box, icon) => {
    const html = render(h(Banner, { tone, title: 'stage-1 drifted.' }, 'Drift is never repaired automatically.'));
    expect(html).toContain(box);
    expect(html).toContain(icon);
    expect(html).not.toMatch(/border-l-|border-l\b/);
    expect(text(html)).toBe('stage-1 drifted. Drift is never repaired automatically.');
  });

  it('is a live region only when asked', () => {
    expect(render(h(Banner, { tone: 'bad', title: 'x' }))).not.toContain('role=');
    expect(render(h(Banner, { tone: 'bad', title: 'x', live: true }))).toContain('role="alert"');
    expect(render(h(Banner, { tone: 'ok', title: 'x', live: true }))).toContain('role="status"');
    expect(render(h(Banner, { tone: 'neutral', title: 'x', live: true }))).toContain('role="status"');
  });

  it('renders actions and a dismiss button', () => {
    const html = render(h(Banner, { tone: 'warn', title: 'x', actions: h('button', { type: 'button' }, 'Re-sync stage-1'), onDismiss: () => {} }));
    expect(html).toContain('Re-sync stage-1');
    expect(html).toContain('aria-label="Dismiss"');
  });
});

describe('EmptyState', () => {
  it('shows the title, description and action', () => {
    const html = render(h(EmptyState, { title: 'No proxy hosts yet', description: 'Send a domain to a service.', action: h('a', { href: '/proxy-hosts?create=1' }, 'New proxy host') }));
    expect(html).toMatch(/<h2[^>]*>No proxy hosts yet<\/h2>/);
    expect(html).toContain('Send a domain to a service.');
    expect(html).toContain('New proxy host');
    expect(render(h(EmptyState, { title: 'Nothing', compact: true }))).toMatch(/<h3[^>]*>Nothing<\/h3>/);
  });
});

describe('SectionCard', () => {
  it('is a section labelled by its heading, with a link on the right', () => {
    const html = render(h(SectionCard, { title: 'Recent changes', count: 4, link: { label: 'Audit log', href: '/audit-log' } }, h('ul', null)));
    const id = /<h2 id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<section aria-labelledby="${id}"`);
    expect(html).toMatch(/<a [^>]*href="\/audit-log"[^>]*>Audit log<\/a>/);
    expect(html).toMatch(/<span class="num[^"]*">4<\/span>/);
  });

  it('takes an action as its link, rendered as a button', () => {
    const html = render(h(SectionCard, { title: 'Rules', link: { label: 'Show all', onClick: () => {} } }));
    expect(html).toMatch(/<button type="button" class="[^"]*text-brand[^"]*">Show all<\/button>/);
    expect(html).not.toContain('<a ');
  });

  it('puts the description inline by default, or on its own line under the title', () => {
    const inline = render(h(SectionCard, { title: 'Accent colour', description: 'Buttons and links.' }));
    expect(inline).toMatch(/<\/h2><span class="text-\[13px\] text-soft">Buttons and links.<\/span>/);
    const below = render(h(SectionCard, { title: 'Accent colour', description: 'Buttons and links.', descriptionPlacement: 'below', count: 2, actions: h('button', { type: 'button' }, 'Edit') }));
    expect(below).toMatch(/<\/h2><span class="num[^"]*">2<\/span><\/div><p class="[^"]*text-soft[^"]*">Buttons and links.<\/p>/);
    expect(below).toContain('>Edit</button>');
  });
});

describe('SearchField', () => {
  it('is at most 320px wide unless the caller sizes it', () => {
    expect(render(h(SearchField, { 'aria-label': 'Search' }))).toContain('class="relative max-w-xs"');
    expect(render(h(SearchField, { 'aria-label': 'Search', className: 'mb-2' }))).toContain('class="relative max-w-xs mb-2"');
    for (const className of ['w-full', 'sm:w-72', 'flex-1', 'max-w-md', 'flex-[1_1_280px]', 'basis-1/2']) {
      expect(render(h(SearchField, { 'aria-label': 'Search', className })), className).not.toContain('max-w-xs');
    }
  });
});

describe('DiffView', () => {
  const lines = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);

  it('shows a unified diff with signs and screen-reader prefixes', () => {
    const html = render(h(DiffView, { lines }));
    expect(html).toContain('<caption class="sr-only">Changes</caption>');
    expect(html).toContain('<span class="sr-only">Removed: </span>');
    expect(html).toContain('<span class="sr-only">Added: </span>');
    expect(html).toContain('bg-bad-tint');
    expect(html).toContain('bg-ok-tint');
    expect(html).toContain('−');
  });

  it('shows the two sides next to each other in split mode', () => {
    const html = render(h(DiffView, { lines, mode: 'split', beforeLabel: '#209', afterLabel: '#210', showModeToggle: true }));
    expect(html).toContain('>#209</th>');
    expect(html).toContain('>#210</th>');
    expect(html).toContain('aria-label="Diff layout"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Side by side/);
    // b and x share one row.
    expect(html).toMatch(/b<\/span><\/td><td[^>]*>2<\/td><td[^>]*>.*x<\/span>/);
  });

  it('folds long unchanged runs into a button', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = before.map((line, i) => (i === 15 ? 'changed' : line));
    const html = render(h(DiffView, { lines: diffLines(before, after) }));
    expect(html).toContain('12 unchanged lines');
    expect(html).toContain('11 unchanged lines');
    expect(html).not.toContain('>line 1<');
  });

  it('diffs two JSON values regardless of key order', () => {
    const html = render(h(DiffView, { before: { b: 1, a: { waf: false } }, after: { a: { waf: true }, b: 1 } }));
    expect(html).toContain('&quot;waf&quot;: false');
    expect(html).toContain('&quot;waf&quot;: true');
    expect(render(h(DiffView, { before: { b: 1, a: 2 }, after: { a: 2, b: 1 } }))).toContain('No changes');
  });

  it('shows field changes, hiding secret values', () => {
    const fields = [
      { path: 'enabled', before: false, after: true },
      { path: 'upstreams', after: ['10.0.0.1:80'] },
      { path: 'authentik.token', secret: true },
    ];
    const unified = render(h(DiffView, { fields }));
    expect(unified).toContain('Secret value changed (not shown)');
    expect(unified).toContain('[&quot;10.0.0.1:80&quot;]');
    expect((unified.match(/>upstreams</g) ?? []).length).toBe(1);
    const split = render(h(DiffView, { fields, mode: 'split' }));
    expect(split).toContain('>Field</th>');
    expect(split).toContain('(not set)');
  });

  it('says when nothing changed', () => {
    expect(render(h(DiffView, { lines: [], emptyText: 'No differences.' }))).toContain('No differences.');
    expect(render(h(DiffView, { fields: [] }))).toContain('No changes');
  });
});

describe('Checklist', () => {
  it('counts done steps and marks each step', () => {
    const html = render(
      h(Checklist, {
        title: 'Set up this install',
        items: [
          { id: 'dns', label: 'Point a domain at this server', done: true },
          { id: 'host', label: 'Add your first proxy host', done: false, href: '/proxy-hosts?create=1' },
          { id: 'user', label: 'Invite a teammate', done: false },
        ],
      })
    );
    expect(html).toContain('1 of 3 done');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuemax="3"');
    expect(html).toContain('<span class="sr-only">Done:</span>');
    expect(html).toContain('<span class="sr-only">To do:</span>');
    expect(html).toMatch(/<a [^>]*href="\/proxy-hosts\?create=1"/);
  });
});
