/**
 * Virtual patching (ee/rule-feed) through its REST API and service with a
 * real database: the license gate (subscribing, importing, fetching and
 * turning patches on need it; unsubscribing, turning patches off, reading,
 * the scheduled fetch and the Caddy configuration never do), verification
 * before anything is stored (signature, rollback, allowlist), new patches in
 * detection and automatic blocking of critical ones, withdrawn packs, the
 * rollback when Caddy refuses the patches, fetching (redirects, size, HTTP
 * errors), instance sync to replicas, events lookup, the permission and the
 * OpenAPI entries.
 *
 * Virtual patching ships switched off (coming soon): these tests switch it
 * on with setFeatureAvailableForTests, except the "coming soon" block, which
 * checks that nothing can be set up, fetched or scheduled while it is off.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';
import { createFeedSigner, examplePack, examplePacks, signFeed, testPack } from '../helpers/rule-feed';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/auth', () => ({
  auth: vi.fn(async () => null),
  checkSameOrigin: vi.fn(() => null),
  requirePermission: vi.fn(() => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireAdmin())),
  requireAdmin: vi.fn(async () => ({ user: { id: '1', role: 'admin' } })),
}));
vi.mock('@/src/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/api-auth')>()),
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn(async () => ({ userId: 1, role: 'admin', authMethod: 'bearer' })),
}));
vi.mock('@/src/lib/l4-ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/l4-ports')>()),
  applyL4Ports: vi.fn(async () => ({ state: 'idle' })),
  getL4PortsDiff: vi.fn(async () => ({ needsApply: false })),
}));

import { GET as getFeed, PUT as putFeed } from '@/app/api/v1/waf/rule-feed/route';
import { POST as fetchFeed } from '@/app/api/v1/waf/rule-feed/fetch/route';
import { POST as importFeed } from '@/app/api/v1/waf/rule-feed/import/route';
import { GET as listPatches } from '@/app/api/v1/waf/virtual-patches/route';
import { GET as getPatch, PUT as putPatch } from '@/app/api/v1/waf/virtual-patches/[id]/route';
import { GET as getOpenApi } from '@/app/api/v1/openapi.json/route';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { CaddyApplyError } from '@/src/lib/caddy-apply-error';
import { logAuditEvent } from '@/src/lib/audit';
import { applySyncPayload, buildSyncPayload } from '@/src/lib/instance-sync';
import { canonicalSyncContent } from '@/src/lib/instance-sync-fingerprint';
import { ADMIN_LEVEL_PERMISSIONS, PERMISSION_AREAS, isAdminLevel } from '@/src/lib/permissions';
import { readPaidFeaturesInUse } from '@/src/lib/usage-ping/collect';
import { EDITION_FEATURES, FEATURE_INFO, setFeatureAvailableForTests } from '@/ee/licensing/features';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { FeatureUnavailableError, LICENSE_SETTING_KEY, LicenseRequiredError } from '@/ee/licensing/store';
import { setTrustedRuleFeedKeysForTests } from '@/ee/rule-feed/public-keys';
import { findVirtualPatchRules, loadVirtualPatchDirectives, readRuleFeedState } from '@/ee/rule-feed/store';
import { isFetchDue, runScheduledRuleFeedFetch } from '@/ee/rule-feed/service';
import { ruleFeedTick, setRuleFeedSchedulerGate, startRuleFeedScheduler, stopRuleFeedScheduler } from '@/ee/rule-feed/scheduler';
import type { RulePack, VirtualPatchView } from '@/ee/rule-feed/types';

const licenseSigner = createTestSigner();
const feedSigner = createFeedSigner();
const DAY = 86_400_000;

async function setRow(key: string, value: unknown) {
  const json = JSON.stringify(value);
  const updatedAt = new Date().toISOString();
  await ctx.db.insert(schema.settings).values({ key, value: json, updatedAt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: json, updatedAt } });
}

async function installLicense(edition = 'enterprise') {
  await setRow(LICENSE_SETTING_KEY, signLicense(licenseSigner, licensePayload(licenseSigner, {
    edition, iat: '2026-01-01T00:00:00.000Z', exp: '2099-01-01T00:00:00.000Z',
  })));
}

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, LICENSE_SETTING_KEY));
}

/** A feed valid now, with the example packs unless given others. */
function feed(sequence = 100, packs: unknown[] = examplePacks(), signer = feedSigner): string {
  const now = Date.now();
  return signFeed(signer, {
    v: 1, kid: signer.kid, sequence, issuedAt: new Date(now - DAY).toISOString(), expiresAt: new Date(now + 29 * DAY).toISOString(), packs,
  });
}

