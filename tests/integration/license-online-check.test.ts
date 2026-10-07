/**
 * The online license check against a real (in-memory) database: what one
 * check stores and audits (confirmed, revoked, reinstated, refused
 * answers), that offline keys and replicas never ask, the first days of a
 * new key (not restarted by reinstalling it), the REST endpoints with their
 * permissions, the scheduler's timing, the overview's attention items and
 * the License page.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { createTestSigner, licensePayload, signLicense, signStatement, statementPayload } from '../helpers/license';

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
import { adminAccess } from '@/src/lib/permissions';
import { setTrustedLicenseKeysForTests } from '@/ee/licensing/public-keys';
import { getLicenseState, LICENSE_SETTING_KEY } from '@/ee/licensing/store';
import { LICENSE_CHECK_SETTING_KEY, readLicenseCheck } from '@/ee/licensing/online-check-state';
import { checkLicenseNow, getLicenseView, keyFingerprint, runOnlineLicenseCheck } from '@/ee/licensing/online-check';
import { resetOnlineLicenseCheckSchedulerForTests, runOnlineLicenseCheckTick } from '@/ee/licensing/online-check-scheduler';
import { licenseAttentionProvider } from '@/ee/licensing/attention';
import { buildSyncPayload } from '@/src/lib/instance-sync';
import { CONFIG_SETTING_KEYS } from '@/src/lib/config-content';
import * as licenseRoute from '@/app/api/v1/license/route';
import * as checkRoute from '@/app/api/v1/license/check/route';
import { checkLicenseNowAction, installLicenseAction } from '@/ee/licensing/ui/actions';
import LicensePage from '@/app/(dashboard)/license/page';
import { first } from '@/src/lib/db/ops';

const signer = createTestSigner('online-test');
const DAY = 86_400_000;
const NOW = new Date('2027-01-10T12:00:00.000Z');
const savedEnv = { ...process.env };

const onlineKey = (overrides: Record<string, unknown> = {}) =>
  signLicense(signer, licensePayload(signer, { v: 2, id: 'LIC-ON', edition: 'business', iat: '2026-01-01T00:00:00.000Z', exp: '2099-12-31T00:00:00.000Z', ...overrides }));
const offlineKey = () => signLicense(signer, licensePayload(signer, { id: 'LIC-OFF' }));
const statement = (overrides: Record<string, unknown> = {}) =>
  signStatement(signer, statementPayload(signer, { id: 'LIC-ON', iat: NOW.toISOString(), ...overrides }));

/** The license server: answers every request with `body` and `status`. */
function server(answer: { statement?: string; status?: number }) {
  return vi.fn(async () =>
    answer.statement !== undefined
      ? new Response(JSON.stringify({ statement: answer.statement }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(null, { status: answer.status ?? 500 })
  );
}

async function setRow(rowKey: string, value: unknown) {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, rowKey));
  await ctx.db.insert(schema.settings).values({ key: rowKey, value: JSON.stringify(value), updatedAt: new Date().toISOString() });
}

async function clearRow(rowKey: string) {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, rowKey));
}

async function rawRow(rowKey: string): Promise<string | null> {
  return (await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, rowKey)).limit(1)))?.value ?? null;
}

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

beforeEach(async () => {
  ctx.db = createTestDb();
  ctx.permissions = new Set(['license:read', 'license:write']);
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ user: { id: '1' }, access: adminAccess(1) } as never);
  setTrustedLicenseKeysForTests(signer.keys);
  resetOnlineLicenseCheckSchedulerForTests();
  delete process.env.LICENSE_SERVER_URL;
  delete process.env.LICENSE_AUTO_UPDATE_DISABLED;
  delete process.env.INSTANCE_MODE;
  delete process.env.INSTANCE_SLAVES;
  await setRow(LICENSE_SETTING_KEY, onlineKey());
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => setTrustedLicenseKeysForTests(null));

