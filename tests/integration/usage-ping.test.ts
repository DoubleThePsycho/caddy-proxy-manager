/**
 * The usage ping against a real (in-memory) database: asked once (nothing
 * sent before a yes, USAGE_PING_ENABLED answering for unattended installs),
 * turning it on and off (install id, audit, erasure requests), the payload built from a real
 * configuration (buckets, features, edition, nothing identifying), the
 * scheduler with a mocked fetch (due or not, failures isolated and logged at
 * most daily, replicas and USAGE_PING_DISABLED never sending, an invalid
 * USAGE_PING_URL never falling back), the REST endpoints, and that instance
 * sync and the configuration export never carry the setting.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import {
  CA_KEY,
  CERT_KEY,
  DNS_TOKEN,
  installLicense,
  licenseSigner,
  OUTSIDE,
  seedConfiguration,
  setSettingRow,
  type Fixture,
} from '../helpers/config-fixture';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn(),
  };
});
vi.mock('@/src/lib/auth', () => ({
  requirePermission: vi.fn(async () => ({ user: { id: '1' } })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/src/lib/l4-ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/l4-ports')>()),
  applyL4Ports: vi.fn(async () => ({ state: 'idle' })),
  getL4PortsDiff: vi.fn(async () => ({ required: [], applied: [], changed: false, needsApply: false })),
}));

import { requireApiAdmin } from '../../src/lib/api-auth';
import { requirePermission } from '../../src/lib/auth';
import { logAuditEvent } from '../../src/lib/audit';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import {
  getUsagePingView,
  PREVIEW_INSTALL_ID,
  readUsagePingSettings,
  readUsagePingState,
  resetUsagePingInstallId,
  retryPendingErasures,
  setUsagePingEnabled,
  shouldAskUsagePingQuestion,
  applyUsagePingEnvironmentAnswer,
  USAGE_PING_SETTING_KEY,
  USAGE_PING_STATE_KEY,
} from '../../src/lib/usage-ping/store';
import { runUsagePingCheck } from '../../src/lib/usage-ping/scheduler';
import { isUuidV4 } from '../../src/lib/usage-ping/payload';
import { applySyncPayload, buildSyncPayload } from '../../src/lib/instance-sync';
import { CONFIG_SETTING_KEYS, readCurrentConfigContent } from '../../src/lib/config-content';
import * as route from '../../app/api/v1/usage-ping/route';
import * as resetRoute from '../../app/api/v1/usage-ping/reset-install-id/route';
import {
  previewUsagePingAction,
  resetUsagePingInstallIdAction,
  setUsagePingEnabledAction,
} from '../../app/(dashboard)/settings/usage-ping-actions';
import UsagePingSection from '../../app/(dashboard)/settings/UsagePingSection';
import UsagePingQuestion from '../../app/(dashboard)/UsagePingQuestion';
import { parseCertificateStorageInput } from '../../ee/high-availability/settings';
import { defaultRateLimitRule } from '../../src/lib/rate-limit-rules';
import { first as dbFirst, likeText } from '@/src/lib/db/ops';

const LICENSE = { id: 'LIC-SENTINEL-4242', customer: 'Customer Sentinel GmbH', email: 'billing@example.com' };

let fx: Fixture;
let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { ...process.env };

async function settingRow(key: string) {
  return await dbFirst(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1));
}

/** Each check gets its own clock: well after the previous one, so the in-memory 12-hour guard never interferes. */
let clock = Date.parse('2030-01-01T00:00:00.000Z');
function later(ms = 0): Date {
  clock += 2 * 86_400_000 + ms;
  return new Date(clock);
}

async function optInAndMakeDue(now: Date): Promise<string> {
  await setUsagePingEnabled(true, fx.adminId, new Date(now.getTime() - 10 * 60_000));
  const settings = await readUsagePingSettings();
  return settings!.installId!;
}

