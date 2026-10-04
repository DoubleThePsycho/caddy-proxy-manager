/**
 * Functional tests: access list rules enforced by the real Caddy.
 *
 * The test client reaches Caddy from a private address (the Docker bridge),
 * so private_ranges stands for "this client". Covers the default action,
 * first-match ordering, the custom deny response, a country rule (the
 * caddy-blocker handler, with no GeoLite2 match for a private address) and
 * the global Blocked sources list, which applies to hosts without a list.
 *
 * Domains: func-acl.test, func-acl-open.test
 */
import { resolve } from 'node:path';
import { test, expect, request as playwrightRequest } from '@playwright/test';
import { httpGet, waitForRoute, waitForStatus } from '../../helpers/http';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', Origin: BASE_URL };
const DOMAIN = 'func-acl.test';
const OPEN_DOMAIN = 'func-acl-open.test';
const ECHO_BODY = 'echo-ok';

test.describe.serial('Access list rules', () => {
  let listId: number | null = null;
  const hostIds: number[] = [];

  test.afterAll(async () => {
    const request = await playwrightRequest.newContext({ storageState: resolve(__dirname, '../../.auth/admin.json') });
    // Never leave anything blocked for the specs that follow.
    const entries = await request.get(`${API}/access-lists/blocked-sources/entries`);
    if (entries.ok()) {
      for (const entry of (await entries.json()) as Array<{ id: number }>) {
        await request.delete(`${API}/access-lists/blocked-sources/entries/${entry.id}`, { headers: HEADERS });
      }
    }
    for (const id of hostIds) await request.delete(`${API}/proxy-hosts/${id}`, { headers: HEADERS });
    if (listId !== null) await request.delete(`${API}/access-lists/${listId}`, { headers: HEADERS });
    await request.dispose();
  });

  test('setup: a list that denies everyone, with a custom response', async ({ request }) => {
    const listRes = await request.post(`${API}/access-lists`, {
      headers: HEADERS,
      data: { name: 'Functional ACL', defaultAction: 'deny', denyStatus: 451, denyBody: 'Not from here' },
    });
    expect(listRes.status()).toBe(201);
    listId = ((await listRes.json()) as { id: number }).id;

    for (const [name, domain, accessListId] of [
      ['Functional ACL host', DOMAIN, listId],
      ['Functional ACL open host', OPEN_DOMAIN, null],
    ] as const) {
      const hostRes = await request.post(`${API}/proxy-hosts`, {
        headers: HEADERS,
        data: { name, domains: [domain], upstreams: ['echo-server:8080'], sslForced: false, accessListId },
      });
      expect(hostRes.status()).toBe(201);
      hostIds.push(((await hostRes.json()) as { id: number }).id);
    }
    await waitForRoute(OPEN_DOMAIN);
    await waitForStatus(DOMAIN, 451);
  });

  test('an unmatched request gets the custom deny response', async () => {
    const res = await httpGet(DOMAIN);
    expect(res.status).toBe(451);
    expect(res.body).toBe('Not from here');
  });

  test('an allow rule for the client lets it through', async ({ request }) => {
    const res = await request.put(`${API}/access-lists/${listId}/rules`, {
      headers: HEADERS,
      data: { rules: [{ action: 'allow', kind: 'ip', values: ['private_ranges'] }] },
    });
    expect(res.status()).toBe(200);
    await waitForStatus(DOMAIN, 200);
    expect((await httpGet(DOMAIN)).body).toContain(ECHO_BODY);
  });

  test('the first matching rule decides', async ({ request }) => {
    // Deny first, allow second: the deny wins.
    const denyFirst = await request.put(`${API}/access-lists/${listId}/rules`, {
      headers: HEADERS,
      data: {
        rules: [
          { action: 'deny', kind: 'ip', values: ['private_ranges'] },
          { action: 'allow', kind: 'ip', values: ['private_ranges'] },
        ],
      },
    });
    expect(denyFirst.status()).toBe(200);
    await waitForStatus(DOMAIN, 451);

    // Reorder: the allow is now first and wins.
    const rules = (await denyFirst.json()) as Array<{ id: number }>;
    const reorder = await request.post(`${API}/access-lists/${listId}/rules/reorder`, {
      headers: HEADERS,
      data: { ruleIds: [rules[1].id, rules[0].id] },
    });
    expect(reorder.status()).toBe(200);
    await waitForStatus(DOMAIN, 200);
  });

  test('a country allow does not cover a private address: the default deny applies', async ({ request }) => {
    const res = await request.put(`${API}/access-lists/${listId}/rules`, {
      headers: HEADERS,
      data: { rules: [{ action: 'allow', kind: 'country', values: ['IT'] }] },
    });
    expect(res.status()).toBe(200);
    await waitForStatus(DOMAIN, 451);
  });

  test('Blocked sources applies to a host without a list, and lifts when the entry is removed', async ({ request }) => {
    expect((await httpGet(OPEN_DOMAIN)).status).toBe(200);
    const block = await request.post(`${API}/access-lists/blocked-sources/entries`, {
      headers: HEADERS,
      data: { address: 'private_ranges', reason: 'Functional test', expiresInSeconds: 300 },
    });
    expect(block.status()).toBe(201);
    const entry = (await block.json()) as { id: number };
    await waitForStatus(OPEN_DOMAIN, 403);
    expect((await httpGet(OPEN_DOMAIN)).body).toBe('Forbidden');

    const unblock = await request.delete(`${API}/access-lists/blocked-sources/entries/${entry.id}`, { headers: HEADERS });
    expect(unblock.status()).toBe(200);
    await waitForStatus(OPEN_DOMAIN, 200);
  });
});
