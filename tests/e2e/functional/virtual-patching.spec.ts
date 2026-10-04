/**
 * Functional test: a virtual patch (ee/rule-feed) enforced by the real Caddy
 * and Coraza.
 *
 * The test stack has no license, and Caddy never checks one, so the example
 * Log4Shell pack (ee/rule-feed/examples/ivp-2021-44228.json) is written
 * straight into the database in block mode, as a licensed administrator would
 * have turned it on; the configuration is then applied through the normal
 * path. Turning the patch off needs no license and goes through the REST API.
 *
 * The host runs the WAF without the Core Rule Set, so a 403 can only come
 * from the patch. Every positive sample of the pack must get 403 and every
 * negative one must reach the upstream.
 *
 * Domain: func-virtual-patch.test
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { waitForRoute } from '../../helpers/http';
import { webSql } from '../../helpers/e2e-sql';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', Origin: BASE_URL };
const DOMAIN = 'func-virtual-patch.test';
const ECHO_BODY = 'echo-ok';

type Sample = { method: string; path: string; headers?: Record<string, string>; body?: string };
type Pack = {
  id: string; title: string; summary: string; severity: string; cves: string[]; affected: unknown[]; references: string[];
  rules: string[]; samples: { positive: Sample[]; negative: Sample[] }; defaultMode: string; publishedAt: string; updatedAt: string;
};

const pack = JSON.parse(readFileSync(resolve(__dirname, '../../../ee/rule-feed/examples/ivp-2021-44228.json'), 'utf8')) as Pack;

/** Sends a sample request to Caddy on port 80 with the test host name. */
function send(sample: Sample): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: 80, path: sample.path, method: sample.method, headers: { Host: DOMAIN, ...(sample.headers ?? {}) } },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => done({ status: res.statusCode!, body }));
      }
    );
    req.on('error', fail);
    if (sample.body !== undefined) req.write(sample.body);
    req.end();
  });
}

async function waitForSampleStatus(sample: Sample, status: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = (await send(sample)).status;
    if (last === status) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${sample.method} ${sample.path} did not get ${status} (last ${last})`);
}

/** Writes the pack in `mode`, as a licensed administrator would have turned it on. */
function storePatch(mode: 'block' | 'detect'): void {
  const now = new Date().toISOString();
  const values = [
    pack.id, pack.title, pack.summary, pack.severity, JSON.stringify(pack.cves), JSON.stringify(pack.affected),
    JSON.stringify(pack.references), JSON.stringify(pack.rules), JSON.stringify([1800000101]), JSON.stringify(pack.samples),
    pack.defaultMode, true, pack.publishedAt, pack.updatedAt, mode, now, 1, now, now,
  ];
  webSql(
    'INSERT INTO virtual_patches (id, title, summary, severity, cves, affected, "referenceUrls", rules, "ruleIds", samples, "defaultMode", example, "publishedAt", "packUpdatedAt", mode, "modeChangedAt", "feedSequence", "firstSeenAt", "updatedAt") ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, rules = excluded.rules, "modeChangedAt" = excluded."modeChangedAt"',
    values
  );
}

test.describe.serial('Virtual patching', () => {
  let hostId: number | null = null;

  test.afterAll(async ({ browser }) => {
    webSql('DELETE FROM virtual_patches WHERE id = ?', [pack.id]);
    const page = await browser.newPage();
    if (hostId !== null) await page.request.delete(`${API}/proxy-hosts/${hostId}`, { headers: HEADERS });
    await page.request.post(`${API}/caddy/apply`, { headers: HEADERS });
    await page.close();
  });

  test('setup: a host with the WAF on and without the Core Rule Set', async ({ page }) => {
    const res = await page.request.post(`${API}/proxy-hosts`, {
      headers: HEADERS,
      data: {
        name: 'Functional virtual patch',
        domains: [DOMAIN],
        upstreams: ['echo-server:8080'],
        sslForced: false,
        waf: { enabled: true, mode: 'On', load_owasp_crs: false, waf_mode: 'override' },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    hostId = (await res.json()).id;
    await waitForRoute(DOMAIN);
  });

  test('without the patch, the exploit request reaches the upstream', async () => {
    const res = await send(pack.samples.positive[0]);
    expect(res.status).toBe(200);
    expect(res.body).toContain(ECHO_BODY);
  });

  test('in block mode, matching requests get 403 and harmless ones pass', async ({ page }) => {
    storePatch('block');
    const apply = await page.request.post(`${API}/caddy/apply`, { headers: HEADERS });
    expect(apply.ok(), await apply.text()).toBe(true);
    await waitForSampleStatus(pack.samples.positive[0], 403);

    for (const sample of pack.samples.positive) {
      expect((await send(sample)).status, `${sample.method} ${sample.path} ${JSON.stringify(sample.headers ?? {})}`).toBe(403);
    }
    for (const sample of pack.samples.negative) {
      const res = await send(sample);
      expect(res.status, `${sample.method} ${sample.path}`).toBe(200);
      expect(res.body).toContain(ECHO_BODY);
    }

    const patch = await page.request.get(`${API}/waf/virtual-patches/${pack.id}`);
    expect(patch.ok()).toBe(true);
    expect(await patch.json()).toMatchObject({ id: pack.id, mode: 'block', ruleIds: [1800000101], cves: pack.cves });
  });

  test('turning the patch off needs no license and lets the request through again', async ({ page }) => {
    const res = await page.request.put(`${API}/waf/virtual-patches/${pack.id}`, { headers: HEADERS, data: { mode: 'off' } });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'off' });
    await waitForSampleStatus(pack.samples.positive[0], 200);
    const refused = await page.request.put(`${API}/waf/virtual-patches/${pack.id}`, { headers: HEADERS, data: { mode: 'block' } });
    expect(refused.status()).toBe(403);
  });
});