function request(method: string, path: string, body?: unknown, raw?: string): NextRequest {
  const content = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(content === undefined ? {} : { body: content, headers: { 'content-type': 'application/json' } }),
  });
}

type Handler = (request: NextRequest, context?: never) => Promise<Response>;

async function call(handler: Handler, method: string, path: string, body?: unknown, raw?: string, params?: Record<string, string>) {
  const response = await handler(request(method, path, body, raw), (params ? { params: Promise.resolve(params) } : undefined) as never);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

const subscribe = (body: unknown) => call(putFeed as Handler, 'PUT', '/api/v1/waf/rule-feed', body);
const importDocument = (document: string) => call(importFeed as Handler, 'POST', '/api/v1/waf/rule-feed/import', undefined, document);
const setMode = (id: string, mode: unknown) =>
  call(putPatch as unknown as Handler, 'PUT', `/api/v1/waf/virtual-patches/${id}`, { mode }, undefined, { id });

async function rows() {
  return await ctx.db.select().from(schema.virtualPatches);
}

async function modes(): Promise<Record<string, string>> {
  return Object.fromEntries((await rows()).map((row) => [row.id, row.mode]));
}

function auditActions(): string[] {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
}

const LICENSE_MESSAGE = new LicenseRequiredError('virtual_patching').message;

beforeEach(() => {
  ctx.db = createTestDb();
  vi.mocked(logAuditEvent).mockClear();
  vi.mocked(applyCaddyConfig).mockReset();
  vi.mocked(applyCaddyConfig).mockResolvedValue({ ok: true } as never);
  delete process.env.INSTANCE_MODE;
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  setTrustedRuleFeedKeysForTests(feedSigner.keys);
  setFeatureAvailableForTests('virtual_patching', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setRuleFeedSchedulerGate(null);
});

afterAll(() => {
  setTrustedLicenseKeysForTests(null);
  setTrustedRuleFeedKeysForTests(null);
  setFeatureAvailableForTests('virtual_patching', null);
});

describe('reading', () => {
  it('shows the default subscription and an empty list without a license', async () => {
    const { status, data } = await call(getFeed as Handler, 'GET', '/api/v1/waf/rule-feed');
    expect(status).toBe(200);
    expect(data).toMatchObject({
      settings: { subscribed: false, feedUrl: 'https://feed.ingres.si/v1/feed.json', autoBlockCritical: false },
      feed: { installed: null, expired: false, lastCheck: null, trustedKeyIds: [feedSigner.kid] },
      counts: { total: 0 },
      available: true,
      configurable: false,
      editable: true,
      source: 'local',
    });
    expect((await call(listPatches as Handler, 'GET', '/api/v1/waf/virtual-patches')).data).toMatchObject({ patches: [], source: 'local' });
  });
});

describe('subscription', () => {
  it('needs the license to subscribe, change the URL or turn on automatic blocking', async () => {
    for (const body of [{ subscribed: true }, { feedUrl: 'https://mirror.example.com/feed.json' }, { autoBlockCritical: true }]) {
      const { status, data } = await subscribe(body);
      expect(status, JSON.stringify(body)).toBe(403);
      expect(data.error).toBe(LICENSE_MESSAGE);
    }
    // Saving what is already stored needs nothing.
    expect((await subscribe({ subscribed: false })).data).toMatchObject({ settings: { subscribed: false } });
    await installLicense('business');
    expect((await subscribe({ subscribed: true })).status).toBe(403);
    expect(auditActions()).toEqual([]);
  });

  it('subscribes with the license, accepts https mirrors only, and records the change', async () => {
    await installLicense();
    const { status, data } = await subscribe({ subscribed: true, feedUrl: 'https://mirror.example.com/v1/feed.json', autoBlockCritical: true });
    expect(status).toBe(200);
    expect(data.settings).toEqual({ subscribed: true, feedUrl: 'https://mirror.example.com/v1/feed.json', autoBlockCritical: true });
    expect(auditActions()).toEqual(['virtual_patching_updated']);
    for (const feedUrl of ['http://mirror.example.com/feed.json', 'https://user:secret@mirror.example.com/feed.json', 'ftp://example.com/x', 'feed.json', 'https://example.com/feed.json#x']) {
      expect((await subscribe({ feedUrl })).status, feedUrl).toBe(400);
    }
    expect((await subscribe({ subscribed: 'yes' })).status).toBe(400);
    expect((await subscribe({ interval: 1 })).status).toBe(400);
  });

  it('can always be turned off after the license lapses', async () => {
    await installLicense();
    await subscribe({ subscribed: true, autoBlockCritical: true });
    await removeLicense();
    const { status, data } = await subscribe({ subscribed: false, autoBlockCritical: false });
    expect(status).toBe(200);
    expect(data.settings).toMatchObject({ subscribed: false, autoBlockCritical: false });
    expect((await subscribe({ subscribed: true })).status).toBe(403);
  });
});

describe('importing a feed', () => {
  it('needs the license', async () => {
    const { status, data } = await importDocument(feed());
    expect(status).toBe(403);
    expect(data.error).toBe(LICENSE_MESSAGE);
    expect(await rows()).toEqual([]);
  });

  it('installs verified packs in detection, applies them once and records it', async () => {
    await installLicense();
    const document = feed();
    const { status, data } = await importDocument(document);
    expect(status).toBe(200);
    expect(data).toMatchObject({ outcome: 'updated', sequence: 100, autoBlocked: [] });
    expect(data.added.sort()).toEqual(['ivp-2021-41773', 'ivp-2021-44228', 'ivp-2022-22965']);
    expect(await modes()).toEqual({ 'ivp-2021-41773': 'detect', 'ivp-2021-44228': 'detect', 'ivp-2022-22965': 'detect' });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(auditActions()).toEqual(['virtual_patch_feed_installed']);
    const state = await readRuleFeedState();
    expect(state.installed).toMatchObject({ sequence: 100, kid: feedSigner.kid, source: 'import', packs: 3 });
    expect(state.lastCheck).toMatchObject({ outcome: 'updated', added: 3, source: 'import' });

    const patch = (await call(getPatch as unknown as Handler, 'GET', '/api/v1/waf/virtual-patches/ivp-2021-44228', undefined, undefined, { id: 'ivp-2021-44228' })).data as VirtualPatchView;
    expect(patch).toMatchObject({ cves: ['CVE-2021-44228', 'CVE-2021-45046'], severity: 'critical', mode: 'detect', ruleIds: [1800000101], example: true });
    expect(patch.samples.positive.length).toBeGreaterThan(0);

    // The same feed again changes nothing.
    vi.mocked(applyCaddyConfig).mockClear();
    expect((await importDocument(document)).data).toMatchObject({ outcome: 'unchanged', sequence: 100 });
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('refuses rollbacks, tampering and disallowed rules, changing nothing', async () => {
    await installLicense();
    await importDocument(feed(100));
    vi.mocked(logAuditEvent).mockClear();
    vi.mocked(applyCaddyConfig).mockClear();
    const before = await rows();

    const older = await importDocument(feed(99));
    expect(older.status).toBe(400);
    expect(older.data.error).toMatch(/older than the installed one/);

    const equivocating = await importDocument(feed(100, [testPack()]));
    expect(equivocating.data.error).toMatch(/installed sequence 100 but different content/);

    const document = JSON.parse(feed(101));
    document.payload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(document.payload, 'base64url').toString()), sequence: 102 })).toString('base64url');
    expect((await importDocument(JSON.stringify(document))).data.error).toMatch(/signature does not match/);

    const stranger = createFeedSigner('stranger');
    expect((await importDocument(feed(101, examplePacks(), stranger))).data.error).toMatch(/unknown key/);

    for (const rule of [
      'SecRule ARGS "@rx ." "id:1800000999,phase:1,ctl:ruleEngine=Off"',
      'SecRuleRemoveById 1-999999',
      'SecRule ARGS "@rx ." "id:949110,phase:2"',
    ]) {
      const result = await importDocument(feed(101, [...examplePacks(), testPack({ id: 'ivp-evil-0001', rules: [rule] })]));
      expect(result.status, rule).toBe(400);
      expect(result.data.error).toMatch(/^pack ivp-evil-0001, rule 1: /);
    }

    expect(await rows()).toEqual(before);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
    expect((await readRuleFeedState()).installed?.sequence).toBe(100);
    expect((await readRuleFeedState()).lastCheck).toMatchObject({ outcome: 'failed', source: 'import' });
    expect(auditActions().every((action) => action === 'virtual_patch_feed_refused')).toBe(true);
    expect(auditActions().length).toBeGreaterThanOrEqual(5);
  });

  it('stops reading a body past 4 MiB', async () => {
    await installLicense();
    const { status, data } = await importDocument(`{"v":1,"payload":"${'a'.repeat(4 * 1024 * 1024)}","signature":"a"}`);
    expect(status).toBe(400);
    expect(data.error).toBe('The feed is larger than 4 MiB');
    expect((await importDocument('')).data.error).toBe('The feed file is empty');
  });

  it('starts critical packs the publisher recommends blocking in block mode when automatic blocking is on', async () => {
    await installLicense();
    await subscribe({ autoBlockCritical: true });
    const off = { ...examplePack('ivp-2021-41773'), id: 'ivp-test-off', defaultMode: 'off', rules: ['SecRule REQUEST_URI "@contains /x" "id:1800000901,phase:1"'] };
    const { data } = await importDocument(feed(100, [...examplePacks(), off]));
    expect(data.autoBlocked.sort()).toEqual(['ivp-2021-44228', 'ivp-2022-22965']);
    expect(await modes()).toEqual({ 'ivp-2021-41773': 'detect', 'ivp-2021-44228': 'block', 'ivp-2022-22965': 'block', 'ivp-test-off': 'off' });
  });

  it('keeps the mode of updated and withdrawn packs', async () => {
    await installLicense();
    await importDocument(feed(100));
    await setMode('ivp-2021-44228', 'block');
    const [log4shell] = examplePacks().filter((pack) => pack.id === 'ivp-2021-44228');
    const updated: RulePack = { ...log4shell, updatedAt: '2026-10-02T00:00:00Z', title: 'Apache Log4j lookup injection (Log4Shell), updated' };
    const { data } = await importDocument(feed(101, [updated]));
    expect(data).toMatchObject({ updated: ['ivp-2021-44228'], added: [] });
    expect(data.withdrawn.sort()).toEqual(['ivp-2021-41773', 'ivp-2022-22965']);
    expect(await modes()).toEqual({ 'ivp-2021-41773': 'detect', 'ivp-2021-44228': 'block', 'ivp-2022-22965': 'detect' });
    const withdrawn = (await rows()).find((row) => row.id === 'ivp-2022-22965')!;
    expect(withdrawn.withdrawnAt).not.toBeNull();
    // Withdrawn patches still apply until turned off.
    expect((await loadVirtualPatchDirectives())!.rules.some((line) => line.includes('id:1800000301'))).toBe(true);
    // And come back when the feed has them again.
    expect((await importDocument(feed(102))).data.withdrawn).toEqual([]);
    expect((await rows()).every((row) => row.withdrawnAt === null)).toBe(true);
  });

  it('puts the previous patches back when Caddy refuses the configuration', async () => {
    await installLicense();
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Caddy rejected the configuration', 'CADDY_REJECTED'));
    const { status, data } = await importDocument(feed());
    expect(status).toBe(502);
    expect(data.error).toMatch(/Caddy did not accept the patches of feed sequence 100/);
    expect(await rows()).toEqual([]);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(2);
    const state = await readRuleFeedState();
    expect(state.installed).toBeNull();
    expect(state.lastCheck).toMatchObject({ outcome: 'failed' });
  });
});

