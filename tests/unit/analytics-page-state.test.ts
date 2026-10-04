/**
 * The analytics page's URL state and presentation (app/(dashboard)/analytics):
 * what the URL holds and how it reads back, that the client-side allow-lists
 * and filter checks agree with the API's, the saved view round trip, the
 * CSV export (formula injection), and the top list rows.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/clickhouse/client', () => ({
  isAnalyticsEnabled: () => true,
  getRetentionDays: () => 30,
  getClient: () => ({ query: async () => ({ json: async () => [] }) }),
}));

import {
  DEFAULT_GROUPING,
  DIMENSIONS as SERVER_DIMENSIONS,
  DIMENSION_SPECS,
  GROUPINGS as SERVER_GROUPINGS,
  METRICS as SERVER_METRICS,
} from '@/src/lib/analytics/dimensions';
import { MAX_FILTERS as SERVER_MAX_FILTERS, parseFilters } from '@/src/lib/analytics/filters';
import { OUTCOMES as SERVER_OUTCOMES } from '@/src/lib/analytics/outcome';
import { MAX_RANGE_SECONDS as SERVER_MAX_RANGE } from '@/src/lib/analytics/range';
import { parseViewRange } from '@/src/lib/models/analytics-views';
import type { TopRow } from '@/src/lib/analytics';
import {
  DEFAULT_VIEW_STATE,
  DIMENSIONS,
  GROUPINGS,
  MAX_FILTERS,
  MAX_RANGE_SECONDS,
  METRICS,
  METRIC_GROUPINGS,
  OUTCOMES,
  addFilter,
  decodeFilter,
  decodeFiltersJson,
  effectiveGrouping,
  encodeFilter,
  filterValueError,
  listParams,
  matchesSavedView,
  normalizeFilterValue,
  parseViewState,
  queryParams,
  rangeParams,
  savedViewSettings,
  securityEventsHref,
  serializeViewState,
  stateFromSavedView,
  type ViewState,
} from '@/app/(dashboard)/analytics/view-state';
import {
  DIMENSION_LABEL,
  asnLabel,
  chartCsv,
  chartTitle,
  countryName,
  csvCell,
  filterSuggestions,
  formatLogTime,
  formatStep,
  fromDateTimeInput,
  groupingLabel,
  seriesColor,
  seriesLabel,
  statusColor,
  toDateTimeInput,
} from '@/app/(dashboard)/analytics/present';
import { mitigatedTag, statusSegments, toListRow } from '@/app/(dashboard)/analytics/TopPanels';
import { customRangeError } from '@/app/(dashboard)/analytics/RangeControl';
import { isQueryResult, isRequestLog, isTopResult, fetchJson } from '@/app/(dashboard)/analytics/use-analytics-data';
import { savedViewHref } from '@/app/(dashboard)/analytics/SavedViews';

const NOW = Date.UTC(2026, 9, 3, 12, 0) / 1000;
const parse = (query: string) => parseViewState(new URLSearchParams(query), NOW);
const state = (patch: Partial<ViewState>): ViewState => ({ ...DEFAULT_VIEW_STATE, filters: [], ...patch });

describe('client allow-lists', () => {
  it('match the API', () => {
    expect([...DIMENSIONS]).toEqual([...SERVER_DIMENSIONS]);
    expect([...METRICS]).toEqual([...SERVER_METRICS]);
    expect([...GROUPINGS]).toEqual([...SERVER_GROUPINGS]);
    expect([...OUTCOMES]).toEqual([...SERVER_OUTCOMES]);
    expect(MAX_FILTERS).toBe(SERVER_MAX_FILTERS);
    expect(MAX_RANGE_SECONDS).toBe(SERVER_MAX_RANGE);
    expect(Object.keys(DIMENSION_LABEL).sort()).toEqual([...SERVER_DIMENSIONS].sort());
  });

  it("start each metric on the API's default grouping and never group unique addresses", () => {
    for (const metric of SERVER_METRICS) expect(METRIC_GROUPINGS[metric][0]).toBe(DEFAULT_GROUPING[metric]);
    expect(METRIC_GROUPINGS.visitors).toEqual(['none']);
  });
});

describe('filter values', () => {
  const cases: [keyof typeof DIMENSION_SPECS, string][] = [
    ['host', 'app.example.com'],
    ['host', 'x'.repeat(256)],
    ['path', '/login'],
    ['path', '/' + 'a'.repeat(600)],
    ['country', 'DE'],
    ['country', 'lan'],
    ['country', 'XX'],
    ['country', 'Germany'],
    ['asn', 'AS13335'],
    ['asn', '13335'],
    ['asn', 'AS99999999999'],
    ['asn', 'cloudflare'],
    ['status', '404'],
    ['status', '5xx'],
    ['status', '6xx'],
    ['status', '1000'],
    ['method', 'GET'],
    ['method', 'GE T'],
    ['protocol', 'HTTP/2.0'],
    ['protocol', 'HTTP 2'],
    ['ip', '203.0.113.7'],
    ['ip', '2001:db8::1'],
    ['ip', '::1'],
    ['ip', '256.1.1.1'],
    ['ip', '2001:db8::zz'],
    ['ip', 'example.com'],
    ['user_agent', 'curl 8.5.0'],
    ['outcome', 'waf'],
    ['outcome', 'blocked'],
    ['waf_rule', '942100'],
    ['waf_rule', '94a'],
  ];

  it('are checked as the API checks them', () => {
    for (const [dim, raw] of cases) {
      const value = normalizeFilterValue(dim, raw);
      let serverAccepts = true;
      try {
        DIMENSION_SPECS[dim].compare(value);
      } catch {
        serverAccepts = false;
      }
      expect(filterValueError(dim, value) === null, `${dim} ${raw}`).toBe(serverAccepts);
    }
  });

  it('are normalised: trimmed, country codes and methods in capitals', () => {
    expect(normalizeFilterValue('country', ' de ')).toBe('DE');
    expect(normalizeFilterValue('method', 'post')).toBe('POST');
    expect(normalizeFilterValue('status', '5XX')).toBe('5xx');
    expect(normalizeFilterValue('host', ' App.example.com ')).toBe('App.example.com');
  });

  it('encode and decode, keeping colons in the value', () => {
    for (const filter of [
      { dim: 'host', op: 'is', value: 'app.example.com' },
      { dim: 'ip', op: 'is_not', value: '2001:db8::1' },
      { dim: 'path', op: 'is', value: '/a:b/c' },
    ] as const) {
      expect(decodeFilter(encodeFilter(filter))).toEqual(filter);
    }
    expect(encodeFilter({ dim: 'host', op: 'is_not', value: 'a.example.com' })).toBe('!host:a.example.com');
    expect(decodeFilter('nope:x')).toBeNull();
    expect(decodeFilter('host:')).toBeNull();
    expect(decodeFilter(':x')).toBeNull();
    expect(decodeFilter('country:Germany')).toBeNull();
  });

  it('add without repeating, replacing the opposite filter on the same value', () => {
    const one = addFilter([], { dim: 'host', op: 'is', value: 'a.example.com' });
    expect(addFilter(one, { dim: 'host', op: 'is', value: 'a.example.com' })).toEqual(one);
    expect(addFilter(one, { dim: 'host', op: 'is_not', value: 'a.example.com' })).toEqual([{ dim: 'host', op: 'is_not', value: 'a.example.com' }]);
    expect(addFilter(one, { dim: 'host', op: 'is', value: 'b.example.com' })).toHaveLength(2);
    const full = Array.from({ length: MAX_FILTERS }, (_, i) => ({ dim: 'path' as const, op: 'is' as const, value: `/${i}` }));
    expect(addFilter(full, { dim: 'host', op: 'is', value: 'c.example.com' })).toHaveLength(MAX_FILTERS);
  });
});

describe('URL state', () => {
  it('defaults to the last 24 hours of requests by outcome, compared', () => {
    expect(parse('')).toEqual(DEFAULT_VIEW_STATE);
    expect(serializeViewState(DEFAULT_VIEW_STATE)).toBe('');
    expect(effectiveGrouping(DEFAULT_VIEW_STATE)).toBe('outcome');
  });

  it('reads every setting back as it was written', () => {
    const full = state({
      range: '7d',
      metric: 'errors',
      group: 'host',
      compare: false,
      filters: [
        { dim: 'host', op: 'is', value: 'app.example.com' },
        { dim: 'country', op: 'is_not', value: 'CN' },
      ],
      viewId: 12,
    });
    const query = serializeViewState(full);
    expect(query).toBe('range=7d&metric=errors&group=host&compare=0&filter=host%3Aapp.example.com&filter=%21country%3ACN&view=12');
    expect(parse(query)).toEqual(full);
  });

  it('keeps a valid custom range and drops an invalid one', () => {
    const from = NOW - 3 * 86_400;
    expect(parse(`range=custom&from=${from}&to=${NOW}`)).toMatchObject({ range: 'custom', from, to: NOW });
    expect(parse(`from=${from}&to=${NOW}`)).toMatchObject({ range: 'custom', from, to: NOW });
    expect(parse(`range=custom&from=${NOW}&to=${from}`).range).toBe('24h');
    expect(parse(`range=custom&from=${NOW - 93 * 86_400}&to=${NOW}`).range).toBe('24h');
    expect(parse(`range=custom&from=${NOW + 60}&to=${NOW + 120}`).range).toBe('24h');
    expect(parse('range=custom&from=abc&to=1').range).toBe('24h');
  });

  it('falls back to defaults for anything off the lists', () => {
    expect(parse('range=12h&metric=latency&group=path&compare=maybe&view=-3&filter=evil%3Ax')).toEqual(DEFAULT_VIEW_STATE);
    expect(parse('metric=bandwidth').metric).toBe('bytes');
    // Unique addresses do not add up across hosts.
    expect(parse('metric=visitors&group=host').group).toBeNull();
    expect(parse('metric=bytes&group=outcome').group).toBeNull();
    expect(parse('metric=mitigated&group=host').group).toBe('host');
  });

  it('reads the links other pages make: filters as the API\'s JSON', () => {
    const from = NOW - 3600;
    const filters = JSON.stringify([
      { dim: 'host', op: 'is', value: 'app.example.com' },
      { dim: 'outcome', op: 'is_not', value: 'served' },
      { dim: 'country', value: 'de' },
      { dim: 'uri', op: 'is', value: '/x' },
      { dim: 'status', op: 'maybe', value: '500' },
      { dim: 'ip', op: 'is', value: 'not-an-ip' },
    ]);
    const s = parse(`range=custom&from=${from}&to=${NOW}&filters=${encodeURIComponent(filters)}&filter=method%3APOST`);
    expect(s).toMatchObject({ range: 'custom', from, to: NOW });
    expect(s.filters).toEqual([
      { dim: 'host', op: 'is', value: 'app.example.com' },
      { dim: 'outcome', op: 'is_not', value: 'served' },
      { dim: 'country', op: 'is', value: 'DE' },
      { dim: 'method', op: 'is', value: 'POST' },
    ]);
    expect(decodeFiltersJson('not json')).toEqual([]);
    expect(decodeFiltersJson('{"dim":"host"}')).toEqual([]);
    expect(decodeFiltersJson(null)).toEqual([]);
  });

  it('links to the security events of the same range and filters', () => {
    expect(securityEventsHref(state({ range: '7d' }))).toBe('/security?range=7d#events');
    const href = securityEventsHref(state({ range: 'custom', from: 10, to: 20, filters: [{ dim: 'host', op: 'is', value: 'app.example.com' }] }));
    const url = new URL(href, 'https://dash.example.com');
    expect(url.pathname).toBe('/security');
    expect(url.hash).toBe('#events');
    expect(url.searchParams.get('from')).toBe('10');
    expect(url.searchParams.get('to')).toBe('20');
    expect(parseFilters(url.searchParams.get('filters'))).toEqual([{ dim: 'host', op: 'is', value: 'app.example.com' }]);
  });

  it('keeps at most the filters the API accepts', () => {
    const query = Array.from({ length: 30 }, (_, i) => `filter=path%3A%2F${i}`).join('&');
    expect(parse(query).filters).toHaveLength(MAX_FILTERS);
  });

  it('builds the API parameters, filters as bound JSON', () => {
    const s = state({ range: '1h', metric: 'mitigated', filters: [{ dim: 'host', op: 'is', value: 'app.example.com' }] });
    const q = queryParams(s);
    expect(q.get('range')).toBe('1h');
    expect(q.get('metric')).toBe('mitigated');
    expect(q.get('groupBy')).toBe('outcome');
    expect(parseFilters(q.get('filters'))).toEqual(s.filters);
    const l = listParams(s);
    expect(l.has('metric')).toBe(false);
    expect(l.get('filters')).toBe(q.get('filters'));
    expect(listParams(state({})).has('filters')).toBe(false);
    expect(rangeParams(state({ range: 'custom', from: 10, to: 20 })).toString()).toBe('from=10&to=20');
  });
});

describe('saved views', () => {
  it('save and load the same settings', () => {
    const s = state({
      range: 'custom',
      from: NOW - 86_400,
      to: NOW,
      metric: 'bytes',
      group: 'host',
      filters: [{ dim: 'status', op: 'is', value: '5xx' }],
    });
    const settings = savedViewSettings(s);
    expect(parseViewRange(settings.range)).toEqual({ from: NOW - 86_400, to: NOW });
    const view = { id: 4, ...settings };
    const loaded = stateFromSavedView(view);
    expect(loaded).toEqual({ ...s, viewId: 4 });
    expect(matchesSavedView(loaded, view)).toBe(true);
    expect(matchesSavedView({ ...loaded, metric: 'requests' }, view)).toBe(false);
    expect(savedViewHref({ ...view, name: 'x', shared: false, owned: true, ownerName: null, createdAt: '', updatedAt: '' })).toBe(
      `/analytics?${serializeViewState(loaded)}`
    );
  });

  it('save a preset as its name and the default grouping as none', () => {
    expect(savedViewSettings(state({ range: '30d' }))).toEqual({ range: { preset: '30d' }, filters: [], metric: 'requests', groupBy: null });
  });
});

describe('custom range form', () => {
  it('explains what is wrong', () => {
    expect(customRangeError(null, NOW, NOW)).toMatch(/both/);
    expect(customRangeError(NOW, NOW - 1, NOW)).toMatch(/after/);
    expect(customRangeError(NOW + 60, NOW + 120, NOW)).toMatch(/future/);
    expect(customRangeError(NOW - 100 * 86_400, NOW, NOW)).toMatch(/92 days/);
    expect(customRangeError(NOW - 86_400, NOW, NOW)).toBeNull();
  });

  it('reads and writes UTC date-time fields', () => {
    expect(toDateTimeInput(NOW)).toBe('2026-10-03T12:00');
    expect(fromDateTimeInput('2026-10-03T12:00')).toBe(NOW);
    expect(fromDateTimeInput('yesterday')).toBeNull();
  });
});

describe('presentation', () => {
  it('names charts and groupings after the metric', () => {
    expect(chartTitle('requests', 'outcome')).toBe('Requests by outcome');
    expect(chartTitle('requests', 'status')).toBe('Requests by status class');
    expect(chartTitle('bytes', 'none')).toBe('Bytes sent');
    expect(chartTitle('mitigated', 'outcome')).toBe('Mitigated requests by source');
    expect(chartTitle('errors', 'host')).toBe('Error responses by host');
    expect(groupingLabel('outcome', 'mitigated')).toBe('Source');
    expect(groupingLabel('none', 'bytes')).toBe('Total');
    expect(seriesLabel('none', 'bytes', 'Total')).toBe('Bytes sent');
    expect(seriesLabel('host', 'requests', 'app.example.com')).toBe('app.example.com');
  });

  it('colours series with tokens', () => {
    expect(seriesColor('outcome', 'requests', 'waf', 1)).toBe('var(--waf)');
    expect(seriesColor('status', 'errors', '5xx', 0)).toBe('var(--err5)');
    expect(seriesColor('host', 'requests', '__other__', 4)).toBe('var(--err4)');
    expect(seriesColor('none', 'visitors', 'total', 0)).toBe('var(--brand)');
    expect(statusColor(302)).toBe('var(--served2)');
    expect(statusColor('503')).toBe('var(--err5)');
  });

  it('names countries, networks, steps and times', () => {
    expect(countryName('LAN')).toBe('Private network');
    expect(countryName('XX')).toBe('Unknown');
    expect(countryName('DE')).toBe('Germany');
    expect(asnLabel('13335')).toBe('AS13335');
    expect(asnLabel('0')).toBe('Unknown network');
    expect(formatStep(60)).toBe('minute');
    expect(formatStep(1800)).toBe('30 minutes');
    expect(formatStep(10_800)).toBe('3 hours');
    expect(formatStep(86_400)).toBe('day');
    expect(formatLogTime(NOW + 2, false)).toBe('12:00:02');
    expect(formatLogTime(NOW + 2, true)).toBe('3 Oct 12:00:02');
  });

  it('suggests the top values, configured hosts, status classes and outcomes', () => {
    const suggestions = filterSuggestions(
      [
        { dimension: 'host', label: 'Host', distinct: 1, rows: [{ value: 'busy.example.com', count: 5, share: 1, mitigated: 0, mitigatedShare: 0 }] },
        {
          dimension: 'asn',
          label: 'ASN',
          distinct: 2,
          rows: [
            { value: '13335', count: 3, share: 0.5, mitigated: 0, mitigatedShare: 0 },
            { value: '0', count: 3, share: 0.5, mitigated: 0, mitigatedShare: 0 },
          ],
        },
      ],
      ['app.example.com', 'busy.example.com']
    );
    expect(suggestions.host).toEqual(['busy.example.com', 'app.example.com']);
    expect(suggestions.asn).toEqual(['AS13335']);
    expect(suggestions.status).toEqual(['2xx', '3xx', '4xx', '5xx']);
    expect(suggestions.outcome).toEqual([...OUTCOMES]);
  });
});

describe('CSV export', () => {
  it('neutralises formulas in labels taken from requests', () => {
    expect(csvCell('=HYPERLINK("http://example.com")')).toBe(`"'=HYPERLINK(""http://example.com"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });

  it('writes one row per bucket with the total and the previous period', () => {
    const t0 = Date.UTC(2026, 9, 3, 10, 0);
    const csv = chartCsv({
      buckets: [t0, t0 + 60_000],
      series: [
        { label: 'Served', values: [3, 4] },
        { label: '-evil.example.com', values: [1, 0] },
      ],
      previous: [2, null],
    });
    expect(csv.split('\r\n')).toEqual([
      "Time (UTC),Served,'-evil.example.com,Total,Previous period",
      '2026-10-03T10:00:00.000Z,3,1,4,2',
      '2026-10-03T10:01:00.000Z,4,0,4,',
      '',
    ]);
  });
});

describe('top list rows', () => {
  const row = (value: string, extra: Partial<TopRow> = {}): TopRow => ({ value, count: 10, share: 0.1, mitigated: 0, mitigatedShare: 0, ...extra });

  it('carry the value a filter needs', () => {
    expect(toListRow('country', row('DE'))).toMatchObject({ label: 'Germany', code: 'DE', value: 'DE' });
    expect(toListRow('asn', row('13335', { label: 'Cloudflare' }))).toMatchObject({ label: 'AS13335', sub: 'Cloudflare', value: 'AS13335' });
    expect(toListRow('asn', row('0'))).toMatchObject({ label: 'Unknown network', value: '0' });
    expect(toListRow('status', row('503'))).toMatchObject({ label: '503', dot: 'var(--err5)', value: '503' });
    expect(toListRow('ip', row('203.0.113.7', { country: 'IT', asOrg: 'Example Telecom' }))).toMatchObject({ sub: 'IT · Example Telecom' });
    expect(toListRow('path', row(''))).toMatchObject({ label: '(empty)', value: '' });
  });

  it('tag rows whose requests were often mitigated', () => {
    expect(mitigatedTag({ mitigated: 16, mitigatedShare: 0.16 })).toBe('16% mitigated');
    expect(mitigatedTag({ mitigated: 1, mitigatedShare: 0.01 })).toBeUndefined();
    expect(mitigatedTag({ mitigated: 0, mitigatedShare: 0 })).toBeUndefined();
  });

  it('draw the status class bar', () => {
    expect(statusSegments({ dimension: 'status', label: 'Status', distinct: 2, rows: [], classes: [{ class: '2xx', count: 9, share: 0.9 }, { class: '5xx', count: 1, share: 0.1 }] })).toEqual([
      { label: '2xx', fraction: 0.9, color: 'var(--served)' },
      { label: '5xx', fraction: 0.1, color: 'var(--err5)' },
    ]);
    expect(statusSegments(undefined)).toBeUndefined();
  });
});

describe('API answers', () => {
  it('are checked before the page uses them', () => {
    expect(isQueryResult({ unexpected: 'shape' })).toBe(false);
    expect(isQueryResult([])).toBe(false);
    expect(isTopResult({ status: 'ok', total: 0, dimensions: {} })).toBe(false);
    expect(isTopResult({ status: 'ok', total: 0, dimensions: [] })).toBe(true);
    expect(isRequestLog({ status: 'ok', requests: [] })).toBe(true);
    expect(isRequestLog(null)).toBe(false);
  });

  it("turn an error status into the API's message, or the status when it sends none", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'filters must be a JSON array' }), { status: 400 })) as unknown as typeof fetch;
      await expect(fetchJson('/api/v1/analytics/query?range=1h')).rejects.toThrow('filters must be a JSON array');
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: '' }), { status: 500 })) as unknown as typeof fetch;
      await expect(fetchJson('/api/v1/analytics/query?range=1h')).rejects.toThrow('/api/v1/analytics/query answered with status 500');
    } finally {
      globalThis.fetch = original;
    }
  });
});
