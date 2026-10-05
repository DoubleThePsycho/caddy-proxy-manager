/**
 * Server-side render of the Organisations and Usage pages (ee/multi-tenancy/ui):
 * the list with limits as bars and the filter counts, the opened
 * organisation, the unlicensed notice, and what a read-only role sees.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/organizations',
  useSearchParams: () => navigation.search,
}));

/** Renders with `query` as the page's address, then puts the empty one back. */
function withQuery<T>(query: string, run: () => T): T {
  navigation.search = new URLSearchParams(query);
  try {
    return run();
  } finally {
    navigation.search = new URLSearchParams();
  }
}

import OrganizationsClient, { isNearLimit, upstreamMeaning } from '@/ee/multi-tenancy/ui/OrganizationsClient';
import UsageClient from '@/ee/multi-tenancy/ui/UsageClient';
import type { OrganizationListItem, OrganizationsPageData } from '@/ee/multi-tenancy/page-data';
import type { UsageReport } from '@/ee/multi-tenancy/usage';

const NOW = '2026-10-03T12:00:00.000Z';
const empty = { proxyHosts: [], certificates: [], accessLists: [], groups: [], users: [] };

function organization(overrides: Partial<OrganizationListItem>): OrganizationListItem {
  return {
    id: 1,
    name: 'Northwind',
    slug: 'northwind',
    enabled: true,
    maxProxyHosts: null,
    maxUsers: null,
    allowedUpstreams: [],
    notes: null,
    createdAt: '2026-06-12T09:00:00.000Z',
    updatedAt: NOW,
    counts: { proxyHosts: 0, certificates: 0, accessLists: 0, groups: 0, users: 0 },
    requests: 0,
    disabledSince: null,
    ...overrides,
  };
}

const data: OrganizationsPageData = {
  organizations: [
    organization({
      id: 1,
      name: 'Northwind',
      slug: 'northwind',
      maxProxyHosts: 6,
      maxUsers: 10,
      allowedUpstreams: ['*.northwind.example.org', '10.40.0.0/16'],
      counts: { proxyHosts: 5, certificates: 3, accessLists: 1, groups: 2, users: 6 },
      requests: 18240,
    }),
    organization({ id: 2, name: 'Contoso', slug: 'contoso', maxProxyHosts: 4, counts: { proxyHosts: 4, certificates: 0, accessLists: 0, groups: 0, users: 1 } }),
    organization({ id: 3, name: 'Tailspin', slug: 'tailspin', enabled: false, disabledSince: '2026-09-28T10:00:00.000Z', allowedUpstreams: ['10.60.0.0/16'] }),
  ],
  provider: { proxyHosts: 38, users: 55 },
  usage: { billing: { month: '2026-09', label: 'September' }, current: { month: '2026-10', label: 'October' }, analyticsAvailable: true },
  selected: {
    id: 1,
    usage: { requests: 18240, bytes: 740_000_000, wafBlocks: 61, proxyHosts: 5, enabledProxyHosts: 5 },
    currentRequests: 1702,
    hosts: [
      {
        id: 7,
        name: 'Portal',
        domain: 'portal.northwind.example.org',
        moreDomains: 0,
        upstream: 'http://10.40.1.10:8080',
        moreUpstreams: 0,
        enabled: true,
        protections: [{ kind: 'waf', label: 'WAF · Block' }, { kind: 'sso', label: 'SSO' }],
        requests: 7912,
      },
    ],
    hostsTotal: 1,
    members: [
      {
        id: 2, email: 'it@northwind.example.org', name: 'IT', roleKind: 'org_admin', roleLabel: 'Organisation admin', status: 'active',
        lastSignInAt: '2026-10-03T08:47:00.000Z', mfa: true, apiTokens: 0, tokenLastUsedAt: null,
      },
      {
        id: 4, email: 'ci@northwind.example.org', name: null, roleKind: 'user', roleLabel: 'User', status: 'active',
        lastSignInAt: null, mfa: false, apiTokens: 1, tokenLastUsedAt: '2026-10-03T11:02:00.000Z',
      },
    ],
  },
};