describe('one check', () => {
  it('sends the license id and the key fingerprint only, and stores a verified confirmation', async () => {
    const fetchImpl = server({ statement: statement() });
    expect(await runOnlineLicenseCheck({ now: NOW, fetchImpl: fetchImpl as never })).toBe('confirmed');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://license.ingres.si/v1/licenses/LIC-ON/status');
    expect(JSON.parse(String(init.body))).toEqual({ keySha256: keyFingerprint(onlineKey()) });

    const view = await getLicenseView(NOW);
    expect(view.status).toBe('active');
    expect(view.onlineCheck).toEqual({
      required: true,
      state: 'confirmed',
      confirmedAt: NOW.toISOString(),
      validUntil: new Date(NOW.getTime() + 14 * DAY).toISOString(),
      lastAttemptAt: NOW.toISOString(),
      lastError: null,
    });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('turns paid settings read-only at once when the license server says revoked, and back when it confirms again', async () => {
    await runOnlineLicenseCheck({ now: NOW, fetchImpl: server({ statement: statement() }) as never });
    const later = new Date(NOW.getTime() + DAY);
    expect(await runOnlineLicenseCheck({ now: later, fetchImpl: server({ statement: statement({ status: 'revoked', iat: later.toISOString() }) }) as never })).toBe('revoked');
    expect((await getLicenseState(later)).status).toBe('revoked');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'license_revoked', userId: null, entityType: 'license' }));

    // Months later the revocation still holds, whatever its expiry.
    expect((await getLicenseState(new Date(later.getTime() + 90 * DAY))).status).toBe('revoked');

    const after = new Date(later.getTime() + DAY);
    expect(await runOnlineLicenseCheck({ now: after, fetchImpl: server({ statement: statement({ iat: after.toISOString() }) }) as never, actorUserId: 1 })).toBe('confirmed');
    expect((await getLicenseState(after)).status).toBe('active');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'license_reinstated', userId: 1 }));
  });

  it('never replaces a statement with an older one', async () => {
    await runOnlineLicenseCheck({ now: NOW, fetchImpl: server({ statement: statement({ status: 'revoked' }) }) as never });
    const replay = statement({ iat: new Date(NOW.getTime() - DAY).toISOString() });
    await runOnlineLicenseCheck({ now: new Date(NOW.getTime() + 2 * 3_600_000), fetchImpl: server({ statement: replay }) as never });
    expect((await getLicenseState(NOW)).status).toBe('revoked');
  });

  it.each([
    ['a statement about another license', { statement: statement({ id: 'LIC-OTHER' }) }, "the license server's answer could not be verified"],
    ['a statement signed by an unknown key', { statement: signStatement(createTestSigner('online-test'), statementPayload(signer, { id: 'LIC-ON', iat: NOW.toISOString() })) }, "the license server's answer could not be verified"],
    ['404', { status: 404 }, 'the license server does not know this license key'],
    ['503', { status: 503 }, 'the license server answered HTTP 503'],
  ])('records %s as a failed attempt and stores nothing', async (_name, answer, error) => {
    expect(await runOnlineLicenseCheck({ now: NOW, fetchImpl: server(answer) as never })).toBe('failed');
    const check = await readLicenseCheck();
    expect(check.statements).toEqual({});
    expect(check).toMatchObject({ licenseId: 'LIC-ON', lastAttemptAt: NOW.toISOString(), lastSuccessAt: null, lastError: error });
    expect((await getLicenseView(NOW)).onlineCheck).toMatchObject({ state: 'pending', lastError: error });
  });

  it('sends nothing with an invalid LICENSE_SERVER_URL', async () => {
    process.env.LICENSE_SERVER_URL = 'http://license.example.com';
    const fetchImpl = server({ statement: statement() });
    expect(await runOnlineLicenseCheck({ now: NOW, fetchImpl: fetchImpl as never })).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await readLicenseCheck()).lastError).toBe('LICENSE_SERVER_URL must be an https:// URL');
  });

  it('never asks for an offline key, without a key, or on a replica', async () => {
    const fetchImpl = server({ statement: statement() });
    await setRow(LICENSE_SETTING_KEY, offlineKey());
    expect(await runOnlineLicenseCheck({ now: NOW, fetchImpl: fetchImpl as never })).toBe('not_required');
    expect((await getLicenseView(NOW)).onlineCheck).toMatchObject({ required: false, state: null });
    await clearRow(LICENSE_SETTING_KEY);
    expect(await runOnlineLicenseCheck({ now: NOW, fetchImpl: fetchImpl as never })).toBe('not_required');
    await setRow(LICENSE_SETTING_KEY, onlineKey());
    await setRow('instance_mode', 'slave');
    expect(await runOnlineLicenseCheck({ now: NOW, fetchImpl: fetchImpl as never })).toBe('replica');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the check out of instance sync and the configuration export', async () => {
    await runOnlineLicenseCheck({ now: NOW, fetchImpl: server({ statement: statement() }) as never });
    expect(await rawRow(LICENSE_CHECK_SETTING_KEY)).toContain('s1.');
    expect(CONFIG_SETTING_KEYS).not.toContain(LICENSE_CHECK_SETTING_KEY);
    expect(JSON.stringify(await buildSyncPayload())).not.toContain('s1.');
  });
});

