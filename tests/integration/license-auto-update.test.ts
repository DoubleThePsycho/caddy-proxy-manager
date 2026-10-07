/**
 * Automatic license updates against a real (in-memory) database: turning
 * them on (the token checked with the server first, stored encrypted, never
 * returned) and off (the token deleted), the check and its install rule
 * (same license id, newer issue time, signature verified here), the daily
 * scheduler on the leader node only, the REST endpoints and server actions
 * with their permissions, the License page card, and that neither instance
 * sync nor the configuration export carries the token.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { createTestSigner, licensePayload, signLicense } from '../helpers/license';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, permissions: new Set<string>() }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  const { builtInAccess } = await import('../../src/lib/permissions');
  return {
    ...actual,
    requireApiPermission: vi.fn(async (_request: unknown, permission: string) => {
      if (!ctx.permissions.has(permission)) throw new actual.ApiAuthError('Forbidden', 403);
      return { userId: 7, role: 'admin', authMethod: 'bearer', access: builtInAccess(7, 'admin') };
    }),
  };
});
vi.mock('@/src/lib/auth', () => ({ requirePermission: vi.fn() }));
vi.mock('@/src/lib/audit', () => ({ logAuditEvent: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/src/lib/l4-ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/l4-ports')>()),
  applyL4Ports: vi.fn(async () => ({ state: 'idle' })),
  getL4PortsDiff: vi.fn(async () => ({ required: [], applied: [], changed: false, needsApply: false })),
}));

import { requirePermission } from '@/src/lib/auth';
import { logAuditEvent } from '@/src/lib/audit';
import { adminAccess, builtInAccess } from '@/src/lib/permissions';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { getLicenseKey, LICENSE_SETTING_KEY } from '@/ee/licensing/store';
import {
  checkLicenseServer,
  checkLicenseServerNow,
  getLicenseAutoUpdateView,
  LICENSE_AUTO_UPDATE_SETTING_KEY,
  LICENSE_AUTO_UPDATE_STATE_KEY,
  readLicenseAutoUpdateSettings,
  readLicenseAutoUpdateState,
  setLicenseAutoUpdate,
} from '@/ee/licensing/auto-update';
import { resetLicenseAutoUpdateSchedulerForTests, runLicenseAutoUpdateCheck } from '@/ee/licensing/auto-update-scheduler';
import { buildSyncPayload } from '@/src/lib/instance-sync';
import { CONFIG_SETTING_KEYS, readCurrentConfigContent } from '@/src/lib/config-content';
import * as route from '@/app/api/v1/license/auto-update/route';
import * as checkRoute from '@/app/api/v1/license/auto-update/check/route';
import { checkLicenseServerNowAction, setLicenseAutoUpdateAction } from '@/ee/licensing/ui/actions';
import LicensePage from '@/app/(dashboard)/license/page';
import { first } from '@/src/lib/db/ops';

const signer = createTestSigner('2026-test');
const TOKEN = `lrt_${'Zq9_-k'.repeat(7)}Q`;
const OTHER_TOKEN = `lrt_${'Pp3-x_'.repeat(7)}R`;
const ADMIN = 1;
const NOW = new Date('2026-10-03T12:00:00.000Z');
const INSTALLED_IAT = '2026-01-01T00:00:00.000Z';

let fetchMock: ReturnType<typeof server>;
const savedEnv = { ...process.env };

function key(overrides: Record<string, unknown> = {}): string {
  return signLicense(signer, licensePayload(signer, {
    id: 'LIC-AUTO', edition: 'business', nodes: 3, iat: INSTALLED_IAT, exp: '2027-01-15T00:00:00.000Z', ...overrides,
  }));
}

async function setRow(rowKey: string, value: unknown) {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, rowKey));
  await ctx.db.insert(schema.settings).values({ key: rowKey, value: JSON.stringify(value), updatedAt: new Date().toISOString() });
}

async function rawRow(rowKey: string): Promise<string | null> {
  return (await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, rowKey)).limit(1)))?.value ?? null;
}

async function allSettingsText(): Promise<string> {
  return JSON.stringify(await ctx.db.select().from(schema.settings));
}

/** The license server: answers with `body` (a key or a status). */
function server(answer: { key?: string; status?: number }) {
  return vi.fn(async () =>
    answer.key !== undefined
      ? new Response(JSON.stringify({ licenseId: 'LIC-AUTO', key: answer.key, issuedAt: INSTALLED_IAT, expiresAt: '2027-01-15T00:00:00.000Z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(answer.status === 410 ? '{"error":"revoked"}' : null, { status: answer.status ?? 500 })
  );
}

async function enable(fetchImpl: unknown = server({ key: key() }), now = NOW) {
  return setLicenseAutoUpdate({ enabled: true, refreshToken: TOKEN }, ADMIN, now, fetchImpl as never);
}

function request(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/v1/license/auto-update', {
    method,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.permissions = new Set(['license:read', 'license:write']);
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ user: { id: String(ADMIN) }, access: adminAccess(ADMIN) } as never);
  setTrustedLicenseKeysForTests(signer.keys);
  resetLicenseAutoUpdateSchedulerForTests();
  delete process.env.LICENSE_AUTO_UPDATE_DISABLED;
  delete process.env.LICENSE_SERVER_URL;
  delete process.env.INSTANCE_MODE;
  delete process.env.INSTANCE_SLAVES;
  await setRow(LICENSE_SETTING_KEY, key());
  fetchMock = server({ key: key() });
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('turning it on and off', () => {
  it('is off by default and sends nothing', async () => {
    const view = await getLicenseAutoUpdateView(NOW);
    expect(view).toMatchObject({ enabled: false, hasRefreshToken: false, licenseId: null, status: 'off', endpoint: 'https://license.ingres.si', nextCheckAt: null });
    expect(await runLicenseAutoUpdateCheck(new Date(NOW.getTime() + 3 * 86_400_000), fetchMock as never)).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the server once, stores the token encrypted and never returns it', async () => {
    const view = await enable(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://license.ingres.si/v1/licenses/LIC-AUTO/current');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(view).toMatchObject({ enabled: true, hasRefreshToken: true, licenseId: 'LIC-AUTO', status: 'on', lastResult: 'current', lastError: null });
    const due = Date.parse(view.nextCheckAt!) - NOW.getTime();
    expect(due).toBeGreaterThanOrEqual(12 * 3_600_000);
    expect(due).toBeLessThanOrEqual(36 * 3_600_000);

    // Encrypted at rest; nowhere in clear: not in the settings, the view or the audit log.
    expect(await rawRow(LICENSE_AUTO_UPDATE_SETTING_KEY)).toContain('enc:v1:');
    expect(await allSettingsText()).not.toContain(TOKEN);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(await getLicenseAutoUpdateView(NOW))).not.toContain('enc:v1:');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: ADMIN, action: 'license_auto_update_enabled', entityType: 'license', summary: 'Turned on automatic updates for license LIC-AUTO',
    }));
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(TOKEN);
  });

  it('refuses a token the server does not accept and stores nothing', async () => {
    await expect(enable(server({ status: 401 }))).rejects.toMatchObject({ status: 400, message: 'The license server did not accept this refresh token' });
    expect(await rawRow(LICENSE_AUTO_UPDATE_SETTING_KEY)).toBeNull();
    expect(await rawRow(LICENSE_AUTO_UPDATE_STATE_KEY)).toBeNull();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('turns on when the server cannot be reached, and shows the failure', async () => {
    const view = await enable(vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(view).toMatchObject({ enabled: true, status: 'on', lastResult: 'failed', lastError: 'the license server could not be reached', lastSuccessAt: null });
  });

  it('installs a newer key it gets while turning on', async () => {
    const renewed = key({ iat: '2026-09-01T00:00:00.000Z', exp: '2027-10-08T00:00:00.000Z', nodes: 5 });
    const view = await enable(server({ key: renewed }));
    expect(view.lastResult).toBe('updated');
    expect(await getLicenseKey()).toBe(renewed);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: ADMIN, action: 'license_auto_updated', data: expect.objectContaining({ trigger: 'enable', nodes: 5 }),
    }));
  });

  it('needs a token, a valid license, the leader node and no LICENSE_AUTO_UPDATE_DISABLED', async () => {
    await expect(setLicenseAutoUpdate({ enabled: true }, ADMIN, NOW, fetchMock as never)).rejects.toMatchObject({ status: 400 });
    await expect(setLicenseAutoUpdate({ enabled: true, refreshToken: 'lrt_bad' }, ADMIN, NOW, fetchMock as never)).rejects.toMatchObject({ status: 400 });

    process.env.LICENSE_AUTO_UPDATE_DISABLED = 'true';
    await expect(enable(fetchMock)).rejects.toMatchObject({ status: 409 });
    delete process.env.LICENSE_AUTO_UPDATE_DISABLED;

    await setRow('instance_mode', 'slave');
    await expect(enable(fetchMock)).rejects.toMatchObject({ status: 409 });
    await setRow('instance_mode', 'standalone');

    process.env.LICENSE_SERVER_URL = 'http://license.example.com';
    await expect(enable(fetchMock)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('https') });
    delete process.env.LICENSE_SERVER_URL;

    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, LICENSE_SETTING_KEY));
    await expect(enable(fetchMock)).rejects.toMatchObject({ status: 409 });
    await setRow(LICENSE_SETTING_KEY, 'v1.not.valid');
    await expect(enable(fetchMock)).rejects.toMatchObject({ status: 409 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rawRow(LICENSE_AUTO_UPDATE_SETTING_KEY)).toBeNull();
  });

  it('turning it off deletes the token and the history, and is audited', async () => {
    await enable(fetchMock);
    vi.mocked(logAuditEvent).mockClear();
    const view = await setLicenseAutoUpdate({ enabled: false }, ADMIN, NOW);
    expect(view).toMatchObject({ enabled: false, hasRefreshToken: false, licenseId: null, status: 'off', lastCheckAt: null });
    expect(await rawRow(LICENSE_AUTO_UPDATE_SETTING_KEY)).not.toContain('enc:v1:');
    expect(await rawRow(LICENSE_AUTO_UPDATE_STATE_KEY)).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'license_auto_update_disabled', userId: ADMIN }));

    // Already off: nothing to do, nothing audited; on again needs the token again.
    vi.mocked(logAuditEvent).mockClear();
    await setLicenseAutoUpdate({ enabled: false }, ADMIN, NOW);
    expect(logAuditEvent).not.toHaveBeenCalled();
    await expect(setLicenseAutoUpdate({ enabled: true }, ADMIN, NOW, fetchMock as never)).rejects.toMatchObject({ status: 400 });
  });

  it('replaces the token, audited, and ignores the same token again', async () => {
    await enable(fetchMock);
    vi.mocked(logAuditEvent).mockClear();
    await setLicenseAutoUpdate({ enabled: true, refreshToken: TOKEN }, ADMIN, NOW, fetchMock as never);
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const replaced = await setLicenseAutoUpdate({ enabled: true, refreshToken: OTHER_TOKEN }, ADMIN, NOW, fetchMock as never);
    expect(replaced.status).toBe('on');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'license_auto_update_token_replaced' }));
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: `Bearer ${OTHER_TOKEN}` });
    expect(await allSettingsText()).not.toContain(OTHER_TOKEN);
  });
});