describe('patch modes', () => {
  beforeEach(async () => {
    await installLicense();
    await importDocument(feed());
    vi.mocked(applyCaddyConfig).mockClear();
    vi.mocked(logAuditEvent).mockClear();
  });

  it('turns a patch to block and applies it', async () => {
    const { status, data } = await setMode('ivp-2021-44228', 'block');
    expect(status).toBe(200);
    expect(data).toMatchObject({ id: 'ivp-2021-44228', mode: 'block' });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAuditEvent).mock.calls[0][0]).toMatchObject({
      action: 'virtual_patch_mode_changed',
      entityType: 'virtual_patch',
      summary: 'Set virtual patch CVE-2021-44228, CVE-2021-45046 (Apache Log4j JNDI lookup injection (Log4Shell)) from Detect to Block',
    });
    const directives = await loadVirtualPatchDirectives();
    expect(directives!.rules.find((line) => line.includes('id:1800000101'))).toContain('deny,status:403');
    expect(directives!.rules.find((line) => line.includes('id:1800000201'))).toContain(',pass,');
  });

  it('turns patches on only with the license, and off without it', async () => {
    await removeLicense();
    const refused = await setMode('ivp-2021-44228', 'block');
    expect(refused.status).toBe(403);
    expect(refused.data.error).toBe(LICENSE_MESSAGE);
    expect((await setMode('ivp-2021-44228', 'off')).data).toMatchObject({ mode: 'off' });
    expect((await setMode('ivp-2021-44228', 'detect')).status).toBe(403);
    expect((await modes())['ivp-2021-44228']).toBe('off');
    expect((await loadVirtualPatchDirectives())!.rules.some((line) => line.includes('id:1800000101'))).toBe(false);
  });

  it('validates the input', async () => {
    expect((await setMode('ivp-2021-44228', 'on')).status).toBe(400);
    expect((await setMode('ivp-unknown-0001', 'off')).status).toBe(404);
    expect((await call(putPatch as unknown as Handler, 'PUT', '/x', { mode: 'off', note: 1 }, undefined, { id: 'ivp-2021-44228' })).status).toBe(400);
  });

  it('keeps the previous mode when Caddy refuses the configuration', async () => {
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Caddy rejected the configuration', 'CADDY_REJECTED'));
    const { status } = await setMode('ivp-2021-44228', 'block');
    expect(status).toBe(502);
    expect((await modes())['ivp-2021-44228']).toBe('detect');
    expect(auditActions()).toEqual([]);
  });
});

