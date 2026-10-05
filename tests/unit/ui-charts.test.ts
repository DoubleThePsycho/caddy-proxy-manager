/**
 * The hand-rolled chart and data components (src/components/ui): number
 * formatting, scales, and what each component renders, including the
 * accessible tables and labels screen readers rely on.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chartScale,
  formatBucketTime,
  formatBytes,
  formatChange,
  formatCompact,
  formatPercent,
  formatSignedChange,
  inferStepSeconds,
  niceMax,
  niceTicks,
} from '@/components/ui/chart-format';
import { Sparkline, sparklinePaths } from '@/components/ui/Sparkline';
import { KpiTile } from '@/components/ui/KpiTile';
import { StackedBarChart } from '@/components/ui/StackedBarChart';
import { StackedAreaChart } from '@/components/ui/StackedAreaChart';
import { bucketPosition, chartAnnouncement, ChartTooltip, nextActiveBucket, xTickIndices, xTickLabels } from '@/components/ui/chart-internals';
import { TopList } from '@/components/ui/TopList';
import { ExpiryTimeline, expiryText, expiryTone, placeExpiryItems } from '@/components/ui/ExpiryTimeline';

const T0 = Date.UTC(2026, 9, 3, 10, 0); // Sat 3 Oct 2026, 10:00 UTC
const HOUR = 3_600_000;

describe('chart-format', () => {
  it('formats counts compactly like the analytics design', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(9999)).toBe('9,999');
    expect(formatCompact(61817)).toBe('61.8k');
    expect(formatCompact(18400)).toBe('18.4k');
    expect(formatCompact(214000)).toBe('214k');
    expect(formatCompact(1_240_000)).toBe('1.24M');
    expect(formatCompact(12_300_000)).toBe('12.3M');
    expect(formatCompact(2_100_000_000)).toBe('2.10B');
    expect(formatCompact(Number.NaN)).toBe('–');
  });

  it('formats bytes in decimal units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1200)).toBe('1.2 kB');
    expect(formatBytes(340_000_000)).toBe('340 MB');
    expect(formatBytes(1_400_000_000)).toBe('1.4 GB');
  });

  it('formats fractions with one decimal, two under 1%', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.726)).toBe('72.6%');
    expect(formatPercent(0.0023)).toBe('0.23%');
    expect(formatPercent(1)).toBe('100.0%');
  });

  it('gives a change its tone from which direction is good', () => {
    expect(formatChange(150, 100, 'up')).toEqual({ text: '▲ 50%', tone: 'ok', ratio: 0.5 });
    expect(formatChange(150, 100, 'down')).toMatchObject({ text: '▲ 50%', tone: 'bad' });
    expect(formatChange(67, 100, 'down')).toMatchObject({ text: '▼ 33%', tone: 'ok' });
    expect(formatChange(67, 100, null)).toMatchObject({ text: '▼ 33%', tone: 'neutral' });
    expect(formatChange(101, 100, 'up')).toMatchObject({ tone: 'neutral' });
    expect(formatChange(5, 0, 'up')).toEqual({ text: 'up from 0', tone: 'neutral', ratio: null });
    expect(formatChange(0, 0, 'up')).toEqual({ text: 'no change', tone: 'neutral', ratio: null });
    expect(formatChange(5, null)).toEqual({ text: 'No earlier data', tone: 'neutral', ratio: null });
    expect(formatSignedChange(112, 100)).toBe('+12%');
    expect(formatSignedChange(92, 100)).toBe('−8%');
    expect(formatSignedChange(5, 0)).toBe('');
  });

  it('picks nice axis maxima and even ticks', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1.4)).toBe(2);
    expect(niceMax(2.2)).toBe(2.5);
    expect(niceMax(430)).toBe(500);
    expect(niceMax(2100)).toBe(2500);
    expect(niceMax(7000)).toBe(10000);
    expect(niceTicks(2500)).toEqual([0, 625, 1250, 1875, 2500]);
    expect(chartScale([10, 40, 2121])).toEqual({ max: 2500, ticks: [0, 625, 1250, 1875, 2500] });
    expect(chartScale([])).toMatchObject({ max: 2 });
  });

  it('labels buckets in UTC by their width', () => {
    expect(formatBucketTime(T0 + 30 * 60_000, 60)).toBe('10:30');
    expect(formatBucketTime(T0 + 30 * 60_000, 1800, true)).toBe('3 Oct, 10:30');
    expect(formatBucketTime(T0 - 4 * HOUR, 10800)).toBe('Sat 06:00');
    expect(formatBucketTime(T0, 86400)).toBe('3 Oct');
    expect(inferStepSeconds([T0, T0 + HOUR])).toBe(3600);
    expect(inferStepSeconds([T0])).toBe(60);
  });
});

describe('Sparkline', () => {
  it('is decorative without a label', () => {
    const html = renderToStaticMarkup(createElement(Sparkline, { values: [1, 4, 2] }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).toContain('fill-opacity:0.16');
  });

  it('summarises the line when labelled', () => {
    const html = renderToStaticMarkup(createElement(Sparkline, { values: [1200, 400, 18400], label: 'Requests per hour', color: 'var(--waf)', area: false }));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Requests per hour: lowest 400, highest 18.4k, latest 18.4k"');
    expect(html).toContain('stroke:var(--waf)');
    expect(html).not.toContain('fill-opacity');
  });

  it('draws a flat line for a single or constant value', () => {
    expect(sparklinePaths([5]).line).toBe('M0.0 16.0 L96.0 16.0');
    expect(sparklinePaths([]).line).toBe('');
  });
});

describe('KpiTile', () => {
  it('is a toggle button when selectable', () => {
    const html = renderToStaticMarkup(
      createElement(KpiTile, {
        label: 'Mitigated',
        value: '18.4k',
        color: 'var(--waf)',
        delta: { text: '▲ 212%', tone: 'bad' },
        note: 'vs previous 24 hours',
        sparkline: [1, 3, 2],
        selected: true,
        onSelect: vi.fn(),
      })
    );
    expect(html).toMatch(/^<button type="button" aria-pressed="true"/);
    expect(html).toContain('border-brand bg-brand-tint');
    expect(html).toContain('class="num font-semibold text-bad">▲ 212%</span>');
    expect(html).toContain('vs previous 24 hours');
    expect(html).toContain('background:var(--waf)');
    expect(html).toContain('<svg');
    // The line sits in a container beside the value and is dropped where that is narrower than the line.
    expect(html).toMatch(/<span class="@container flex min-w-0 flex-1 justify-end" data-testid="kpi-sparkline"><svg[^>]*class="[^"]*@max-\[5\.5rem\]:hidden/);
  });

  it('renders as a link or a static tile, with neutral deltas in secondary text', () => {
    const link = renderToStaticMarkup(createElement(KpiTile, { label: 'Requests', value: '61,817', href: '/analytics', delta: { text: '▼ 33%' } }));
    expect(link).toMatch(/^<a [^>]*href="\/analytics"/);
    expect(link).toContain('text-muted-foreground">▼ 33%');
    const plain = renderToStaticMarkup(createElement(KpiTile, { label: 'Requests', value: '61,817', delta: { text: '▲ 4%', tone: 'ok' } }));
    expect(plain).toMatch(/^<div class="/);
    expect(plain).not.toContain('aria-pressed');
    expect(plain).toContain('text-ok');
  });

  it('has a small size with a 20px value', () => {
    const small = renderToStaticMarkup(createElement(KpiTile, { label: 'Hosts', value: '12', size: 'sm' }));
    expect(small).toContain('text-[20px]');
    expect(small).not.toContain('text-[26px]');
    expect(renderToStaticMarkup(createElement(KpiTile, { label: 'Hosts', value: '12' }))).toContain('text-[26px]');
  });
});

const buckets = [T0, T0 + HOUR, T0 + 2 * HOUR];
const series = [
  { key: 'served', label: 'Served', color: 'var(--served)', values: [100, 200, 300] },
  { key: 'waf', label: 'Blocked by WAF', color: 'var(--waf)', values: [5, 0, 20] },
];

describe('StackedBarChart', () => {
  it('stacks a bar segment per visible series and value', () => {
    const html = renderToStaticMarkup(createElement(StackedBarChart, { title: 'Requests by outcome', buckets, series }));
    expect(html.match(/data-series="served"/g)).toHaveLength(3);
    // A zero value draws no segment.
    expect(html.match(/data-series="waf"/g)).toHaveLength(2);
    expect(html).toContain('aria-roledescription="chart"');
    expect(html).toContain('aria-label="Requests by outcome"');
    expect(html).toContain('tabindex="0"');
  });

  it('leaves hidden series out of the bars and marks them in the legend', () => {
    const html = renderToStaticMarkup(createElement(StackedBarChart, { title: 'Requests', buckets, series, hidden: ['waf'] }));
    expect(html).not.toContain('data-series="waf"');
    expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*>.*?Blocked by WAF.*?hidden<\/span><\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="true"[^>]*>.*?Served.*?<span class="num text-xs text-soft">100.0%<\/span>/);
  });

  it('honours defaultHidden when uncontrolled', () => {
    const html = renderToStaticMarkup(createElement(StackedBarChart, { title: 'Requests', buckets, series, defaultHidden: ['served'] }));
    expect(html).not.toContain('data-series="served"');
  });

  it('has an accessible table with every bucket, series, total and the previous period', () => {
    const html = renderToStaticMarkup(
      createElement(StackedBarChart, { title: 'Requests by outcome', buckets, series, previous: [90, null, 250], previousLabel: 'Previous 24 hours' })
    );
    const table = html.slice(html.indexOf('<table class="sr-only">'));
    expect(table).toContain('<caption>Requests by outcome</caption>');
    expect(table).toContain('<th scope="col">Time (UTC)</th><th scope="col">Served</th><th scope="col">Blocked by WAF</th><th scope="col">Total</th><th scope="col">Previous 24 hours</th>');
    expect(table).toContain('<tr><th scope="row">3 Oct, 10:00 UTC</th><td>100</td><td>5</td><td>105</td><td>90</td></tr>');
    expect(table).toContain('<tr><th scope="row">3 Oct, 11:00 UTC</th><td>200</td><td>0</td><td>200</td><td>–</td></tr>');
    expect(html).toContain('data-testid="chart-previous"');
    expect(html).toContain('stroke-dasharray:5 4');
    expect(html).toContain('Previous 24 hours</span>');
  });

  it('draws annotations as a dashed line with a pill, linked when given an href', () => {
    const html = renderToStaticMarkup(
      createElement(StackedBarChart, {
        title: 'Requests',
        buckets,
        series,
        annotations: [{ index: 2, label: 'Peak · 20 mitigated', href: '/security' }, { index: 9, label: 'Outside' }],
      })
    );
    expect(html).toContain('data-annotation="2"');
    expect(html).not.toContain('data-annotation="9"');
    expect(html).toContain('border-left:1px dashed var(--waf)');
    expect(html).toMatch(/<a [^>]*href="\/security"[^>]*>.*Peak · 20 mitigated<\/a>/);
  });

  it('shows the empty state without data', () => {
    const none = renderToStaticMarkup(createElement(StackedBarChart, { title: 'Requests', buckets: [], series }));
    expect(none).toContain('No data for this period.');
    expect(none).not.toContain('<table');
    const zeros = renderToStaticMarkup(
      createElement(StackedBarChart, { title: 'Requests', buckets, series: [{ key: 'a', label: 'A', color: 'red', values: [0, 0, 0] }], emptyText: 'No traffic yet.' })
    );
    expect(zeros).toContain('No traffic yet.');
  });

  it('uses the value and bucket formatters it is given', () => {
    const html = renderToStaticMarkup(
      createElement(StackedBarChart, {
        title: 'Bytes',
        buckets,
        series: [{ key: 'b', label: 'Bytes sent', color: 'var(--served2)', values: [1200, 0, 0] }],
        formatValue: (v: number) => `${v} B`,
        formatBucket: (ms: number, long: boolean) => (long ? `long ${ms}` : `short ${ms}`),
        bucketHeader: 'Hour',
        legend: false,
      })
    );
    expect(html).toContain(`<th scope="row">long ${T0}</th><td>1200 B</td>`);
    expect(html).toContain(`short ${T0}`);
    expect(html).toContain('<th scope="col">Hour</th>');
    expect(html).not.toContain('aria-pressed');
  });

  it('places bars at column centres and spreads x labels', () => {
    expect(bucketPosition('bar', 0, 4)).toBe(0.125);
    expect(bucketPosition('area', 0, 4)).toBe(0);
    expect(bucketPosition('area', 3, 4)).toBe(1);
    expect(xTickIndices(48, 7)).toEqual([0, 8, 16, 24, 31, 39, 47]);
    expect(xTickIndices(3, 7)).toEqual([0, 1, 2]);
    expect(xTickIndices(0, 7)).toEqual([]);
  });

  it('thins the x labels on narrow charts so they never overlap', () => {
    const labels = xTickLabels(48, 7);
    const shownWhen = (hiddenClass: string) => labels.filter((l) => !l.className.split(' ').includes(hiddenClass)).map((l) => l.index);
    expect(shownWhen('@max-sm:hidden')).toEqual([0, 24, 47]);
    expect(shownWhen('@sm:@max-xl:hidden')).toEqual([0, 16, 31, 47]);
    expect(shownWhen('@xl:hidden')).toEqual([0, 8, 16, 24, 31, 39, 47]);
    expect(xTickLabels(2, 7).map((l) => l.className)).toEqual(['', '']);
  });
});

describe('chart reading', () => {
  it('moves the active bucket with the arrow, Home, End and Escape keys', () => {
    expect(nextActiveBucket('ArrowRight', null, 5)).toBe(0);
    expect(nextActiveBucket('ArrowRight', 2, 5)).toBe(3);
    expect(nextActiveBucket('ArrowRight', 4, 5)).toBe(4);
    expect(nextActiveBucket('ArrowLeft', null, 5)).toBe(4);
    expect(nextActiveBucket('ArrowLeft', 0, 5)).toBe(0);
    expect(nextActiveBucket('Home', 3, 5)).toBe(0);
    expect(nextActiveBucket('End', 0, 5)).toBe(4);
    expect(nextActiveBucket('Escape', 3, 5)).toBeNull();
    expect(nextActiveBucket('Tab', 3, 5)).toBeUndefined();
    expect(nextActiveBucket('ArrowRight', null, 0)).toBeUndefined();
  });

  const rows = [
    { key: 'waf', label: 'Blocked by WAF', color: 'var(--waf)', value: 20 },
    { key: 'served', label: 'Served', color: 'var(--served)', value: 300 },
  ];

  it('shows each series, the total and the previous period with its change in the tooltip', () => {
    const html = renderToStaticMarkup(
      createElement(ChartTooltip, { position: 0.8, time: '3 Oct, 12:00 UTC', rows, total: 320, previous: 250, previousLabel: 'Previous 24 hours', formatValue: formatCompact })
    );
    expect(html).toContain('translateX(calc(-100% - 14px))');
    expect(html).toContain('3 Oct, 12:00 UTC');
    expect(html.indexOf('Blocked by WAF')).toBeLessThan(html.indexOf('Served'));
    expect(html).toContain('<span class="flex-1">Total</span><span class="num">320</span>');
    expect(html).toContain('Previous 24 hours</span><span class="num">250</span><span class="num text-foreground">+28%</span>');
    const left = renderToStaticMarkup(
      createElement(ChartTooltip, { position: 0.2, time: 't', rows, total: 320, previous: null, previousLabel: 'Previous', formatValue: formatCompact })
    );
    expect(left).toContain('translateX(14px)');
    expect(left).not.toContain('Previous');
  });

  it('announces the active bucket to screen readers', () => {
    expect(chartAnnouncement('3 Oct, 12:00 UTC', rows, 320, 250, 'Previous 24 hours', formatCompact)).toBe(
      '3 Oct, 12:00 UTC: Blocked by WAF 20, Served 300. Total 320. Previous 24 hours 250.'
    );
    expect(chartAnnouncement('t', rows, 320, null, 'Previous', formatCompact)).toBe('t: Blocked by WAF 20, Served 300. Total 320.');
  });
});

describe('StackedAreaChart', () => {
  it('draws one stacked area and line per visible series and the same table', () => {
    const html = renderToStaticMarkup(createElement(StackedAreaChart, { title: 'Traffic, last 24 hours', buckets, series }));
    expect(html).toContain('data-testid="chart-areas"');
    expect(html.match(/data-series="served"/g)).toHaveLength(1);
    expect(html.match(/data-series="waf"/g)).toHaveLength(1);
    // Served sits on the baseline; the WAF area sits on top of served.
    expect(html).toMatch(/data-series="served" d="M0\.0 [\d.]+ L500\.0 [\d.]+ L1000\.0 [\d.]+ L1000\.0 100\.00 L500\.0 100\.00 L0\.0 100\.00 Z"/);
    expect(html).toContain('fill-opacity:0.22');
    expect(html).toContain('fill-opacity:0.55');
    expect(html).toContain('<caption>Traffic, last 24 hours</caption>');
    expect(html).toContain('<td>320</td>');
  });
});

describe('TopList', () => {
  const rows = [
    { key: 'a', label: 'app.example.com', count: 400, tag: '16% blocked' },
    { key: 'b', label: 'wiki.example.com', count: 100, sub: 'IT' },
    { key: 'c', label: 'Italy', code: 'IT', count: 50, dot: 'var(--served)' },
  ];

  it('sizes share bars against the largest row and shares against the total', () => {
    const html = renderToStaticMarkup(createElement(TopList, { title: 'Hosts', unit: 'Requests', rows, total: 1000 }));
    expect(html).toContain('data-share="100.0%"');
    expect(html).toContain('data-share="25.0%"');
    expect(html).toContain('data-share="12.5%"');
    expect(html).toContain('>40.0%</span>');
    expect(html).toContain('>5.0%</span>');
    expect(html).toContain('<h3 class="m-0 flex-1 text-sm font-semibold">Hosts</h3>');
    expect(html).toContain('16% blocked');
    expect(html).toContain('bg-warn-tint');
    expect(html).toMatch(/<ol /);
  });

  it('shows include and exclude buttons only with their callbacks', () => {
    const none = renderToStaticMarkup(createElement(TopList, { title: 'Hosts', rows }));
    expect(none).not.toContain('<button');
    const both = renderToStaticMarkup(createElement(TopList, { title: 'Countries', dimension: 'Country', rows, onInclude: vi.fn(), onExclude: vi.fn() }));
    expect(both).toContain('aria-label="Only: Country is app.example.com"');
    expect(both).toContain('aria-label="Exclude: Country is app.example.com"');
    // Labelled in words, which the accessible names start with.
    expect(both).toMatch(/>Only<\/button>/);
    expect(both).toMatch(/>Exclude<\/button>/);
    // A row with a code filters on the code.
    expect(both).toContain('aria-label="Only: Country is IT"');
    const include = renderToStaticMarkup(createElement(TopList, { title: 'Hosts', rows, onInclude: vi.fn() }));
    expect(include).toContain('aria-label="Only: Hosts is wiki.example.com"');
    expect(include).not.toContain('Exclude');
  });

  it('says when nothing matches and hides the footer link then', () => {
    const html = renderToStaticMarkup(createElement(TopList, { title: 'Source networks', rows: [], emptyText: 'Needs the AS number of each request.', moreHref: '/analytics' }));
    expect(html).toContain('Needs the AS number of each request.');
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('View all');
    const more = renderToStaticMarkup(createElement(TopList, { rows, moreHref: '/analytics?dim=host', moreLabel: 'View all 50 hosts' }));
    expect(more).toContain('View all 50 hosts');
  });

  it('draws a status-class share bar when given segments', () => {
    const html = renderToStaticMarkup(
      createElement(TopList, { title: 'Status codes', rows, segments: [{ label: '2xx', fraction: 0.726, color: 'var(--served)' }, { label: '5xx', fraction: 0.0023, color: 'var(--err5)' }] })
    );
    expect(html).toContain('width:72.6%;background:var(--served)');
    expect(html).toContain('5xx <span class="num">0.23%</span>');
  });

  it('fits the count column to the longest count, the same on every row', () => {
    const short = renderToStaticMarkup(createElement(TopList, { rows }));
    expect(short.match(/width:max\(52px, 3\.5ch\)/g)).toHaveLength(3);
    const money = [
      { key: 'a', label: 'Acme', count: 123456.78 },
      { key: 'b', label: 'Globex', count: 9.5 },
    ];
    const format = (value: number) => `€${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const html = renderToStaticMarkup(createElement(TopList, { rows: money, formatCount: format }));
    expect(html).toContain('€123,456.78');
    expect(html.match(/width:max\(52px, 11\.5ch\)/g)).toHaveLength(2);
    const fixed = renderToStaticMarkup(createElement(TopList, { rows: money, formatCount: format, countWidth: 120 }));
    expect(fixed.match(/width:120px/g)).toHaveLength(2);
  });
});

describe('ExpiryTimeline', () => {
  const items = [
    { id: 'a', label: 'auth.example.com', daysLeft: 31 },
    { id: 'b', label: 'tv.example.com', daysLeft: 60, href: '/certificates?id=b' },
    { id: 'c', label: 'old.example.com', daysLeft: -3 },
    { id: 'd', label: 'soon.example.com', daysLeft: 5 },
    { id: 'e', label: 'due.example.com', daysLeft: 20 },
    { id: 'f', label: 'x.example.com', daysLeft: 86 },
    { id: 'g', label: 'y.example.com', daysLeft: 87 },
  ];

  it('derives tones from days left', () => {
    expect(expiryTone(-1)).toBe('bad');
    expect(expiryTone(6)).toBe('bad');
    expect(expiryTone(7)).toBe('warn');
    expect(expiryTone(30)).toBe('warn');
    expect(expiryTone(31)).toBe('ok');
    expect(expiryText(-1)).toBe('expired 1 day ago');
    expect(expiryText(0)).toBe('expires today');
    expect(expiryText(42)).toBe('42 days left');
  });

  it('places markers on the axis, pins expired ones at today and stacks close ones', () => {
    const placed = placeExpiryItems(items);
    const by = Object.fromEntries(placed.map((p) => [p.item.id, p]));
    expect(by.c.position).toBe(0);
    expect(by.a.position).toBeCloseTo(31 / 90, 5);
    expect(by.f.position).toBeCloseTo(86.5 / 90, 5);
    expect(by.g.position).toBe(by.f.position);
    expect([by.f.stack, by.g.stack]).toEqual([0, 1]);
    expect(placed.map((p) => p.item.id)).toEqual(['c', 'd', 'e', 'a', 'b', 'f', 'g']);
  });

  it('renders an ordered list of markers coloured by urgency with a renewal band', () => {
    const html = renderToStaticMarkup(createElement(ExpiryTimeline, { items, title: 'Certificate expiry' }));
    expect(html).toContain('<ol aria-label="Certificate expiry"');
    expect(html).toContain('data-tone="bad" data-position="0.000%"');
    expect(html).toContain('data-position="34.444%"');
    expect(html).toContain('<span class="sr-only">auth.example.com: 31 days left</span>');
    expect(html).toContain('<span class="sr-only">old.example.com: expired 3 days ago</span>');
    expect(html).toMatch(/<a aria-label="tv.example.com: 60 days left"[^>]*href="\/certificates\?id=b"/);
    expect(html).toContain('width:33.333%');
    expect(html).toContain('Renewal window');
    expect(html).toContain('Under 30 days left');
    expect(html).toContain('1 already expired');
    expect(html).toContain('>Today<');
    expect(html).toContain('>90 days<');
    expect(html.indexOf('bg-bad')).toBeGreaterThan(-1);
    expect(html.indexOf('bg-warn ')).toBeGreaterThan(-1);
  });

  it('shows dates on the axis when given today, and buttons when selectable', () => {
    const html = renderToStaticMarkup(
      createElement(ExpiryTimeline, { items: [items[0]], now: Date.UTC(2026, 9, 3), onSelect: vi.fn(), selectedId: 'a', legend: false })
    );
    expect(html).toContain('3 Oct · today');
    expect(html).toContain('>18 Oct<');
    expect(html).toContain('>1 Jan<');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('border-foreground');
    expect(html).not.toContain('Renews on schedule');
  });
});