describe('the check', () => {
  async function check(answer: ReturnType<typeof vi.fn>, now = new Date('2026-10-05T12:00:00.000Z')) {
    return checkLicenseServer({ actorUserId: null, trigger: 'scheduled', now, fetchImpl: answer as never, reschedule: true });
  }

  beforeEach(async () => {
    await enable(fetchMock);
    vi.mocked(logAuditEvent).mockClear();
  });

  it('installs a newer key for the same license and audits it as automatic', async () => {
    const renewed = key({ iat: '2026-10-01T00:00:00.000Z', exp: '2027-10-08T00:00:00.000Z' });
    expect(await check(server({ key: renewed }))).toBe('updated');
    expect(await getLicenseKey()).toBe(renewed);
    const state = await readLicenseAutoUpdateState();
    expect(state).toMatchObject({ lastResult: 'updated', lastError: null, lastUpdatedAt: '2026-10-05T12:00:00.000Z' });
    expect(logAuditEvent).toHaveBeenCalledWith({
      userId: null,
      action: 'license_auto_updated',
      entityType: 'license',
      summary: 'Installed the renewed Business license LIC-AUTO (valid until 2027-10-08) from the license server',
      data: {
        licenseId: 'LIC-AUTO', edition: 'business', nodes: 3,
        previousIssuedAt: INSTALLED_IAT, previousExpiresAt: '2027-01-15T00:00:00.000Z',
        issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-10-08T00:00:00.000Z', trigger: 'scheduled',
      },
    });
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(renewed);
  });

  it('keeps the installed key when the answer is the same key or an older one', async () => {
    const installed = await getLicenseKey();
    expect(await check(server({ key: key() }))).toBe('current');
    expect(await check(server({ key: key({ iat: '2025-12-01T00:00:00.000Z' }) }))).toBe('current');
    expect(await getLicenseKey()).toBe(installed);
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect((await readLicenseAutoUpdateState()).lastSuccessAt).toBe('2026-10-05T12:00:00.000Z');
  });

  it.each([
    ['another license id', () => key({ id: 'LIC-OTHER', iat: '2026-10-01T00:00:00.000Z' }), /for license LIC-OTHER, not LIC-AUTO/],
    ['an untrusted signature', () => signLicense(createTestSigner('2026-test'), licensePayload(signer, { id: 'LIC-AUTO', iat: '2026-10-01T00:00:00.000Z' })), /signature does not match/],
    ['an unknown signing key', () => key({ kid: 'elsewhere', iat: '2026-10-01T00:00:00.000Z' }), /unknown key/],
    ['a key past its grace period', () => key({ iat: '2026-02-01T00:00:00.000Z', exp: '2026-03-01T00:00:00.000Z' }), /expired on 2026-03-01/],
    ['a key not valid yet', () => key({ iat: '2026-12-01T00:00:00.000Z', exp: '2027-12-01T00:00:00.000Z' }), /not valid yet/],
    ['garbage', () => 'v1.garbage.key', /not valid/],
  ])('refuses %s and keeps the installed key', async (_name, make, error) => {
    const installed = await getLicenseKey();
    expect(await check(server({ key: make() }))).toBe('failed');
    expect(await getLicenseKey()).toBe(installed);
    expect((await readLicenseAutoUpdateState()).lastError).toMatch(error);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('records a refused token, a revoked license and an unavailable server', async () => {
    expect(await check(server({ status: 401 }))).toBe('failed');
    expect((await readLicenseAutoUpdateState()).lastError).toBe('the license server did not accept the refresh token');
    expect(await check(server({ status: 410 }))).toBe('revoked');
    expect(await getLicenseAutoUpdateView(new Date('2026-10-05T12:00:00.000Z'))).toMatchObject({
      status: 'on', lastResult: 'revoked', lastError: 'the license server says this license was revoked',
    });
    expect(await check(server({ status: 503 }))).toBe('failed');
    expect((await readLicenseAutoUpdateState()).lastError).toBe('the license server answered HTTP 503');
    expect((await getLicenseAutoUpdateView()).enabled).toBe(true);
  });

  it('does not call out when the installed license is not the one the token belongs to', async () => {
    await setRow(LICENSE_SETTING_KEY, key({ id: 'LIC-NEW' }));
    const answer = server({ key: key() });
    expect(await check(answer)).toBe('license_mismatch');
    expect(answer).not.toHaveBeenCalled();
    expect((await getLicenseAutoUpdateView(NOW)).status).toBe('license_mismatch');
    await expect(checkLicenseServerNow(ADMIN, new Date('2026-10-05T12:00:00.000Z'), answer as never)).rejects.toMatchObject({ status: 409 });

    // The token of the new license fixes it (and is a replacement).
    await setLicenseAutoUpdate({ enabled: true, refreshToken: OTHER_TOKEN }, ADMIN, NOW, answer as never);
    expect(await getLicenseAutoUpdateView(NOW)).toMatchObject({ status: 'on', licenseId: 'LIC-NEW' });
  });

  it('never calls out from a replica, with LICENSE_AUTO_UPDATE_DISABLED, an invalid endpoint or no license', async () => {
    const answer = server({ key: key() });
    await setRow('instance_mode', 'slave');
    expect(await check(answer)).toBe('replica');
    expect((await getLicenseAutoUpdateView(NOW)).status).toBe('replica');
    await setRow('instance_mode', 'standalone');
    process.env.LICENSE_AUTO_UPDATE_DISABLED = '1';
    expect(await check(answer)).toBe('disabled_by_env');
    expect((await getLicenseAutoUpdateView(NOW)).status).toBe('disabled_by_env');
    delete process.env.LICENSE_AUTO_UPDATE_DISABLED;
    process.env.LICENSE_SERVER_URL = 'https://license.example.com/?redirect=1';
    expect(await check(answer)).toBe('invalid_endpoint');
    expect((await getLicenseAutoUpdateView(NOW)).status).toBe('invalid_endpoint');
    delete process.env.LICENSE_SERVER_URL;
    await setRow(LICENSE_SETTING_KEY, 'v1.not.valid');
    expect(await check(answer)).toBe('no_license');
    expect((await getLicenseAutoUpdateView(NOW)).status).toBe('no_license');
    expect(answer).not.toHaveBeenCalled();
  });

  it('uses LICENSE_SERVER_URL when it is a valid https URL', async () => {
    process.env.LICENSE_SERVER_URL = 'https://license.example.com/base/';
    const answer = server({ key: key() });
    await check(answer);
    expect((answer.mock.calls[0] as unknown[])[0]).toBe('https://license.example.com/base/v1/licenses/LIC-AUTO/current');
  });

  it('reports a stored token that no longer decrypts without calling out', async () => {
    const stored = JSON.parse((await rawRow(LICENSE_AUTO_UPDATE_SETTING_KEY))!);
    await setRow(LICENSE_AUTO_UPDATE_SETTING_KEY, { ...stored, refreshToken: 'enc:v1:AAAA:BBBB:CCCC' });
    const answer = server({ key: key() });
    expect(await check(answer)).toBe('failed');
    expect(answer).not.toHaveBeenCalled();
    expect((await readLicenseAutoUpdateState()).lastError).toMatch(/cannot be decrypted/);
  });
});

describe('the daily scheduler', () => {
  it('checks at the daily slot only, once, and logs a failure at most once a day without the token', async () => {
    const view = await enable(fetchMock);
    const due = Date.parse(view.nextCheckAt!);
    const answer = server({ status: 503 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await runLicenseAutoUpdateCheck(new Date(due - 60_000), answer as never)).toBe('not_due');
    expect(answer).not.toHaveBeenCalled();
    expect(await runLicenseAutoUpdateCheck(new Date(due + 1000), answer as never)).toBe('failed');
    expect(answer).toHaveBeenCalledTimes(1);
    // Not retried before the next daily slot.
    expect(await runLicenseAutoUpdateCheck(new Date(due + 60 * 60_000), answer as never)).toBe('not_due');
    expect(answer).toHaveBeenCalledTimes(1);
    const next = Date.parse((await readLicenseAutoUpdateState()).nextCheckAt!);
    expect(next - due).toBeGreaterThanOrEqual(12 * 3_600_000);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('LIC-AUTO');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);

    // The next day's failure is logged again, the same day's not.
    resetLicenseAutoUpdateSchedulerForTests();
    expect(await runLicenseAutoUpdateCheck(new Date(next + 1000), answer as never)).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('installs a renewed key at the daily slot', async () => {
    const view = await enable(fetchMock);
    const renewed = key({ iat: '2026-10-02T00:00:00.000Z', exp: '2027-10-08T00:00:00.000Z' });
    expect(await runLicenseAutoUpdateCheck(new Date(Date.parse(view.nextCheckAt!) + 1000), server({ key: renewed }) as never)).toBe('updated');
    expect(await getLicenseKey()).toBe(renewed);
  });

  it('stays quiet on a replica and with LICENSE_AUTO_UPDATE_DISABLED', async () => {
    const view = await enable(fetchMock);
    const later = new Date(Date.parse(view.nextCheckAt!) + 1000);
    const answer = server({ key: key() });
    process.env.INSTANCE_MODE = 'slave';
    expect(await runLicenseAutoUpdateCheck(later, answer as never)).toBe('replica');
    delete process.env.INSTANCE_MODE;
    process.env.LICENSE_AUTO_UPDATE_DISABLED = 'yes';
    expect(await runLicenseAutoUpdateCheck(later, answer as never)).toBe('disabled_by_env');
    expect(answer).not.toHaveBeenCalled();
  });
});

describe('check now', () => {
  it('asks the server outside the daily slot, at most once a minute, and keeps the daily slot', async () => {
    const view = await enable(fetchMock);
    const renewed = key({ iat: '2026-10-02T00:00:00.000Z' });
    const answer = server({ key: renewed });
    await expect(checkLicenseServerNow(ADMIN, new Date(NOW.getTime() + 30_000), answer as never)).rejects.toMatchObject({ status: 429 });
    const after = await checkLicenseServerNow(ADMIN, new Date(NOW.getTime() + 120_000), answer as never);
    expect(after).toMatchObject({ lastResult: 'updated', nextCheckAt: view.nextCheckAt });
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'license_auto_updated', userId: ADMIN, data: expect.objectContaining({ trigger: 'manual' }),
    }));
  });

  it('is refused while automatic updates are off', async () => {
    await expect(checkLicenseServerNow(ADMIN, NOW, fetchMock as never)).rejects.toMatchObject({ status: 409, message: 'Automatic license updates are off' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('REST API', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  it('GET needs license:read and never returns the token', async () => {
    await enable(fetchMock);
    const response = await route.GET(request('GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ enabled: true, hasRefreshToken: true, licenseId: 'LIC-AUTO' });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('enc:v1:');

    ctx.permissions = new Set();
    expect((await route.GET(request('GET'))).status).toBe(403);
  });

  it('PUT needs license:write and validates the body strictly', async () => {
    ctx.permissions = new Set(['license:read']);
    expect((await route.PUT(request('PUT', { enabled: true, refreshToken: TOKEN }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    ctx.permissions = new Set(['license:write']);
    for (const body of ['{', { enabled: 'yes' }, { enabled: true, refreshToken: TOKEN, url: 'https://example.com' }, { enabled: true, refreshToken: 'lrt_x' }]) {
      const response = await route.PUT(request('PUT', body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).not.toContain(TOKEN);
    }
    expect(await rawRow(LICENSE_AUTO_UPDATE_SETTING_KEY)).toBeNull();

    const on = await route.PUT(request('PUT', { enabled: true, refreshToken: TOKEN }));
    expect(on.status).toBe(200);
    const text = await on.text();
    expect(JSON.parse(text)).toMatchObject({ enabled: true, status: 'on' });
    expect(text).not.toContain(TOKEN);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'license_auto_update_enabled', userId: 7 }));

    const off = await route.PUT(request('PUT', { enabled: false }));
    expect(await off.json()).toMatchObject({ enabled: false, hasRefreshToken: false });
  });

  it('PUT answers 400 when the server refuses the token and 409 on a replica', async () => {
    vi.stubGlobal('fetch', server({ status: 401 }));
    const refused = await route.PUT(request('PUT', { enabled: true, refreshToken: TOKEN }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'The license server did not accept this refresh token' });

    await setRow('instance_mode', 'slave');
    expect((await route.PUT(request('PUT', { enabled: true, refreshToken: TOKEN }))).status).toBe(409);
  });

  it('POST check needs license:write and answers 409 while off', async () => {
    ctx.permissions = new Set(['license:read']);
    expect((await checkRoute.POST(request('POST'))).status).toBe(403);
    ctx.permissions = new Set(['license:write']);
    expect((await checkRoute.POST(request('POST'))).status).toBe(409);
  });
});

describe('server actions and the License page', () => {
  it('guard with license:write and return client-safe refusals', async () => {
    vi.stubGlobal('fetch', server({ status: 401 }));
    expect(await setLicenseAutoUpdateAction(true, TOKEN)).toEqual({ ok: false, error: 'The license server did not accept this refresh token' });
    expect(requirePermission).toHaveBeenCalledWith('license:write');
    expect(await setLicenseAutoUpdateAction(true, 'lrt_short')).toEqual({ ok: false, error: expect.stringContaining('refreshToken must be') });
    expect(await checkLicenseServerNowAction()).toEqual({ ok: false, error: 'Automatic license updates are off' });

    vi.stubGlobal('fetch', server({ key: key() }));
    const on = await setLicenseAutoUpdateAction(true, ` ${TOKEN} `);
    expect(on).toMatchObject({ ok: true, view: { enabled: true, status: 'on' } });
    expect(JSON.stringify(on)).not.toContain(TOKEN);
    expect(await setLicenseAutoUpdateAction(false)).toMatchObject({ ok: true, view: { enabled: false } });

    vi.mocked(requirePermission).mockRejectedValueOnce(new Error('Forbidden'));
    await expect(setLicenseAutoUpdateAction(true, TOKEN)).rejects.toThrow('Forbidden');
  });

  it('shows the card with its status, and the token never', async () => {
    await enable(fetchMock);
    const html = renderToStaticMarkup(await LicensePage());
    expect(html).toContain('Automatic updates');
    expect(html).toContain('Keep the license up to date automatically');
    expect(html).toContain('https://license.ingres.si');
    expect(html).toContain('Check now');
    expect(html).toContain('The installed key is the newest');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('enc:v1:');
  });

  it('is read-only for a role that only reads the license', async () => {
    await enable(fetchMock);
    const access = { ...builtInAccess(2, 'viewer'), customRole: { id: 1, name: 'License readers' }, permissions: new Set(['license:read']) };
    vi.mocked(requirePermission).mockResolvedValue({ user: { id: '2' }, access } as never);
    const html = renderToStaticMarkup(await LicensePage());
    expect(html).toContain('Your role can see this setting but not change it');
    expect(html).not.toContain('Check now');
  });
});

describe('per install, never synced or exported', () => {
  it('is not part of the sync payload or the configuration export', async () => {
    await setRow('instance_mode', 'master');
    await enable(fetchMock);
    const stored = (await rawRow(LICENSE_AUTO_UPDATE_SETTING_KEY))!;
    const encrypted = JSON.parse(stored).refreshToken as string;
    const payload = JSON.stringify(await buildSyncPayload());
    expect(payload).not.toContain('license_auto_update');
    expect(payload).not.toContain(encrypted);
    expect(CONFIG_SETTING_KEYS as readonly string[]).not.toContain(LICENSE_AUTO_UPDATE_SETTING_KEY);
    expect(CONFIG_SETTING_KEYS as readonly string[]).not.toContain(LICENSE_AUTO_UPDATE_STATE_KEY);
    expect(JSON.stringify(await readCurrentConfigContent())).not.toContain(encrypted);
    expect((await readLicenseAutoUpdateSettings())?.enabled).toBe(true);
  });
});