function render(props: Partial<Parameters<typeof OrganizationsClient>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(OrganizationsClient, {
      data,
      movable: empty,
      configurable: true,
      editionLabel: 'MSP',
      canWrite: true,
      now: NOW,
      onSetView: async () => {},
      ...props,
    })
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Organisations page', () => {
  it('lists organisations with limits as bars, the filters and the provider level', () => {
    const html = render();
    const body = text(html);
    expect(body).toContain('Platform / Organisations');
    expect(body).toContain('MSP edition');
    expect(body).toContain('New organisation');
    expect(body).toContain('Usage report, September');
    expect(html).toContain('href="/api/v1/usage-reports?month=2026-09&amp;format=csv"');
    // 5 of 6 is near the limit; 4 of 4 has reached it.
    expect(body).toContain('5 of 6');
    expect(body).toContain('1 left');
    expect(body).toContain('Limit reached');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="Proxy hosts: 5 of 6"');
    expect(body).toMatch(/All 3/);
    expect(body).toMatch(/Near a limit 2/);
    expect(body).toMatch(/Disabled 1/);
    expect(body).toContain('Requests, Sep');
    expect(body).toContain('18,240');
    expect(body).toContain('None yet: cannot add hosts');
    expect(body).toContain('since 28 Sep');
    expect(body).toContain('Provider level: 38 hosts and 55 users that belong to no organisation.');
    expect(body).toContain('Move rows to the provider level');
    expect(html).toContain('aria-label="More actions for Contoso"');
    expect(html).toContain('href="/organizations?organization=2"');
    expect(html).toContain('data-testid="organization-northwind"');
  });

  it('shows the opened organisation: limits, allowed upstreams, usage, hosts and members', () => {
    const body = text(render());
    expect(body).toContain('Since 12 June 2026');
    expect(body).toContain('Show only this organisation');
    expect(body).toContain('Move rows in');
    expect(body).toContain('1 left before new hosts are refused.');
    expect(body).toContain('Any name under northwind.example.org, any depth');
    expect(body).toContain('Any address in this range');
    expect(body).toContain('Usage, September');
    expect(body).toContain('740 MB');
    expect(body).toContain('5 of 5');
    expect(body).toContain('October so far: 1,702 requests.');
    expect(body).toContain('portal.northwind.example.org');
    expect(body).toContain('WAF · Block');
    expect(body).toContain('7,912');
    expect(body).toContain('Signed in today 08:47 UTC · MFA on');
    expect(body).toContain('1 API token · used today 11:02 UTC');
    expect(body).toContain('Organisation admin');
    expect(body).toContain('Add user');
  });

  it('offers to show every organisation again while the dashboard shows only this one', () => {
    expect(text(render({ view: '1' }))).toContain('Show every organisation');
  });

  it('explains the license and keeps only what needs none when unlicensed', () => {
    const empty = text(render({ configurable: false, data: { ...data, organizations: [], selected: null } }));
    expect(empty).toMatch(/Multi-tenancy needs a .* MSP license or higher/);
    expect(empty).toContain('No organisations yet');
    expect(empty).not.toContain('New organisation');

    const html = render({ configurable: false });
    expect(text(html)).not.toContain('New organisation');
    expect(text(html)).toContain('you can still disable and delete them');
    // Moving in and editing need the license; disabling does not.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Move rows in<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Edit<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Disable<\/button>/);
  });

  it('shows a read-only role no write controls, and says what its role cannot read', () => {
    const html = render({
      canWrite: false,
      allowed: { proxyHosts: false, users: false, createUsers: false },
      data: {
        ...data,
        usage: null,
        organizations: data.organizations.map((entry) => ({ ...entry, requests: null })),
        selected: { ...data.selected!, usage: null, currentRequests: null, hosts: null },
      },
    });
    const body = text(html);
    expect(body).not.toContain('New organisation');
    expect(body).not.toContain('More actions');
    expect(body).not.toContain('Move rows to the provider level');
    expect(body).not.toContain('Requests, Sep');
    expect(body).not.toContain('Usage report');
    expect(body).not.toContain('Add user');
    expect(body).toContain('Your role cannot read proxy hosts.');
    expect(body).toContain('Your role cannot read usage reports.');
  });

  it('warns when an organisation has no allowed upstreams and offers to add one', () => {
    const bare = organization({ id: 9, name: 'Fabrikam', slug: 'fabrikam', maxProxyHosts: 2, maxUsers: 2, counts: { proxyHosts: 0, certificates: 0, accessLists: 0, groups: 0, users: 1 } });
    const body = text(render({
      data: { ...data, organizations: [bare], selected: { ...data.selected!, id: 9, hosts: [], hostsTotal: 0, members: [] } },
    }));
    expect(body).toContain('No allowed upstreams yet.');
    expect(body).toContain('No hosts yet');
    expect(body).toContain('Add allowed upstream');
  });
});