describe('the first days of a new key', () => {
  it('start when the key is first installed, and reinstalling it does not restart them', async () => {
    await clearRow(LICENSE_SETTING_KEY);
    vi.stubGlobal('fetch', server({ status: 503 }));
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const put = await licenseRoute.PUT(request('/api/v1/license', 'PUT', { key: onlineKey() }));
      expect(put.status).toBe(200);
      const body = await put.json();
      expect(body.onlineCheck).toMatchObject({ required: true, state: 'pending', lastError: 'the license server answered HTTP 503' });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date(NOW.getTime() + 8 * DAY));
      expect((await getLicenseState()).status).toBe('unconfirmed');
      expect((await licenseRoute.DELETE(request('/api/v1/license', 'DELETE'))).status).toBe(204);
      const again = await licenseRoute.PUT(request('/api/v1/license', 'PUT', { key: onlineKey() }));
      expect((await again.json()).status).toBe('unconfirmed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a key installed from the License page is checked right away', async () => {
    await clearRow(LICENSE_SETTING_KEY);
    const fetchImpl = server({ statement: signStatement(signer, statementPayload(signer, { id: 'LIC-ON', iat: new Date().toISOString() })) });
    vi.stubGlobal('fetch', fetchImpl);
    const form = new FormData();
    form.set('key', onlineKey());
    expect(await installLicenseAction(form)).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await getLicenseView()).onlineCheck.state).toBe('confirmed');
  });
});

describe('POST /api/v1/license/check', () => {
  it('needs license:write', async () => {
    ctx.permissions = new Set(['license:read']);
    expect((await checkRoute.POST(request('/api/v1/license/check', 'POST'))).status).toBe(403);
  });

  it('checks now and answers with the license view, at most once a minute', async () => {
    vi.stubGlobal('fetch', server({ statement: signStatement(signer, statementPayload(signer, { id: 'LIC-ON', iat: new Date().toISOString() })) }));
    const response = await checkRoute.POST(request('/api/v1/license/check', 'POST'));
    expect(response.status).toBe(200);
    expect((await response.json()).onlineCheck).toMatchObject({ required: true, state: 'confirmed', lastError: null });
    const again = await checkRoute.POST(request('/api/v1/license/check', 'POST'));
    expect(again.status).toBe(429);
  });

  it('is a conflict with an offline key, without a key and on a replica', async () => {
    await setRow(LICENSE_SETTING_KEY, offlineKey());
    expect(await checkLicenseNow(1, NOW, server({}) as never).catch((error) => error)).toMatchObject({ status: 409, message: 'The installed key is an offline key: it is not confirmed online' });
    await clearRow(LICENSE_SETTING_KEY);
    expect(await checkLicenseNow(1, NOW, server({}) as never).catch((error) => error)).toMatchObject({ status: 409, message: 'No license key is installed' });
    await setRow(LICENSE_SETTING_KEY, onlineKey());
    process.env.INSTANCE_MODE = 'slave';
    expect((await checkRoute.POST(request('/api/v1/license/check', 'POST'))).status).toBe(409);
  });

  it('the License page action reports failures as text', async () => {
    vi.stubGlobal('fetch', server({ status: 404 }));
    const result = await checkLicenseNowAction();
    expect(result).toMatchObject({ ok: true, view: { onlineCheck: { lastError: 'the license server does not know this license key' } } });
    await setRow(LICENSE_SETTING_KEY, offlineKey());
    expect(await checkLicenseNowAction()).toEqual({ ok: false, error: 'The installed key is an offline key: it is not confirmed online' });
  });
});

