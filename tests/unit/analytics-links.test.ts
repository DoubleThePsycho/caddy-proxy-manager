/**
 * Links into the analytics and security events pages
 * (src/lib/analytics/links.ts): a range or a custom from/to, the filters as
 * the JSON array the analytics API takes, and the kind of security event.
 */
import { describe, expect, it } from 'vitest';
import { analyticsHref, securityHref } from '@/src/lib/analytics/links';
import { parseFilters } from '@/src/lib/analytics/filters';
import { resolveRange } from '@/src/lib/analytics/range';

function params(href: string): URLSearchParams {
  return new URL(href, 'http://localhost').searchParams;
}

describe('analytics links', () => {
  it('puts the range and the filters as JSON in the query string', () => {
    expect(analyticsHref()).toBe('/analytics?range=24h');
    const href = analyticsHref([{ dim: 'host', value: 'mail.example.com' }, { dim: 'status', value: '5xx' }, { dim: 'outcome', op: 'is_not', value: 'served' }], '7d');
    expect(href.startsWith('/analytics?range=7d&filters=')).toBe(true);
    const filters = JSON.parse(params(href).get('filters')!);
    expect(filters).toEqual([
      { dim: 'host', op: 'is', value: 'mail.example.com' },
      { dim: 'status', op: 'is', value: '5xx' },
      { dim: 'outcome', op: 'is_not', value: 'served' },
    ]);
    // What the analytics API reads from the same parameter.
    expect(parseFilters(params(href).get('filters'))).toHaveLength(3);
  });

  it('keeps values with reserved characters intact and drops empty ones', () => {
    const href = analyticsHref([{ dim: 'path', value: '/a b?c=1&d#e' }, { dim: 'waf_rule', value: 920450 }, { dim: 'host', value: '' }]);
    expect(JSON.parse(params(href).get('filters')!)).toEqual([
      { dim: 'path', op: 'is', value: '/a b?c=1&d#e' },
      { dim: 'waf_rule', op: 'is', value: '920450' },
    ]);
    expect(href).not.toContain('#');
  });

  it('takes a custom range in Unix seconds', () => {
    const href = analyticsHref([], { from: 1790992800, to: 1790994600 });
    const query = params(href);
    expect([query.get('range'), query.get('from'), query.get('to')]).toEqual(['custom', '1790992800', '1790994600']);
    expect(resolveRange({ range: query.get('range'), from: query.get('from'), to: query.get('to') }, 1791000000)).toMatchObject({ preset: 'custom', start: 1790992800 });
  });
});

describe('security event links', () => {
  it('opens the events list of one kind, with filters and range', () => {
    const href = securityHref({ kind: 'geo', filters: [{ dim: 'host', value: 'example.com' }, { dim: 'path', value: '/portal' }] });
    expect(href.startsWith('/security?range=24h&kind=geo&filters=')).toBe(true);
    expect(href.endsWith('#events')).toBe(true);
    expect(JSON.parse(params(href).get('filters')!)).toEqual([
      { dim: 'host', op: 'is', value: 'example.com' },
      { dim: 'path', op: 'is', value: '/portal' },
    ]);
    expect(securityHref()).toBe('/security?range=24h#events');
    expect(securityHref({ range: { from: 100, to: 1900 } })).toBe('/security?range=custom&from=100&to=1900#events');
  });
});