describe('Organisations page with many rows', () => {
  const many = Array.from({ length: 62 }, (_, index) =>
    organization({ id: index + 1, name: `Client ${String(index + 1).padStart(2, '0')}`, slug: `client-${index + 1}` })
  );
  const members = Array.from({ length: 30 }, (_, index) => ({
    id: 100 + index, email: `member-${index + 1}@example.com`, name: null, roleKind: 'user' as const, roleLabel: 'User', status: 'active',
    lastSignInAt: null, mfa: false, apiTokens: 0, tokenLastUsedAt: null,
  }));
  const big: OrganizationsPageData = { ...data, organizations: many, selected: { ...data.selected!, id: 1, members } };

  it('pages the list 25 at a time, the page in the address', () => {
    const first = text(render({ data: big }));
    expect(first).toContain('Client 25');
    expect(first).not.toContain('Client 26');
    expect(first).toMatch(/1 – 25 of 62 organisations/);

    const third = withQuery('page=3', () => render({ data: big }));
    expect(text(third)).toContain('Client 62');
    expect(text(third)).not.toContain('Client 49 ');
    expect(text(third)).toMatch(/51 – 62 of 62 organisations/);
    // Opening an organisation keeps the list on its page.
    expect(third).toContain('href="/organizations?page=3&amp;organization=62"');
  });

  it('pages the members of the opened organisation and offers to filter them', () => {
    const html = render({ data: big });
    expect(html).toContain('aria-label="Filter members"');
    expect(html).toContain('member-25@example.com');
    expect(html).not.toContain('member-26@example.com');
    expect(text(html)).toMatch(/1 – 25 of 30 members/);
    const second = withQuery('members=2', () => render({ data: big }));
    expect(second).toContain('member-26@example.com');
    expect(second).not.toContain('member-25@example.com');
  });
});

describe('helpers', () => {
  it('counts an organisation at 80% or more of either limit as near it', () => {
    const counts = { proxyHosts: 0, certificates: 0, accessLists: 0, groups: 0, users: 0 };
    expect(isNearLimit({ counts: { ...counts, proxyHosts: 4 }, maxProxyHosts: 5, maxUsers: null })).toBe(true);
    expect(isNearLimit({ counts: { ...counts, proxyHosts: 3 }, maxProxyHosts: 5, maxUsers: null })).toBe(false);
    expect(isNearLimit({ counts: { ...counts, users: 8 }, maxProxyHosts: null, maxUsers: 10 })).toBe(true);
    expect(isNearLimit({ counts, maxProxyHosts: null, maxUsers: null })).toBe(false);
    // A limit of 0 allows nothing: it is reached.
    expect(isNearLimit({ counts, maxProxyHosts: 0, maxUsers: null })).toBe(true);
  });

  it('describes allowed upstream entries', () => {
    expect(upstreamMeaning('*')).toMatch(/Any network address/);
    expect(upstreamMeaning('*.example.com')).toBe('Any name under example.com, any depth');
    expect(upstreamMeaning('10.0.0.0/8')).toBe('Any address in this range');
    expect(upstreamMeaning('10.0.0.5')).toBe('This address only');
    expect(upstreamMeaning('2001:db8::1')).toBe('This address only');
    expect(upstreamMeaning('app.example.com')).toBe('This host name only');
  });
});

describe('Usage page', () => {
  const report: UsageReport = {
    period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T12:00:00.000Z' },
    analyticsAvailable: false,
    rows: [
      { organizationId: null, organizationName: 'Provider', organizationSlug: null, enabled: true, from: '', to: '', proxyHosts: 2, enabledProxyHosts: 2, users: 3, requests: 100, bytes: 2000, wafBlocks: 1 },
      { organizationId: 1, organizationName: 'Northwind', organizationSlug: 'northwind', enabled: false, from: '', to: '', proxyHosts: 3, enabledProxyHosts: 1, users: 4, requests: 1500, bytes: 3000, wafBlocks: 2 },
    ],
  };

  it('shows totals as tiles and one row per organisation', () => {
    const html = renderToStaticMarkup(createElement(UsageClient, { initialReport: report, organizations: [{ id: 1, name: 'Northwind' }], providerLevel: true }));
    const body = text(html);
    expect(body).toContain('Platform / Usage');
    expect(body).toContain('Download CSV');
    expect(body).toContain('Analytics are off.');
    expect(body).toContain('1,600');
    expect(body).toContain('5.0 kB');
    expect(body).toContain('3 enabled');
    expect(body).toContain('By organisation');
    expect(body).toContain('Provider');
    expect(body).toContain('northwind');
    expect(body).toContain('Disabled');
    expect(body).toContain('1 enabled');
    expect(body).toContain('2026-10-01 to 2026-10-03 UTC');
  });

  it('pages a report with many organisations', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      ...report.rows[1], organizationId: index + 1, organizationName: `Client ${index + 1}`, organizationSlug: `client-${index + 1}`,
    }));
    const html = renderToStaticMarkup(createElement(UsageClient, { initialReport: { ...report, rows }, organizations: [], providerLevel: true }));
    const body = text(html);
    expect(body).toMatch(/1 – 25 of 40 rows/);
    expect(body).toContain('Client 25');
    expect(body).not.toContain('Client 26');
    expect(html).toContain('aria-label="Filter organisations"');
  });
});