describe('the scheduler', () => {
  it('asks when there is no confirmation, then waits a day; after a failure, an hour', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = server({ statement: statement() });
    expect(await runOnlineLicenseCheckTick(NOW, ok as never)).toBe('confirmed');
    expect(await runOnlineLicenseCheckTick(new Date(NOW.getTime() + 23 * 3_600_000), ok as never)).toBe('not_due');
    expect(ok).toHaveBeenCalledTimes(1);

    const down = server({ status: 503 });
    const day = NOW.getTime() + DAY;
    expect(await runOnlineLicenseCheckTick(new Date(day), down as never)).toBe('failed');
    expect(await runOnlineLicenseCheckTick(new Date(day + 30 * 60_000), down as never)).toBe('not_due');
    expect(await runOnlineLicenseCheckTick(new Date(day + 61 * 60_000), down as never)).toBe('failed');
    expect(down).toHaveBeenCalledTimes(2);
    // Logged once a day, without the server's answer.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('LIC-ON');
  });

  it('does nothing for an offline key or on a replica', async () => {
    const fetchImpl = server({ statement: statement() });
    await setRow(LICENSE_SETTING_KEY, offlineKey());
    expect(await runOnlineLicenseCheckTick(NOW, fetchImpl as never)).toBe('not_required');
    await setRow(LICENSE_SETTING_KEY, onlineKey());
    await setRow('instance_mode', 'slave');
    expect(await runOnlineLicenseCheckTick(NOW, fetchImpl as never)).toBe('replica');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('needs attention', () => {
  const collect = (now: Date) => licenseAttentionProvider.collect({ access: adminAccess(1), now });

  it('lists nothing for a confirmed or offline license', async () => {
    await runOnlineLicenseCheck({ now: NOW, fetchImpl: server({ statement: statement() }) as never });
    expect(await collect(NOW)).toEqual([]);
    await setRow(LICENSE_SETTING_KEY, offlineKey());
    expect(await collect(NOW)).toEqual([]);
  });

  it('warns about a key not confirmed a day after it was installed, then is critical', async () => {
    await runOnlineLicenseCheck({ now: NOW, fetchImpl: server({ status: 503 }) as never });
    expect(await collect(new Date(NOW.getTime() + 3_600_000))).toEqual([]);
    expect(await collect(new Date(NOW.getTime() + 2 * DAY))).toEqual([
      expect.objectContaining({ severity: 'warning', title: 'License LIC-ON is not confirmed yet', actions: [{ label: 'License', route: '/license' }] }),
    ]);
    expect(await collect(new Date(NOW.getTime() + 8 * DAY))).toEqual([
      expect.objectContaining({ severity: 'critical', title: 'License LIC-ON could not be confirmed' }),
    ]);
  });

  it('is critical for a revoked license', async () => {
    await runOnlineLicenseCheck({ now: NOW, fetchImpl: server({ statement: statement({ status: 'revoked' }) }) as never });
    expect(await collect(NOW)).toEqual([expect.objectContaining({ severity: 'critical', title: 'License LIC-ON was revoked' })]);
  });

  it('warns when confirmations have failed for two days', async () => {
    await runOnlineLicenseCheck({ now: NOW, fetchImpl: server({ statement: statement() }) as never });
    const later = new Date(NOW.getTime() + 3 * DAY);
    await runOnlineLicenseCheck({ now: later, fetchImpl: server({ status: 503 }) as never });
    expect(await collect(later)).toEqual([expect.objectContaining({ severity: 'warning', title: 'License LIC-ON could not be confirmed lately' })]);
  });
});

describe('the License page', () => {
  it('shows the confirmation of an online key, and "Verified offline" only for offline keys', async () => {
    await runOnlineLicenseCheck({ now: new Date(), fetchImpl: server({ statement: signStatement(signer, statementPayload(signer, { id: 'LIC-ON', iat: new Date().toISOString() })) }) as never });
    let html = renderToStaticMarkup(await LicensePage());
    expect(html).toContain('Online key');
    expect(html).toContain('Confirmed with license.ingres.si');
    expect(html).toContain('Check now');
    expect(html).not.toContain('Verified offline');
    await setRow(LICENSE_SETTING_KEY, offlineKey());
    html = renderToStaticMarkup(await LicensePage());
    expect(html).toContain('Verified offline');
    expect(html).not.toContain('Confirmed with');
  });

  it('says a revoked license is read-only and that nothing stops', async () => {
    await runOnlineLicenseCheck({ now: new Date(), fetchImpl: server({ statement: signStatement(signer, statementPayload(signer, { id: 'LIC-ON', status: 'revoked', iat: new Date().toISOString() })) }) as never });
    const html = renderToStaticMarkup(await LicensePage());
    expect(html).toContain('Revoked');
    expect(html).toContain('The license server reports this license as revoked, after a refund or a chargeback.');
    expect(html).toContain('Paid features already set up keep running; their settings are read-only.');
  });

  it('says how to fix an unconfirmed license', async () => {
    await setRow(LICENSE_CHECK_SETTING_KEY, { statements: {}, firstSeen: { 'LIC-ON': new Date(Date.now() - 30 * DAY).toISOString() } });
    const html = renderToStaticMarkup(await LicensePage());
    expect(html).toContain('Not confirmed');
    expect(html).toContain('Ingressi could not confirm this license with license.ingres.si');
    expect(html).toContain('Allow outbound HTTPS to license.ingres.si, or ask sales@ingres.si for an offline key.');
  });
});
