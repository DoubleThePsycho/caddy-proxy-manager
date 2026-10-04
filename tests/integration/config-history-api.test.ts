/**
 * REST endpoints of configuration history and configuration export/import:
 * the license gate on every paid write path, read access without a license,
 * status codes and the file transfer formats.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { installLicense, licenseSigner, seedConfiguration, setSettingRow, type Fixture } from '../helpers/config-fixture';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))), requireApiAdmin: vi.fn() };
});

import { requireApiAdmin, ApiAuthError } from '../../src/lib/api-auth';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { CaddyApplyError } from '../../src/lib/caddy-apply-error';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { HISTORY_SETTING_KEY } from '../../ee/config-history/settings';
import * as listRoute from '../../app/api/v1/config-history/route';
import * as settingsRoute from '../../app/api/v1/config-history/settings/route';
import * as detailRoute from '../../app/api/v1/config-history/[id]/route';
import * as diffRoute from '../../app/api/v1/config-history/[id]/diff/route';
import * as restoreRoute from '../../app/api/v1/config-history/[id]/restore/route';
import * as exportRoute from '../../app/api/v1/config/export/route';
import * as importRoute from '../../app/api/v1/config/import/route';
import { first } from '@/src/lib/db/ops';

const PASSPHRASE = 'correct horse battery staple';
let fx: Fixture;

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  fx = await seedConfiguration(ctx.db);
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: fx.adminId, role: 'admin', authMethod: 'bearer' });
});

afterAll(() => setTrustedLicenseKeysForTests(null));

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string | FormData } = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return new NextRequest(`http://localhost${path}`, init);
}

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

async function createSnapshot(): Promise<number> {
  const response = await listRoute.POST(req('POST', '/api/v1/config-history', { summary: 'baseline' }));
  expect(response.status).toBe(201);
  return (await response.json()).id;
}

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
}

describe('license gate on paid write endpoints', () => {
  it('POST /config-history, PUT /config-history/settings and POST /config-history/{id}/restore return 403 without a license', async () => {
    await installLicense(ctx.db);
    const id = await createSnapshot();
    await removeLicense();

    const responses = [
      await listRoute.POST(req('POST', '/api/v1/config-history', {})),
      await settingsRoute.PUT(req('PUT', '/api/v1/config-history/settings', { enabled: true })),
      await restoreRoute.POST(req('POST', `/api/v1/config-history/${id}/restore`), params(id)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(
        'Configuration history and rollback needs an active Ingressi Homelab license or higher'
      );
    }
    expect(applyCaddyConfig).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(schema.configSnapshots)).toHaveLength(1);
    expect(await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, HISTORY_SETTING_KEY)).limit(1))).toBeUndefined();
  });

  it('lets PUT /config-history/settings turn recording off and DELETE snapshots without a license', async () => {
    await installLicense(ctx.db);
    await settingsRoute.PUT(req('PUT', '/api/v1/config-history/settings', { enabled: true }));
    const id = await createSnapshot();
    await createSnapshot();
    await removeLicense();

    const stillOn = await settingsRoute.PUT(req('PUT', '/api/v1/config-history/settings', { retention: 10 }));
    expect(stillOn.status).toBe(403);

    const off = await settingsRoute.PUT(req('PUT', '/api/v1/config-history/settings', { enabled: false }));
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false, retention: 200, configurable: false });

    const one = await detailRoute.DELETE(req('DELETE', `/api/v1/config-history/${id}`), params(id));
    expect(one.status).toBe(204);
    expect((await detailRoute.DELETE(req('DELETE', `/api/v1/config-history/${id}`), params(id))).status).toBe(404);

    const all = await listRoute.DELETE(req('DELETE', '/api/v1/config-history'));
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ deleted: 2 });
    expect(await ctx.db.select().from(schema.configSnapshots)).toHaveLength(0);
  });

  it('validates the settings body', async () => {
    const response = await settingsRoute.PUT(req('PUT', '/api/v1/config-history/settings', '{broken'));
    expect(response.status).toBe(400);
  });

  it('allows the write endpoints with a license', async () => {
    await installLicense(ctx.db);
    const settings = await settingsRoute.PUT(req('PUT', '/api/v1/config-history/settings', { enabled: true, retention: 50 }));
    expect(settings.status).toBe(200);
    expect(await settings.json()).toEqual({ enabled: true, retention: 50, configurable: true });

    const id = await createSnapshot();
    const restore = await restoreRoute.POST(req('POST', `/api/v1/config-history/${id}/restore`), params(id));
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({ restoredSnapshotId: id, warning: null });
  });

  it('requires an administrator everywhere', async () => {
    vi.mocked(requireApiAdmin).mockRejectedValue(new ApiAuthError('Administrator privileges required', 403));
    const responses = [
      await listRoute.GET(req('GET', '/api/v1/config-history')),
      await settingsRoute.GET(req('GET', '/api/v1/config-history/settings')),
      await detailRoute.GET(req('GET', '/api/v1/config-history/1'), params(1)),
      await diffRoute.GET(req('GET', '/api/v1/config-history/1/diff'), params(1)),
      await detailRoute.DELETE(req('DELETE', '/api/v1/config-history/1'), params(1)),
      await listRoute.DELETE(req('DELETE', '/api/v1/config-history')),
      await exportRoute.POST(req('POST', '/api/v1/config/export', { passphrase: PASSPHRASE })),
      await importRoute.POST(req('POST', '/api/v1/config/import', { passphrase: PASSPHRASE, file: '{}' })),
    ];
    for (const response of responses) expect(response.status).toBe(403);
  });
});

describe('read endpoints without a license', () => {
  it('list, settings, detail and diff stay available', async () => {
    await installLicense(ctx.db);
    const id = await createSnapshot();
    await removeLicense();

    const list = await listRoute.GET(req('GET', '/api/v1/config-history?limit=10&offset=0'));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ total: 1, limit: 10, offset: 0, snapshots: [{ id, reason: 'manual', summary: 'baseline' }] });

    const settings = await settingsRoute.GET(req('GET', '/api/v1/config-history/settings'));
    expect(await settings.json()).toEqual({ enabled: false, retention: 200, configurable: false });

    const detail = await detailRoute.GET(req('GET', `/api/v1/config-history/${id}`), params(id));
    expect(detail.status).toBe(200);
    expect((await detail.json()).content.counts).toMatchObject({ proxyHosts: 1, certificates: 1 });

    await ctx.db.update(schema.proxyHosts).set({ name: 'Renamed' });
    const diff = await diffRoute.GET(req('GET', `/api/v1/config-history/${id}/diff?against=current`), params(id));
    expect(diff.status).toBe(200);
    const body = await diff.json();
    expect(body.against).toEqual({ kind: 'current' });
    expect(body.diff.entities[0].changed[0].changes).toEqual([{ path: 'name', before: 'Renamed', after: 'App' }]);
  });

  it('answers 404 for unknown or malformed ids and 400 for bad query parameters', async () => {
    expect((await detailRoute.GET(req('GET', '/api/v1/config-history/42'), params(42))).status).toBe(404);
    expect((await detailRoute.GET(req('GET', '/api/v1/config-history/abc'), params('abc'))).status).toBe(404);
    expect((await diffRoute.GET(req('GET', '/api/v1/config-history/0/diff'), params(0))).status).toBe(404);
    expect((await listRoute.GET(req('GET', '/api/v1/config-history?limit=-1'))).status).toBe(400);
  });
});

describe('restore endpoint', () => {
  it('answers 409 on a sync slave', async () => {
    await installLicense(ctx.db);
    const id = await createSnapshot();
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    const response = await restoreRoute.POST(req('POST', `/api/v1/config-history/${id}/restore`), params(id));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/sync slave/);
  });

  it('answers 502 when Caddy rejects the restored configuration', async () => {
    await installLicense(ctx.db);
    const id = await createSnapshot();
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Caddy rejected configuration', 'CADDY_REJECTED'));
    const response = await restoreRoute.POST(req('POST', `/api/v1/config-history/${id}/restore`), params(id));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/Nothing was changed/);
  });
});

describe('export and import endpoints (no license needed)', () => {
  it('exports a file attachment and imports it back as multipart and as JSON', async () => {
    const exported = await exportRoute.POST(req('POST', '/api/v1/config/export', { passphrase: PASSPHRASE }));
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toMatch(/^attachment; filename="ingressi-configuration-.+\.json"$/);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    const text = await exported.text();
    expect(JSON.parse(text).format).toBe('ingressi-configuration');

    const form = new FormData();
    form.append('file', new File([text], 'export.json', { type: 'application/json' }));
    form.append('passphrase', PASSPHRASE);
    const multipart = await importRoute.POST(req('POST', '/api/v1/config/import', form));
    expect(multipart.status).toBe(200);
    expect(await multipart.json()).toMatchObject({ ok: true, warning: null, beforeSnapshotId: null, counts: { proxyHosts: 1 } });

    await setSettingRow(ctx.db, HISTORY_SETTING_KEY, { enabled: true, retention: 200 });
    const json = await importRoute.POST(req('POST', '/api/v1/config/import', { passphrase: PASSPHRASE, file: JSON.parse(text) }));
    expect(json.status).toBe(200);
    const body = await json.json();
    expect(body.beforeSnapshotId).toEqual(expect.any(Number));
    expect((await first(ctx.db.select().from(schema.configSnapshots).limit(1)))!.reason).toBe('import');
  });

  it('answers 400 for a wrong passphrase, a missing file or a short export passphrase', async () => {
    const exported = await (await exportRoute.POST(req('POST', '/api/v1/config/export', { passphrase: PASSPHRASE }))).text();
    const wrong = await importRoute.POST(req('POST', '/api/v1/config/import', { passphrase: 'wrong wrong wrong', file: exported }));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/^Wrong passphrase/);
    expect((await importRoute.POST(req('POST', '/api/v1/config/import', { passphrase: PASSPHRASE }))).status).toBe(400);
    expect((await importRoute.POST(req('POST', '/api/v1/config/import', 'nope'))).status).toBe(400);
    expect((await exportRoute.POST(req('POST', '/api/v1/config/export', { passphrase: 'short' }))).status).toBe(400);
  });

  it('answers 413 for a file that is too large', async () => {
    const response = await importRoute.POST(
      req('POST', '/api/v1/config/import', '{}', { 'content-length': String(60 * 1024 * 1024) })
    );
    expect(response.status).toBe(413);
  });

  it('answers 409 on a sync slave', async () => {
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    expect((await exportRoute.POST(req('POST', '/api/v1/config/export', { passphrase: PASSPHRASE }))).status).toBe(409);
    expect((await importRoute.POST(req('POST', '/api/v1/config/import', { passphrase: PASSPHRASE, file: '{}' }))).status).toBe(409);
  });
});
