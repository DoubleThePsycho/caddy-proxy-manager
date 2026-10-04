/**
 * The Security events page's pure helpers: the URL state, links to the
 * analytics page, event wording, rule categories and "copy as curl" (whose
 * input is attacker-controlled request data), plus the /waf/events redirect
 * and the raw audit record action.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ctx = vi.hoisted(() => ({
  allowed: true,
  checked: [] as string[],
  events: new Map<string, { rawData: string | null }>(),
  lookups: [] as string[],
}));

vi.mock('@/src/lib/auth', () => ({
  requirePermission: vi.fn(async (permission: string) => {
    ctx.checked.push(permission);
    if (!ctx.allowed) throw new Error('NEXT_REDIRECT');
    return { user: { id: '1' } };
  }),
}));
vi.mock('@/src/lib/models/waf-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/models/waf-events')>();
  return {
    isWafEventId: actual.isWafEventId,
    getWafEventByEventId: vi.fn(async (id: string) => {
      ctx.lookups.push(id);
      return ctx.events.get(id) ?? null;
    }),
  };
});

import {
  analyticsHref,
  curlCommand,
  DEFAULT_QUERY,
  eventActionLabel,
  eventExplanation,
  eventReason,
  eventTime,
  readFilters,
  relativeTime,
  ruleCategory,
  securityHref,
  shellQuote,
  withFilter,
} from '@/app/(dashboard)/security/security-view';
import { fromUtcInput, toUtcInput } from '@/app/(dashboard)/security/RangeControl';
import { GET as wafEventsRedirect } from '@/app/(dashboard)/waf/events/route';
import { wafAuditRecordAction } from '@/app/(dashboard)/security/actions';

beforeEach(() => {
  ctx.allowed = true;
  ctx.checked = [];
  ctx.events.clear();
  ctx.lookups = [];
});

describe('URL state', () => {
  it('builds the page URL, leaving defaults out and the page at 1 unless asked', () => {
    expect(securityHref(DEFAULT_QUERY)).toBe('/security');
    const query = { ...DEFAULT_QUERY, range: '24h', kind: 'waf', page: 3 };
    expect(securityHref(query, {}, '#events')).toBe('/security?range=24h&kind=waf#events');
    expect(securityHref(query, { page: 4 })).toBe('/security?range=24h&kind=waf&page=4');
    expect(securityHref(query, { range: 'custom', from: 100, to: 200 })).toBe('/security?range=custom&from=100&to=200&kind=waf');
    // A custom range without both ends is dropped rather than half-written.
    expect(securityHref(query, { range: 'custom', from: 100, to: null })).toBe('/security?kind=waf');
  });

  it('round-trips filters through the URL and reads hostile input leniently', () => {
    const filters = withFilter(DEFAULT_QUERY, { dim: 'host', op: 'is', value: 'app.example.com' });
    const href = securityHref(DEFAULT_QUERY, { filters: withFilter({ ...DEFAULT_QUERY, filters }, { dim: 'waf_rule', op: 'is_not', value: '930130' }) });
    const raw = new URL(href, 'https://dash.example.com').searchParams.get('filters');
    expect(readFilters(raw)).toEqual([
      { dim: 'host', op: 'is', value: 'app.example.com' },
      { dim: 'waf_rule', op: 'is_not', value: '930130' },
    ]);
    expect(withFilter({ ...DEFAULT_QUERY, filters }, filters[0])).toHaveLength(1);
    expect(readFilters('not json')).toEqual([]);
    expect(readFilters('{"dim":"host"}')).toEqual([]);
    expect(readFilters('[null, 3, {"dim":1,"value":"x"}, {"dim":"ip","op":"not","value":7}]')).toEqual([{ dim: 'ip', op: 'is_not', value: '7' }]);
    expect(readFilters(JSON.stringify(Array.from({ length: 50 }, () => ({ dim: 'ip', value: '192.0.2.1' }))))).toHaveLength(20);
  });

  it('links to the analytics page with the same range and analytics filters', () => {
    expect(analyticsHref(DEFAULT_QUERY)).toBe('/analytics?range=7d');
    const href = analyticsHref({ range: 'custom', from: 10, to: 20 }, [{ dim: 'ip', op: 'is', value: '192.0.2.1' }]);
    const url = new URL(href, 'https://dash.example.com');
    expect(url.pathname).toBe('/analytics');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      range: 'custom',
      from: '10',
      to: '20',
      filters: '[{"dim":"ip","op":"is","value":"192.0.2.1"}]',
    });
  });

  it('reads and writes custom range fields in UTC', () => {
    expect(toUtcInput(1_790_424_000)).toBe('2026-09-26T12:00');
    expect(fromUtcInput('2026-09-26T12:00')).toBe(1_790_424_000);
    expect(fromUtcInput('2026-09-26')).toBeNull();
    expect(fromUtcInput('')).toBeNull();
  });
});

describe('event wording', () => {
  const base = { blocked: true, status: 403, country: 'DE', ruleId: null, message: null, ip: '192.0.2.1' };

  it('names the action and the rule that stopped each kind', () => {
    expect(eventActionLabel({ kind: 'waf', blocked: true })).toBe('Blocked by WAF');
    expect(eventActionLabel({ kind: 'waf', blocked: false })).toBe('Logged by WAF');
    expect(eventActionLabel({ kind: 'rate_limit', blocked: true })).toBe('Rate limited');
    expect(eventReason({ ...base, kind: 'waf', ruleId: 930130, message: 'Restricted file access attempt' })).toBe('Restricted file access attempt');
    expect(eventReason({ ...base, kind: 'waf', ruleId: 930130 })).toBe('Rule 930130');
    expect(eventReason({ ...base, kind: 'geo' })).toBe('Country, continent or network rule (DE)');
    expect(eventReason({ ...base, kind: 'geo', country: 'XX' })).toBe('Country, continent or network rule');
    expect(eventReason({ ...base, kind: 'access', status: 401 })).toBe('Access list: no valid user name and password');
    expect(eventReason({ ...base, kind: 'access' })).toBe('Address rule: the address is blocked');
    expect(eventReason({ ...base, kind: 'auth', status: 302 })).toContain('sign-in');
    expect(eventExplanation({ ...base, kind: 'geo' })).toContain('192.0.2.1 is in DE');
    expect(eventExplanation({ ...base, kind: 'geo', country: 'LAN' })).toContain('fails closed');
    expect(eventExplanation({ ...base, kind: 'rate_limit', status: 429 })).toContain('429');
  });

  it('formats times in UTC and relative to now', () => {
    expect(eventTime(1_790_424_005)).toBe('26 Sep 12:00:05');
    expect(relativeTime(1000, 1030)).toBe('just now');
    expect(relativeTime(1000, 1000 + 5 * 60)).toBe('5 min ago');
    expect(relativeTime(1000, 1000 + 3 * 3600)).toBe('3 h ago');
    expect(relativeTime(1000, 1000 + 2 * 86_400)).toBe('2 d ago');
  });

  it('puts Core Rule Set rules in a category and leaves custom rules out', () => {
    expect(ruleCategory(930130)).toBe('File access');
    expect(ruleCategory(920450)).toBe('Protocol');
    expect(ruleCategory(942100)).toBe('SQL injection');
    expect(ruleCategory(9001)).toBeNull();
  });
});

describe('copy as curl', () => {
  it('quotes a single quote so it cannot end the word', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('repeats the request with its headers, every value quoted', () => {
    const command = curlCommand({
      method: 'post',
      host: 'app.example.com',
      uri: "/search?q=' ; rm -rf / #",
      headers: {
        Host: ['app.example.com'],
        'User-Agent': ['sqlmap/1.8'],
        'Content-Length': ['12'],
        'X-Test': ["a'b", 'c'],
      },
    });
    expect(command).toBe(
      `curl -X POST 'https://app.example.com/search?q='\\'' ; rm -rf / #' -H 'User-Agent: sqlmap/1.8' -H 'X-Test: a'\\''b' -H 'X-Test: c'`
    );
  });

  it('removes control characters and drops header names that are not tokens', () => {
    const command = curlCommand({
      method: 'GET\n; id',
      host: 'app.example.com\n',
      uri: 'admin\r\nX: y',
      headers: { 'Bad Header': ['x'], 'X-Bad\nName': ['$(id)'], 'X-Fine': ['line1\nline2\u0000'] },
    });
    expect(['\n', '\r', '\u0000'].some((character) => command.includes(character))).toBe(false);
    expect(command.startsWith("curl 'https://app.example.com/admin  X: y'")).toBe(true);
    expect(command).not.toContain('Bad Header');
    expect(command).toContain(`-H 'X-Fine: line1 line2 '`);
    // A name with a newline is not a token: the header is left out rather than quoted.
    expect(command).not.toContain('$(id)');
  });
});

describe('/waf/events', () => {
  const redirect = (search: string) => wafEventsRedirect(new NextRequest(`http://localhost:3000/waf/events${search}`));

  it('sends old links to Security events filtered to the WAF, keeping the range', () => {
    const plain = redirect('');
    expect(plain.status).toBe(307);
    expect(plain.headers.get('location')).toBe('/security?kind=waf');
    expect(redirect('?range=7d&page=3&search=x').headers.get('location')).toBe('/security?kind=waf&range=7d');
    expect(redirect('?range=custom&from=100&to=200').headers.get('location')).toBe('/security?kind=waf&range=custom&from=100&to=200');
    expect(redirect('?range=all').headers.get('location')).toBe('/security?kind=waf');
    expect(redirect('?range=custom&from=x&to=200').headers.get('location')).toBe('/security?kind=waf');
  });
});

describe('raw audit record', () => {
  it('needs waf:read before reading anything', async () => {
    ctx.allowed = false;
    await expect(wafAuditRecordAction('tx-1')).rejects.toThrow();
    expect(ctx.checked).toEqual(['waf:read']);
    expect(ctx.lookups).toEqual([]);
  });

  it('refuses ids that are not event ids without a query', async () => {
    expect(await wafAuditRecordAction("x' OR 1=1")).toEqual({ ok: false, error: 'This is not a WAF event id.' });
    expect(ctx.lookups).toEqual([]);
  });

  it('returns the stored record pretty-printed', async () => {
    ctx.events.set('tx-1', { rawData: '{"transaction":{"id":"tx-1"}}' });
    ctx.events.set('tx-2', { rawData: null });
    expect(await wafAuditRecordAction('tx-1')).toEqual({ ok: true, value: '{\n  "transaction": {\n    "id": "tx-1"\n  }\n}' });
    expect(await wafAuditRecordAction('tx-2')).toEqual({ ok: false, error: 'No audit record was stored with this event.' });
    expect(await wafAuditRecordAction('tx-3')).toEqual({ ok: false, error: 'This event is no longer stored.' });
  });
});