function sentBody(call = 0): Record<string, any> {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(String(init.body));
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  fx = await seedConfiguration(ctx.db);
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: fx.adminId, role: 'admin', authMethod: 'bearer' } as never);
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  delete process.env.USAGE_PING_DISABLED;
  delete process.env.USAGE_PING_ENABLED;
  delete process.env.USAGE_PING_URL;
  delete process.env.INSTANCE_MODE;
  delete process.env.INSTANCE_SLAVES;
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('asked once', () => {
  it('sends nothing until the question is answered', async () => {
    expect(await settingRow(USAGE_PING_SETTING_KEY)).toBeUndefined();
    const view = await getUsagePingView();
    expect(view).toMatchObject({
      enabled: false, answered: false, answeredAt: null, answeredBy: null, status: 'unanswered', installId: null, nextAttemptAt: null,
    });
    expect(view.payload?.install_id).toBe(PREVIEW_INSTALL_ID);
    expect(await shouldAskUsagePingQuestion()).toBe(true);
    expect(await runUsagePingCheck(later(), fetchMock as never)).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a no stores the answer, never sends and stops asking', async () => {
    const now = new Date('2026-10-03T10:00:00.000Z');
    const view = await setUsagePingEnabled(false, fx.adminId, now, fetchMock as never);
    expect(view).toMatchObject({
      enabled: false, answered: true, answeredAt: now.toISOString(), answeredBy: 'administrator', installId: null, status: 'off',
    });
    expect(await shouldAskUsagePingQuestion()).toBe(false);
    expect(logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'usage_ping_disabled', userId: fx.adminId, summary: 'Declined the anonymous usage ping',
    }));
    expect(await runUsagePingCheck(later(), fetchMock as never)).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a yes creates the install id, sends the first ping within minutes and stops asking', async () => {
    const now = new Date('2026-10-03T10:00:00.000Z');
    const view = await setUsagePingEnabled(true, fx.adminId, now);
    expect(view).toMatchObject({ enabled: true, answered: true, answeredBy: 'administrator', status: 'on' });
    expect(isUuidV4(view.installId)).toBe(true);
    const due = Date.parse(view.nextAttemptAt!) - now.getTime();
    expect(due).toBeGreaterThanOrEqual(60_000);
    expect(due).toBeLessThanOrEqual(300_000);
    expect(await shouldAskUsagePingQuestion()).toBe(false);
  });

  it('treats a stored row without an answer as unanswered, so it never sends', async () => {
    const installId = '0b6f3c1e-2a4d-4f8e-9c3b-5d7e1f2a3b4c';
    await setSettingRow(ctx.db, USAGE_PING_SETTING_KEY, {
      enabled: true, installId, minuteOfDay: 10, answeredAt: null, noticeShownAt: '2026-09-01T00:00:00.000Z',
    });
    await setSettingRow(ctx.db, USAGE_PING_STATE_KEY, { nextAttemptAt: '2026-09-02T00:00:00.000Z' });
    expect(await readUsagePingSettings()).toBeNull();
    expect((await getUsagePingView()).status).toBe('unanswered');
    expect(await shouldAskUsagePingQuestion()).toBe(true);
    expect(await runUsagePingCheck(later(), fetchMock as never)).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
    // A yes then starts over with a new id.
    expect((await setUsagePingEnabled(true, fx.adminId)).installId).not.toBe(installId);
  });

  it('USAGE_PING_ENABLED answers yes at start-up, recorded as the environment', async () => {
    process.env.USAGE_PING_ENABLED = 'true';
    expect(await applyUsagePingEnvironmentAnswer(new Date('2026-10-03T10:00:00.000Z'))).toBe(true);
    const view = await getUsagePingView();
    expect(view).toMatchObject({ enabled: true, answered: true, answeredBy: 'environment', status: 'on' });
    expect(isUuidV4(view.installId)).toBe(true);
    expect(await shouldAskUsagePingQuestion()).toBe(false);
    expect(logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'usage_ping_enabled', userId: null, summary: 'Turned on the anonymous usage ping (USAGE_PING_ENABLED)',
    }));
    // Already answered: the next start changes nothing.
    vi.mocked(logAuditEvent).mockClear();
    expect(await applyUsagePingEnvironmentAnswer()).toBe(false);
    expect((await getUsagePingView()).installId).toBe(view.installId);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('USAGE_PING_ENABLED never overrides an answer, and does nothing on a replica or with USAGE_PING_DISABLED', async () => {
    process.env.USAGE_PING_ENABLED = 'yes';
    await setUsagePingEnabled(false, fx.adminId, new Date(), fetchMock as never);
    expect(await applyUsagePingEnvironmentAnswer()).toBe(false);
    expect((await getUsagePingView()).enabled).toBe(false);

    await ctx.db.delete(schema.settings).where(likeText(schema.settings.key, 'usage_ping%'));
    process.env.USAGE_PING_DISABLED = 'true';
    expect(await applyUsagePingEnvironmentAnswer()).toBe(false);
    delete process.env.USAGE_PING_DISABLED;
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    expect(await applyUsagePingEnvironmentAnswer()).toBe(false);
    process.env.USAGE_PING_ENABLED = 'ture';
    await setSettingRow(ctx.db, 'instance_mode', 'standalone');
    expect(await applyUsagePingEnvironmentAnswer()).toBe(false);
    expect(await readUsagePingSettings()).toBeNull();
  });
});

