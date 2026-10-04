/**
 * Functional tests: what the log parser records for each request and the
 * /api/v1/analytics endpoints, end to end through Caddy, the access log,
 * waf-rules.log and ClickHouse.
 *
 * - A request the WAF blocks is stored with outcome "waf" and the rule that
 *   blocked it (correlated with Coraza's "WAF rule violation detected" line
 *   in waf-rules.log); an ordinary one with outcome "served", its duration
 *   and user-agent family, and its path without the query string.
 * - The query, host summary and saved view endpoints answer with that data.
 *
 * Access logging is off by default in the test stack: it is switched on for
 * these tests and off again afterwards.
 *
 * Domain: func-analytics.test
 */
import { test, expect, type Page } from '@playwright/test';
import { httpGet, waitForRoute } from '../../helpers/http';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const DOMAIN = 'func-analytics.test';
const HEADERS = { 'Content-Type': 'application/json', Origin: BASE_URL };
// The log parser reads the access log every 30 seconds.
const INGEST_TIMEOUT_MS = 100_000;

type LoggedRequest = { outcome: string; path: string; status: number; userAgent: string; wafRuleId: number; durationMs: number };

let hostId = 0;

const hostFilter = () => encodeURIComponent(JSON.stringify([{ dim: 'host', op: 'is', value: DOMAIN }]));

async function waitForRequests(page: Page, predicate: (rows: LoggedRequest[]) => boolean): Promise<LoggedRequest[]> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  let rows: LoggedRequest[] = [];
  while (Date.now() < deadline) {
    const res = await page.request.get(`${API}/analytics/requests?range=1h&limit=100&filters=${hostFilter()}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
    rows = body.requests;
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Requests not ingested in time (${rows.length} seen)`);
}

test.describe.serial('Analytics outcomes', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const logging = await page.request.put(`${API}/settings/logging`, { data: { enabled: true, format: 'json' }, headers: HEADERS });
    expect(logging.ok(), await logging.text()).toBe(true);
    const res = await page.request.post(`${API}/proxy-hosts`, {
      headers: HEADERS,
      data: {
        name: 'Functional analytics',
        domains: [DOMAIN],
        upstreams: ['echo-server:8080'],
        sslForced: false,
        waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    hostId = (await res.json()).id;
    await waitForRoute(DOMAIN);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    if (hostId) await page.request.delete(`${API}/proxy-hosts/${hostId}`, { headers: HEADERS });
    await page.request.put(`${API}/settings/logging`, { data: { enabled: false, format: 'json' }, headers: HEADERS });
    await page.close();
  });

  test('records the outcome, WAF rule, duration and user-agent family of each request', async ({ page }) => {
    test.setTimeout(INGEST_TIMEOUT_MS + 60_000);
    const clean = await httpGet(DOMAIN, '/analytics-clean?token=secret-value', { 'User-Agent': 'analytics-e2e/1.0' });
    expect(clean.status).toBe(200);
    const blocked = await httpGet(DOMAIN, '/analytics-blocked?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(blocked.status).toBe(403);

    const rows = await waitForRequests(
      page,
      (list) => list.some((r) => r.path === '/analytics-clean') && list.some((r) => r.path === '/analytics-blocked')
    );
    const served = rows.find((r) => r.path === '/analytics-clean')!;
    expect(served).toMatchObject({ outcome: 'served', status: 200, userAgent: 'analytics-e2e 1.0', wafRuleId: 0 });
    expect(served.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(rows)).not.toContain('secret-value');

    const waf = rows.find((r) => r.path === '/analytics-blocked')!;
    expect(waf.outcome).toBe('waf');
    expect(waf.status).toBe(403);
    expect(waf.wafRuleId).toBeGreaterThan(0);
  });

  test('the query and host summary count them', async ({ page }) => {
    const query = await (await page.request.get(`${API}/analytics/query?range=1h&filters=${hostFilter()}`)).json();
    expect(query.status).toBe('ok');
    expect(query.headline.requests.value).toBeGreaterThanOrEqual(2);
    expect(query.headline.mitigated.value).toBeGreaterThanOrEqual(1);
    expect(query.series.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['served', 'waf']));

    const outcomes = await (await page.request.get(`${API}/analytics/top?range=1h&dimensions=outcome&filters=${hostFilter()}`)).json();
    expect(outcomes.dimensions[0].rows.map((r: { value: string }) => r.value)).toEqual(expect.arrayContaining(['served', 'waf']));

    const host = await (await page.request.get(`${API}/analytics/hosts/${hostId}?range=1h`)).json();
    expect(host.status).toBe('ok');
    expect(host.totals.requests).toBeGreaterThanOrEqual(2);
    expect(host.totals.mitigated).toBeGreaterThanOrEqual(1);

    const list = await (await page.request.get(`${API}/analytics/hosts?range=24h&ids=${hostId}`)).json();
    expect(list.hosts).toEqual([expect.objectContaining({ proxyHostId: hostId })]);
    expect(list.hosts[0].requests).toBeGreaterThanOrEqual(2);
  });

  test('saved views round-trip', async ({ page }) => {
    const created = await page.request.post(`${API}/analytics/views`, {
      headers: HEADERS,
      data: { name: 'Functional analytics view', range: '7d', metric: 'mitigated', filters: [{ dim: 'host', value: DOMAIN }] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const view = await created.json();
    expect(view).toMatchObject({ name: 'Functional analytics view', range: { preset: '7d' }, metric: 'mitigated', owned: true });

    const listed = await (await page.request.get(`${API}/analytics/views`)).json();
    expect(listed.some((v: { id: number }) => v.id === view.id)).toBe(true);

    const removed = await page.request.delete(`${API}/analytics/views/${view.id}`, { headers: HEADERS });
    expect(removed.ok()).toBe(true);
    expect((await page.request.get(`${API}/analytics/views/${view.id}`)).status()).toBe(404);
  });
});