describe('fetching', () => {
  function stubFetch(response: () => Response | Promise<Response>) {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('needs the license on demand, then downloads without following redirects', async () => {
    const fetchMock = stubFetch(() => new Response(feed(), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await call(fetchFeed as Handler, 'POST', '/api/v1/waf/rule-feed/fetch')).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    await installLicense();
    await subscribe({ subscribed: true, feedUrl: 'https://mirror.example.com/v1/feed.json' });
    const { status, data } = await call(fetchFeed as Handler, 'POST', '/api/v1/waf/rule-feed/fetch');
    expect(status).toBe(200);
    expect(data).toMatchObject({ outcome: 'updated', sequence: 100 });
    expect(fetchMock).toHaveBeenCalledWith('https://mirror.example.com/v1/feed.json', expect.objectContaining({ redirect: 'error', method: 'GET' }));
    expect((await readRuleFeedState()).lastFetchOk).toBe(true);
  });

  it('reports HTTP errors, unreachable URLs, oversized and refused feeds without changing anything', async () => {
    await installLicense();
    const cases: Array<[() => Response, RegExp]> = [
      [() => new Response('nope', { status: 500 }), /answered with HTTP 500/],
      [() => { throw new TypeError('fetch failed: redirect'); }, /could not be reached/],
      [() => new Response('a'.repeat(4 * 1024 * 1024 + 1)), /larger than 4 MiB/],
      [() => new Response(feed(100, [testPack({ rules: ['Include /etc/passwd'] })])), /fetched feed was refused: pack ivp-test-0001, rule 1/],
    ];
    for (const [response, message] of cases) {
      stubFetch(response);
      const { status, data } = await call(fetchFeed as Handler, 'POST', '/api/v1/waf/rule-feed/fetch');
      expect(status).toBe(502);
      expect(data.error).toMatch(message);
      expect((await readRuleFeedState()).lastFetchOk).toBe(false);
    }
    expect(await rows()).toEqual([]);
  });

  it('runs daily for a subscription whatever the license, and not on replicas', async () => {
    const document = feed();
    const fetchMock = stubFetch(() => new Response(document));
    expect(await runScheduledRuleFeedFetch()).toBeNull();
    await installLicense();
    await subscribe({ subscribed: true });
    await removeLicense();
    const result = await runScheduledRuleFeedFetch();
    expect(result).toMatchObject({ outcome: 'updated', sequence: 100 });
    expect(await rows()).toHaveLength(3);
    // Not due again for a day.
    expect(await runScheduledRuleFeedFetch()).toBeNull();
    expect(await runScheduledRuleFeedFetch(new Date(Date.now() + DAY + 1000))).toMatchObject({ outcome: 'unchanged' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The gate decides where it runs (high availability: the leader).
    setRuleFeedSchedulerGate(async () => false);
    await ruleFeedTick(new Date(Date.now() + 3 * DAY));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setRuleFeedSchedulerGate(null);
    process.env.INSTANCE_MODE = 'slave';
    expect(await runScheduledRuleFeedFetch(new Date(Date.now() + 3 * DAY))).toBeNull();
  });

  it('retries six hours after a failure', () => {
    const at = '2026-10-03T00:00:00.000Z';
    expect(isFetchDue({ lastFetchAt: null, lastFetchOk: null }, new Date(at))).toBe(true);
    expect(isFetchDue({ lastFetchAt: at, lastFetchOk: true }, new Date('2026-10-03T23:00:00Z'))).toBe(false);
    expect(isFetchDue({ lastFetchAt: at, lastFetchOk: true }, new Date('2026-10-04T00:00:00Z'))).toBe(true);
    expect(isFetchDue({ lastFetchAt: at, lastFetchOk: false }, new Date('2026-10-03T05:00:00Z'))).toBe(false);
    expect(isFetchDue({ lastFetchAt: at, lastFetchOk: false }, new Date('2026-10-03T06:00:00Z'))).toBe(true);
  });
});

describe('instance sync', () => {
  it('carries the patches that are on to replicas, which render them again and refuse changes', async () => {
    await installLicense();
    await importDocument(feed());
    await setMode('ivp-2021-44228', 'block');
    await setMode('ivp-2021-41773', 'off');
    const payload = await buildSyncPayload();
    const synced = payload.settings.virtual_patches as { v: number; patches: Array<{ id: string; mode: string; rules: string[] }> };
    expect(synced.v).toBe(1);
    expect(synced.patches.map((patch) => [patch.id, patch.mode])).toEqual([['ivp-2021-44228', 'block'], ['ivp-2022-22965', 'detect']]);
    expect(canonicalSyncContent({ settings: payload.settings, data: payload.data })).toContain('"virtual_patches"');
    const masterRules = (await loadVirtualPatchDirectives())!.rules;

    ctx.db = createTestDb();
    process.env.INSTANCE_MODE = 'slave';
    await applySyncPayload(payload);
    expect((await loadVirtualPatchDirectives())!.rules).toEqual(masterRules);
    expect(await findVirtualPatchRules([1800000101, 942100])).toEqual({
      1800000101: { patchId: 'ivp-2021-44228', title: 'Apache Log4j JNDI lookup injection (Log4Shell)', cves: ['CVE-2021-44228', 'CVE-2021-45046'] },
    });
    const view = (await call(getFeed as Handler, 'GET', '/api/v1/waf/rule-feed')).data;
    expect(view).toMatchObject({ editable: false, source: 'master', counts: { total: 2, block: 1, detect: 1 } });
    await installLicense();
    expect((await setMode('ivp-2021-44228', 'off')).status).toBe(409);
    expect((await subscribe({ subscribed: true })).status).toBe(409);
    expect((await importDocument(feed(200))).status).toBe(409);
    // A replica never sends patches of its own.
    expect((await buildSyncPayload()).settings.virtual_patches).toBeNull();
  });

  it('leaves out synced patches that do not validate', async () => {
    process.env.INSTANCE_MODE = 'slave';
    await setRow('synced:virtual_patches', {
      v: 1,
      patches: [
        { id: 'ivp-evil-0001', title: 'Evil', severity: 'critical', cves: ['CVE-2026-0002'], mode: 'block', rules: ['SecRuleEngine Off'] },
        { id: 'ivp-evil-0002', title: 'Evil', severity: 'critical', cves: ['CVE-2026-0003'], mode: 'block', rules: ['SecRule ARGS "@rx ." "id:1800000500,phase:1,ctl:ruleRemoveById=949110"'] },
        { id: 'Bad Id', title: 'Evil', severity: 'critical', cves: ['CVE-2026-0004'], mode: 'block', rules: [] },
        { id: 'ivp-test-0001', title: 'Fine', severity: 'high', cves: ['CVE-2026-0001'], mode: 'detect', rules: [testPack().rules[0]] },
      ],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const directives = await loadVirtualPatchDirectives();
    expect(directives!.rules).toHaveLength(1);
    expect(directives!.rules[0]).toContain('id:1800000001');
  });

  it('sends nothing without patches that are on', async () => {
    expect((await buildSyncPayload()).settings.virtual_patches).toBeNull();
  });
});

describe('coming soon', () => {
  const UNAVAILABLE_MESSAGE = new FeatureUnavailableError('virtual_patching').message;

  beforeEach(() => setFeatureAvailableForTests('virtual_patching', null));

  it('ships switched off, so it reads as coming soon and not configurable even with an Enterprise license', async () => {
    expect(FEATURE_INFO.virtual_patching.available).toBe(false);
    expect(UNAVAILABLE_MESSAGE).toBe('Virtual patching is coming soon: it cannot be set up in this release');
    await installLicense();
    const { status, data } = await call(getFeed as Handler, 'GET', '/api/v1/waf/rule-feed');
    expect(status).toBe(200);
    expect(data).toMatchObject({ available: false, configurable: false, editable: true });
  });

  it('refuses subscribing, fetching, importing and turning a patch on with any license, and fetches nothing', async () => {
    const fetchMock = vi.fn(async () => new Response(feed()));
    vi.stubGlobal('fetch', fetchMock);
    await installLicense();
    for (const body of [{ subscribed: true }, { feedUrl: 'https://mirror.example.com/feed.json' }, { autoBlockCritical: true }]) {
      const { status, data } = await subscribe(body);
      expect(status, JSON.stringify(body)).toBe(403);
      expect(data.error).toBe(UNAVAILABLE_MESSAGE);
    }
    const fetched = await call(fetchFeed as Handler, 'POST', '/api/v1/waf/rule-feed/fetch');
    expect(fetched).toMatchObject({ status: 403, data: { error: UNAVAILABLE_MESSAGE } });
    const imported = await importDocument(feed());
    expect(imported).toMatchObject({ status: 403, data: { error: UNAVAILABLE_MESSAGE } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(auditActions()).toEqual([]);
  });

  it('still turns a subscription and patches off', async () => {
    // Set up while available (a later release), then switched off again.
    setFeatureAvailableForTests('virtual_patching', true);
    await installLicense();
    await subscribe({ subscribed: true, autoBlockCritical: true });
    await importDocument(feed());
    setFeatureAvailableForTests('virtual_patching', null);

    expect((await setMode('ivp-2021-44228', 'block'))).toMatchObject({ status: 403, data: { error: UNAVAILABLE_MESSAGE } });
    expect((await setMode('ivp-2021-44228', 'off')).data).toMatchObject({ mode: 'off' });
    const { status, data } = await subscribe({ subscribed: false, autoBlockCritical: false });
    expect(status).toBe(200);
    expect(data.settings).toMatchObject({ subscribed: false, autoBlockCritical: false });
  });

  it('never fetches on a schedule, even for a subscription that is due', async () => {
    setFeatureAvailableForTests('virtual_patching', true);
    await installLicense();
    await subscribe({ subscribed: true });
    setFeatureAvailableForTests('virtual_patching', null);
    const fetchMock = vi.fn(async () => new Response(feed()));
    vi.stubGlobal('fetch', fetchMock);

    expect(await runScheduledRuleFeedFetch(new Date(Date.now() + 3 * DAY))).toBeNull();
    await ruleFeedTick(new Date(Date.now() + 3 * DAY));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await readRuleFeedState()).lastCheck).toBeNull();

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect(startRuleFeedScheduler()).toBe(false);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      stopRuleFeedScheduler();
    }
  });

  it('says so in the API documentation', async () => {
    const spec = await (await getOpenApi(new NextRequest('http://localhost/api/v1/openapi.json'))).json();
    const tag = spec.tags.find((entry: { name: string }) => entry.name === 'Virtual patching');
    expect(tag.description).toMatch(/^Coming soon: virtual patching is not available in this release\./);
    expect(spec.paths['/api/v1/waf/rule-feed'].put.summary).toBe('Subscribe to the rule feed or change the subscription (coming soon)');
    expect(spec.components.schemas.RuleFeedStatus.properties.available).toMatchObject({ type: 'boolean' });
  });
});

describe('feature, permission, usage and API documentation', () => {
  it('lists virtual_patching in the Enterprise edition, coming soon', () => {
    expect(FEATURE_INFO.virtual_patching).toMatchObject({ label: 'Virtual patching', edition: 'enterprise', available: false });
    expect(EDITION_FEATURES.enterprise).toContain('virtual_patching');
    expect(EDITION_FEATURES.business).not.toContain('virtual_patching');
    expect(EDITION_FEATURES.msp).not.toContain('virtual_patching');
  });

  it('has a paid, instance-wide permission that is not administrator-level', () => {
    expect(PERMISSION_AREAS.virtual_patches).toMatchObject({ actions: ['read', 'write'], paid: true, instanceWide: true });
    expect(ADMIN_LEVEL_PERMISSIONS).not.toContain('virtual_patches:write');
    expect(isAdminLevel(['virtual_patches:write'])).toBe(false);
  });

  it('reports the feature in use once subscribed or a patch is on', async () => {
    expect((await readPaidFeaturesInUse()).virtual_patching).toBe(false);
    await installLicense();
    await importDocument(feed());
    expect((await readPaidFeaturesInUse()).virtual_patching).toBe(true);
  });

  it('documents every endpoint', async () => {
    const response = await getOpenApi(new NextRequest('http://localhost/api/v1/openapi.json'));
    const spec = await response.json();
    const expected: Record<string, string[]> = {
      '/api/v1/waf/rule-feed': ['get', 'put'],
      '/api/v1/waf/rule-feed/fetch': ['post'],
      '/api/v1/waf/rule-feed/import': ['post'],
      '/api/v1/waf/virtual-patches': ['get'],
      '/api/v1/waf/virtual-patches/{id}': ['get', 'put'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(spec.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) expect(spec.paths[path][method].tags).toEqual(['Virtual patching']);
    }
    const refs = JSON.stringify(spec.paths).match(/"\$ref":"#\/components\/schemas\/[^"]+"/g) ?? [];
    for (const ref of new Set(refs)) {
      const name = ref.split('/').pop()!.replace(/"$/, '');
      expect(spec.components.schemas[name], name).toBeDefined();
    }
  });
});