describe('turning it on and off', () => {
  it('creates a random install id, schedules the first ping within minutes and audits it', async () => {
    const now = new Date('2026-10-03T10:00:00.000Z');
    await setUsagePingEnabled(false, fx.adminId, now);
    const view = await setUsagePingEnabled(true, fx.adminId, now);
    expect(view.enabled).toBe(true);
    expect(view.status).toBe('on');
    expect(isUuidV4(view.installId)).toBe(true);
    expect(view.payload?.install_id).toBe(view.installId);
    const due = Date.parse(view.nextAttemptAt!) - now.getTime();
    expect(due).toBeGreaterThanOrEqual(60_000);
    expect(due).toBeLessThanOrEqual(300_000);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'usage_ping_enabled', entityType: 'usage_ping' }));
    // The audit record does not carry the id (audit logs can be streamed elsewhere).
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(view.installId!);

    // Turning it on again keeps the id.
    vi.mocked(logAuditEvent).mockClear();
    expect((await setUsagePingEnabled(true, fx.adminId)).installId).toBe(view.installId);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('gives every new start a different id, and turning it off deletes the id and the history', async () => {
    const first = (await setUsagePingEnabled(true, fx.adminId)).installId;
    const off = await setUsagePingEnabled(false, fx.adminId, new Date(), fetchMock as never);
    expect(off.installId).toBeNull();
    expect(await settingRow(USAGE_PING_STATE_KEY)).toBeUndefined();
    expect((await settingRow(USAGE_PING_SETTING_KEY))!.value).not.toContain(first!);
    const second = (await setUsagePingEnabled(true, fx.adminId)).installId;
    expect(second).not.toBe(first);
  });

  it('asks the receiving service to delete its data once a ping may have reached it', async () => {
    const now = later();
    const installId = await optInAndMakeDue(now);
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('sent');
    fetchMock.mockClear();
    await setUsagePingEnabled(false, fx.adminId, new Date(now.getTime() + 60_000), fetchMock as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ping.ingres.si/v1/ping');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({ schema: 1, install_id: installId });
    expect(init.redirect).toBe('manual');
    expect(logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'usage_ping_disabled',
      summary: 'Turned off the anonymous usage ping and deleted its install id; asked the receiving service to delete its data',
    }));
  });

  it('keeps an undelivered erasure request and retries it, also after the ping was turned off', async () => {
    const now = later();
    const installId = await optInAndMakeDue(now);
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('sent');
    const failing = vi.fn(async () => new Response(null, { status: 503 }));
    const offAt = new Date(now.getTime() + 60_000);
    const view = await setUsagePingEnabled(false, fx.adminId, offAt, failing as never);
    expect(view.pendingErasures).toBe(1);
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls.at(-1))).toContain('failed');

    fetchMock.mockClear();
    expect(await retryPendingErasures(new Date(offAt.getTime() + 60_000), fetchMock as never)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await runUsagePingCheck(new Date(offAt.getTime() + 7 * 3_600_000), fetchMock as never)).toBe('off');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).install_id).toBe(installId);
    expect((await getUsagePingView()).pendingErasures).toBe(0);
  });

  it('never sends an erasure request with USAGE_PING_DISABLED', async () => {
    const now = later();
    await optInAndMakeDue(now);
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('sent');
    fetchMock.mockClear();
    process.env.USAGE_PING_DISABLED = 'true';
    await setUsagePingEnabled(false, fx.adminId, new Date(now.getTime() + 60_000), fetchMock as never);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await readUsagePingState()).pendingErasures).toEqual([]);
  });

  it('resets the install id on request, only while on, and asks for the old id to be deleted', async () => {
    await setUsagePingEnabled(false, fx.adminId, new Date(), fetchMock as never);
    await expect(resetUsagePingInstallId(fx.adminId)).rejects.toMatchObject({ status: 409 });
    const now = later();
    const before = await optInAndMakeDue(now);
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('sent');
    fetchMock.mockClear();
    const after = await resetUsagePingInstallId(fx.adminId, new Date(now.getTime() + 60_000), fetchMock as never);
    expect(isUuidV4(after.installId)).toBe(true);
    expect(after.installId).not.toBe(before);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).install_id).toBe(before);
    expect(logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'usage_ping_install_id_reset' }));
  });

  it('ignores a tampered setting instead of sending a malformed id', async () => {
    await setSettingRow(ctx.db, USAGE_PING_SETTING_KEY, {
      enabled: true, installId: 'admin@example.com', minuteOfDay: 10, answeredAt: '2026-10-03T10:00:00.000Z',
    });
    expect((await readUsagePingSettings())?.enabled).toBe(false);
    expect(await runUsagePingCheck(later(), fetchMock as never)).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the payload', () => {
  it('describes this configuration in ranges and yes/no answers only', async () => {
    await installLicense(ctx.db, 'business', LICENSE);
    await ctx.db.insert(schema.customRoles).values({
      name: 'Operators', permissions: '[]', scopeTags: '[]', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const now = later();
    const installId = await optInAndMakeDue(now);
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://ping.ingres.si/v1/ping');

    const body = sentBody();
    expect(body).toMatchObject({
      schema: 1,
      install_id: installId,
      edition: 'business',
      role: 'standalone',
      counts: { proxy_hosts: '1-5', l4_hosts: '1-5', users: '1-5', replicas: '0' },
      arch: expect.any(String),
    });
    expect(body.features).toMatchObject({
      waf: true, forward_auth: false, custom_roles: true, alerting: false, white_label: false, ldap: false,
    });

    const text = JSON.stringify(body);
    for (const forbidden of [
      'example.com', '@', 'backend', 'Postgres', 'alice', 'Staff', 'Developers', 'Admin', 'Member',
      LICENSE.id, LICENSE.customer, OUTSIDE.instanceToken, OUTSIDE.sessionToken, OUTSIDE.auditSummary,
      DNS_TOKEN, CERT_KEY, CA_KEY, 'Operators',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('reports SAML, high availability and rate limiting once they are set up, and never multi-tenancy', async () => {
    const before = (await getUsagePingView()).payload!.features;
    expect(before).toMatchObject({ sso_saml: false, high_availability: false, multi_tenancy: false, rate_limiting: false });

    const at = new Date().toISOString();
    await ctx.db.insert(schema.samlProviders).values({
      name: 'Corp IdP', idpEntityId: 'https://idp.example.com', idpSsoUrl: 'https://idp.example.com/sso',
      idpCertificates: '[]', createdAt: at, updatedAt: at,
    });
    await setSettingRow(ctx.db, 'certificate_storage', parseCertificateStorageInput({
      backend: 'redis', redis: { mode: 'standalone', addresses: ['valkey.example.com:6379'], keyPrefix: 'caddy/a' },
    }, null));
    await setSettingRow(ctx.db, 'rate_limit', {
      enabled: true, rules: [{ ...defaultRateLimitRule() }], allowlist: [],
    });

    const after = (await getUsagePingView()).payload!.features;
    expect(after).toMatchObject({ sso_saml: true, high_availability: true, multi_tenancy: false, rate_limiting: true });
    const text = JSON.stringify((await getUsagePingView()).payload);
    for (const forbidden of ['Corp IdP', 'idp.example.com', 'valkey', 'caddy/a']) expect(text, forbidden).not.toContain(forbidden);
  });

  it('is exactly what the preview shows', async () => {
    const now = later();
    await optInAndMakeDue(now);
    const preview = (await getUsagePingView()).payload;
    await runUsagePingCheck(now, fetchMock as never);
    expect(sentBody()).toEqual(preview);
  });

  it('reports a master with its replicas, and community without a valid license', async () => {
    await setSettingRow(ctx.db, 'instance_mode', 'master');
    const now = later();
    await optInAndMakeDue(now);
    await runUsagePingCheck(now, fetchMock as never);
    expect(sentBody()).toMatchObject({ role: 'master', edition: 'community', counts: { replicas: '1-5' } });
  });
});

describe('the scheduler', () => {
  it('sends only when due, then once a day at the install minute', async () => {
    const optIn = new Date('2031-05-01T08:00:00.000Z');
    clock = optIn.getTime();
    await setUsagePingEnabled(true, fx.adminId, optIn);
    expect(await runUsagePingCheck(new Date(optIn.getTime() + 30_000), fetchMock as never)).toBe('not_due');
    expect(fetchMock).not.toHaveBeenCalled();

    const first = new Date(optIn.getTime() + 6 * 60_000);
    expect(await runUsagePingCheck(first, fetchMock as never)).toBe('sent');
    const state = await readUsagePingState();
    const { minuteOfDay } = (await readUsagePingSettings())!;
    expect(state).toMatchObject({ lastResult: 'sent', lastError: null, lastAttemptAt: first.toISOString(), lastSuccessAt: first.toISOString() });
    const next = new Date(state.nextAttemptAt!);
    expect(next.getUTCHours() * 60 + next.getUTCMinutes()).toBe(minuteOfDay);
    expect(next.getTime() - first.getTime()).toBeGreaterThanOrEqual(12 * 3_600_000);

    expect(await runUsagePingCheck(new Date(next.getTime() - 1000), fetchMock as never)).toBe('not_due');
    expect(await runUsagePingCheck(next, fetchMock as never)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock = next.getTime();
  });

  it('isolates failures: no throw, no retry before the next day, one log line a day', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const now = new Date('2032-01-01T00:00:00.000Z');
    const installId = await optInAndMakeDue(now);
    // A known daily minute (13:00 UTC), so the dates below are exact.
    await setSettingRow(ctx.db, USAGE_PING_SETTING_KEY, { enabled: true, installId, minuteOfDay: 13 * 60, answeredAt: now.toISOString() });

    expect(await runUsagePingCheck(now, failing as never)).toBe('failed');
    const state = await readUsagePingState();
    expect(state).toMatchObject({
      lastResult: 'failed',
      lastError: 'the endpoint could not be reached',
      lastSuccessAt: null,
      nextAttemptAt: '2032-01-01T13:00:00.000Z',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[usage-ping\] .*could not be reached/);

    // Not retried a minute later.
    expect(await runUsagePingCheck(new Date(now.getTime() + 60_000), failing as never)).toBe('not_due');
    expect(failing).toHaveBeenCalledTimes(1);

    // The next failure, 13 hours later, is not logged again; the one after that, a day later, is.
    expect(await runUsagePingCheck(new Date('2032-01-01T13:00:00.000Z'), failing as never)).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await readUsagePingState()).nextAttemptAt).toBe('2032-01-02T13:00:00.000Z');
    const serverError = vi.fn(async () => new Response('internal details', { status: 500 }));
    expect(await runUsagePingCheck(new Date('2032-01-02T13:00:00.000Z'), serverError as never)).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(2);
    expect((await readUsagePingState()).lastError).toBe('the endpoint answered HTTP 500');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('never throws when the database fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = later();
    await optInAndMakeDue(now);
    ctx.db = { query: { settings: { findFirst: () => { throw new Error('database is locked'); } } } } as never;
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('never sends from a replica, whatever the setting says', async () => {
    const now = later();
    await optInAndMakeDue(now);
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('replica');
    process.env.INSTANCE_MODE = 'slave';
    await setSettingRow(ctx.db, 'instance_mode', 'standalone');
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('replica');
    expect(fetchMock).not.toHaveBeenCalled();

    const view = await getUsagePingView();
    expect(view).toMatchObject({ status: 'replica', payload: null });
    await ctx.db.delete(schema.settings).where(likeText(schema.settings.key, 'usage_ping%'));
    expect(await shouldAskUsagePingQuestion()).toBe(false);
  });

  it('never sends with USAGE_PING_DISABLED, hides the prompt and refuses opting in', async () => {
    const now = later();
    await optInAndMakeDue(now);
    process.env.USAGE_PING_DISABLED = 'true';
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('disabled_by_env');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getUsagePingView()).status).toBe('disabled_by_env');

    await ctx.db.delete(schema.settings).where(likeText(schema.settings.key, 'usage_ping%'));
    expect(await shouldAskUsagePingQuestion()).toBe(false);
    await expect(setUsagePingEnabled(true, fx.adminId)).rejects.toMatchObject({ status: 409 });
    expect(await settingRow(USAGE_PING_SETTING_KEY)).toBeUndefined();
  });

  it('uses USAGE_PING_URL, and sends nothing when it is not https', async () => {
    process.env.USAGE_PING_URL = 'https://ping.example.org/collect';
    let now = later();
    await optInAndMakeDue(now);
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('sent');
    expect(fetchMock.mock.calls[0][0]).toBe('https://ping.example.org/collect');

    process.env.USAGE_PING_URL = 'http://ping.example.org/collect';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    now = new Date(Date.parse((await readUsagePingState()).nextAttemptAt!));
    clock = now.getTime();
    expect(await runUsagePingCheck(now, fetchMock as never)).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await readUsagePingState()).lastError).toBe('USAGE_PING_URL must be an https:// URL');
    expect((await getUsagePingView()).status).toBe('invalid_endpoint');
  });
});

describe('per install, never synced or exported', () => {
  it('is not part of the sync payload, a slave never stores it, and the export leaves it out', async () => {
    await setSettingRow(ctx.db, 'instance_mode', 'master');
    const { installId } = await setUsagePingEnabled(true, fx.adminId);
    const payload = await buildSyncPayload();
    const text = JSON.stringify(payload);
    expect(text).not.toContain(installId!);
    expect(text).not.toContain('usage_ping');
    expect(CONFIG_SETTING_KEYS as readonly string[]).not.toContain(USAGE_PING_SETTING_KEY);
    expect(JSON.stringify(await readCurrentConfigContent())).not.toContain(installId!);

    // A slave applying a payload, even one that carries the setting, stores none of it.
    ctx.db = createTestDb();
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    const planted = { ...payload, settings: { ...payload.settings, usage_ping: { enabled: true, installId, minuteOfDay: 1 } } };
    await applySyncPayload(planted as never);
    const keys = (await ctx.db.select({ key: schema.settings.key }).from(schema.settings)).map((row) => row.key);
    expect(keys.filter((key) => key.includes('usage_ping'))).toEqual([]);
    expect(await readUsagePingSettings()).toBeNull();
  });
});

describe('REST API', () => {
  function req(method: string, path: string, body?: unknown): NextRequest {
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: {} };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    return new NextRequest(`http://localhost${path}`, init);
  }

  it('reads the setting with the payload preview', async () => {
    const response = await route.GET(req('GET', '/api/v1/usage-ping'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ enabled: false, answered: false, status: 'unanswered', endpoint: 'https://ping.ingres.si/v1/ping' });
    expect(Object.keys(body.payload)).toEqual(['schema', 'install_id', 'version', 'edition', 'role', 'counts', 'features', 'arch']);
  });

  it('opts in and out, and validates the body strictly', async () => {
    const on = await route.PUT(req('PUT', '/api/v1/usage-ping', { enabled: true }));
    expect(on.status).toBe(200);
    const view = await on.json();
    expect(view.enabled).toBe(true);
    expect(isUuidV4(view.installId)).toBe(true);
    expect(view.payload.install_id).toBe(view.installId);

    const reset = await resetRoute.POST(req('POST', '/api/v1/usage-ping/reset-install-id'));
    expect(reset.status).toBe(200);
    expect((await reset.json()).installId).not.toBe(view.installId);

    const off = await route.PUT(req('PUT', '/api/v1/usage-ping', { enabled: false }));
    expect((await off.json()).installId).toBeNull();
    expect((await resetRoute.POST(req('POST', '/api/v1/usage-ping/reset-install-id'))).status).toBe(409);

    for (const bad of [{}, { enabled: 'yes' }, { enabled: true, installId: '0b6f3c1e-2a4d-4f8e-9c3b-5d7e1f2a3b4c' }, [], 'not json']) {
      const response = await route.PUT(req('PUT', '/api/v1/usage-ping', bad));
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('refuses opting in on a replica (409) but always allows opting out', async () => {
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    const on = await route.PUT(req('PUT', '/api/v1/usage-ping', { enabled: true }));
    expect(on.status).toBe(409);
    expect((await on.json()).error).toMatch(/replica/);
    expect((await route.PUT(req('PUT', '/api/v1/usage-ping', { enabled: false }))).status).toBe(200);
  });

  it('answers 403 when the guard refuses', async () => {
    const { ApiAuthError } = await import('../../src/lib/api-auth');
    vi.mocked(requireApiAdmin).mockRejectedValue(new ApiAuthError('Administrator privileges required', 403));
    expect((await route.GET(req('GET', '/api/v1/usage-ping'))).status).toBe(403);
    expect((await route.PUT(req('PUT', '/api/v1/usage-ping', { enabled: true }))).status).toBe(403);
    expect((await resetRoute.POST(req('POST', '/api/v1/usage-ping/reset-install-id'))).status).toBe(403);
    expect(await settingRow(USAGE_PING_SETTING_KEY)).toBeUndefined();
  });
});

describe('dashboard actions', () => {
  it('check settings:write to change and settings:read to preview, and report conflicts as errors', async () => {
    expect(await resetUsagePingInstallIdAction()).toEqual({ ok: false, error: 'The usage ping is off, so there is no install id to reset' });
    expect(requirePermission).toHaveBeenLastCalledWith('settings:write');

    const on = await setUsagePingEnabledAction(true);
    expect(requirePermission).toHaveBeenLastCalledWith('settings:write');
    expect(on.ok && on.view.enabled).toBe(true);

    const preview = await previewUsagePingAction();
    expect(requirePermission).toHaveBeenLastCalledWith('settings:read');
    expect(preview.payload?.install_id).toBe(on.ok ? on.view.installId : null);

    // Only a literal true opts in.
    const off = await setUsagePingEnabledAction('true' as never);
    expect(off.ok && off.view.enabled).toBe(false);

    process.env.USAGE_PING_DISABLED = '1';
    const refused = await setUsagePingEnabledAction(true);
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/USAGE_PING_DISABLED/) });
  });

  it('change nothing when the guard refuses', async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Error('Administrator privileges required'));
    await expect(setUsagePingEnabledAction(true)).rejects.toThrow('Administrator privileges required');
    expect(await settingRow(USAGE_PING_SETTING_KEY)).toBeUndefined();
  });
});

describe('UI', () => {
  function decode(html: string): string {
    return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  }

  it('Settings shows the status, the controls and the exact payload', async () => {
    const off = decode(renderToStaticMarkup(createElement(UsagePingSection, { initial: await getUsagePingView(), canWrite: true })));
    expect(off).toContain('Send the anonymous usage ping once a day');
    expect(off).toContain('"install_id": "(a random id, created when the ping is turned on)"');
    expect(off).toContain('Off, not answered yet');
    expect(off).toContain('the privacy notice');

    const view = await setUsagePingEnabled(true, fx.adminId);
    const on = decode(renderToStaticMarkup(createElement(UsagePingSection, { initial: view, canWrite: true })));
    expect(on).toContain(JSON.stringify(view.payload, null, 2));
    expect(on).toContain('Reset');
    expect(decode(renderToStaticMarkup(createElement(UsagePingSection, { initial: view, canWrite: false })))).not.toContain('Reset');

    process.env.USAGE_PING_DISABLED = 'true';
    const disabled = decode(renderToStaticMarkup(createElement(UsagePingSection, { initial: await getUsagePingView(), canWrite: true })));
    expect(disabled).toContain('USAGE_PING_DISABLED');
  });

  it('the overview question offers both answers alike, neither preselected, and the preview', () => {
    const html = decode(renderToStaticMarkup(createElement(UsagePingQuestion)));
    for (const text of ['Share anonymous usage statistics?', 'Nothing is sent unless you say yes', 'See exactly what is sent']) {
      expect(html).toContain(text);
    }
    const buttonClass = (label: string) => html.match(new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`))?.[1];
    expect(buttonClass('Yes, share')).toBeTruthy();
    expect(buttonClass('Yes, share')).toBe(buttonClass("No, don't share"));
    expect(html).toContain('href="/settings#usage-ping"');
  });
});
