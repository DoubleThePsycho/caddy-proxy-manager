/**
 * REST endpoints of scheduled backups: the write paths, disabling and
 * deleting, read access, validation, secret redaction and status codes. The storage is a fake S3
 * bucket behind the global fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { seedConfiguration, type Fixture } from '../helpers/config-fixture';
import { FakeS3 } from '../helpers/fake-s3';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return { ...actual, requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))), requireApiAdmin: vi.fn() };
});

import { requireApiAdmin, ApiAuthError } from '../../src/lib/api-auth';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { CaddyApplyError } from '../../src/lib/caddy-apply-error';
import * as listRoute from '../../app/api/v1/backup-destinations/route';
import * as detailRoute from '../../app/api/v1/backup-destinations/[id]/route';
import * as testRoute from '../../app/api/v1/backup-destinations/[id]/test/route';
import * as runRoute from '../../app/api/v1/backup-destinations/[id]/run/route';
import * as objectsRoute from '../../app/api/v1/backup-destinations/[id]/objects/route';
import * as restoreRoute from '../../app/api/v1/backup-destinations/[id]/restore/route';
import * as runsRoute from '../../app/api/v1/backup-runs/route';
import { first } from '@/src/lib/db/ops';

const SECRET = 'route-secret-access-key-SENTINEL';
const PASSPHRASE = 'route passphrase SENTINEL';
const ENDPOINT = 'http://minio:9000';

let fx: Fixture;
let fake: FakeS3;

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  fx = await seedConfiguration(ctx.db);
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: fx.adminId, role: 'admin', authMethod: 'bearer' });
  fake = new FakeS3({ endpoint: ENDPOINT, bucket: 'backups', pathStyle: true, accessKeyId: 'minioadmin' });
  vi.stubGlobal('fetch', fake.fetch);
});

afterEach(() => vi.unstubAllGlobals());

function req(method: string, path: string, body?: unknown): NextRequest {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: {} };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return new NextRequest(`http://localhost${path}`, init);
}

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'MinIO',
  endpoint: ENDPOINT,
  bucket: 'backups',
  prefix: 'cfg',
  pathStyle: true,
  accessKeyId: 'minioadmin',
  secretAccessKey: SECRET,
  passphrase: PASSPHRASE,
  schedule: { kind: 'hourly', minute: 15 },
  timeZone: 'Europe/Rome',
  retention: 5,
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
  const response = await listRoute.POST(req('POST', '/api/v1/backup-destinations', body(overrides)));
  expect(response.status).toBe(201);
  return response.json();
}

describe('destinations', () => {
  it('lets an admin view, disable and delete destinations', async () => {
    const { id } = await create();

    expect((await listRoute.GET(req('GET', '/api/v1/backup-destinations'))).status).toBe(200);
    expect((await detailRoute.GET(req('GET', `/api/v1/backup-destinations/${id}`), params(id))).status).toBe(200);
    expect((await objectsRoute.GET(req('GET', `/api/v1/backup-destinations/${id}/objects`), params(id))).status).toBe(200);
    expect((await runsRoute.GET(req('GET', '/api/v1/backup-runs'))).status).toBe(200);

    const off = await detailRoute.PUT(req('PUT', `/api/v1/backup-destinations/${id}`, { enabled: false, name: 'MinIO' }), params(id));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, nextRunAt: null });

    const deleted = await detailRoute.DELETE(req('DELETE', `/api/v1/backup-destinations/${id}`), params(id));
    expect(deleted.status).toBe(204);
    expect((await detailRoute.GET(req('GET', `/api/v1/backup-destinations/${id}`), params(id))).status).toBe(404);
  });

  it('changes, tests, runs and restores a destination', async () => {
    const { id } = await create();
    const updated = await detailRoute.PUT(req('PUT', `/api/v1/backup-destinations/${id}`, { retention: 7 }), params(id));
    expect(updated.status).toBe(200);
    expect((await updated.json()).retention).toBe(7);

    const tested = await testRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/test`), params(id));
    expect(await tested.json()).toMatchObject({ ok: true, failedStep: null });

    const ran = await runRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/run`), params(id));
    expect(ran.status).toBe(200);
    const run = await ran.json();
    expect(run).toMatchObject({ status: 'success', trigger: 'manual' });

    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed' });
    const restored = await restoreRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/restore`, { key: run.objectKey }), params(id));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ ok: true, key: run.objectKey, beforeSnapshotId: null });
    expect((await first(ctx.db.select().from(schema.proxyHosts).limit(1)))!.name).toBe('App');
  });
});

describe('responses', () => {
  it('never returns the secret access key or the passphrase', async () => {
    const created = await listRoute.POST(req('POST', '/api/v1/backup-destinations', body()));
    const createdText = await created.text();
    const { id } = JSON.parse(createdText);
    const texts = [
      createdText,
      await (await listRoute.GET(req('GET', '/api/v1/backup-destinations'))).text(),
      await (await detailRoute.GET(req('GET', `/api/v1/backup-destinations/${id}`), params(id))).text(),
      await (await detailRoute.PUT(req('PUT', `/api/v1/backup-destinations/${id}`, { secretAccessKey: `${SECRET}-2` }), params(id))).text(),
    ];
    for (const text of texts) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PASSPHRASE);
      expect(text).toContain('"hasSecretAccessKey":true');
      expect(text).toContain('"hasPassphrase":true');
    }
    expect(created.headers.get('cache-control')).toBe('no-store');
  });

  it('answers validation errors with 400 and unknown ids with 404', async () => {
    const bad = await listRoute.POST(req('POST', '/api/v1/backup-destinations', body({ timeZone: 'Nowhere/Land' })));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/IANA time zone/);
    const notJson = await listRoute.POST(req('POST', '/api/v1/backup-destinations', 'not json'));
    expect(notJson.status).toBe(400);
    for (const id of ['999', 'abc', '0', '-1']) {
      expect((await detailRoute.GET(req('GET', `/api/v1/backup-destinations/${id}`), params(id))).status).toBe(404);
      expect((await runRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/run`), params(id))).status).toBe(404);
    }
    const { id } = await create();
    const badKey = await restoreRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/restore`, { key: '../etc/passwd' }), params(id));
    expect(badKey.status).toBe(400);
  });

  it('answers a storage failure with 502 and a safe message', async () => {
    const { id } = await create();
    fake.fail = () => ({ status: 403, code: 'InvalidAccessKeyId' });
    const response = await objectsRoute.GET(req('GET', `/api/v1/backup-destinations/${id}/objects`), params(id));
    expect(response.status).toBe(502);
    const { error } = await response.json();
    expect(error).toBe('The storage request failed: HTTP 403 (InvalidAccessKeyId) from the storage: the access key ID is not known to the storage provider');
    expect(error).not.toContain(SECRET);

    const run = await (await runRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/run`), params(id))).json();
    expect(run).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Upload failed: HTTP 403 \(InvalidAccessKeyId\)/) });
  });

  it('answers a configuration Caddy rejects with 502 and keeps the previous one', async () => {
    const { id } = await create();
    const run = await (await runRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/run`), params(id))).json();
    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed' });
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Caddy rejected it', 'CADDY_REJECTED'));
    const response = await restoreRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/restore`, { key: run.objectKey }), params(id));
    expect(response.status).toBe(502);
    expect((await first(ctx.db.select().from(schema.proxyHosts).limit(1)))!.name).toBe('Changed');
  });

  it('pages the run history and filters by destination', async () => {
    const a = await create({ name: 'A', prefix: 'a' });
    const b = await create({ name: 'B', prefix: 'b' });
    for (const id of [a.id, b.id, a.id]) await runRoute.POST(req('POST', `/api/v1/backup-destinations/${id}/run`), params(id));
    const all = await (await runsRoute.GET(req('GET', '/api/v1/backup-runs?per_page=2'))).json();
    expect(all).toMatchObject({ total: 3, page: 1, perPage: 2 });
    expect(all.runs).toHaveLength(2);
    expect(all.runs[0].destinationName).toBe('A');
    const onlyB = await (await runsRoute.GET(req('GET', `/api/v1/backup-runs?destination_id=${b.id}`))).json();
    expect(onlyB.total).toBe(1);
    expect(onlyB.runs[0].destinationId).toBe(b.id);
  });

  it('requires an administrator', async () => {
    vi.mocked(requireApiAdmin).mockRejectedValue(new ApiAuthError('Administrator privileges required', 403));
    expect((await listRoute.GET(req('GET', '/api/v1/backup-destinations'))).status).toBe(403);
    expect((await runsRoute.GET(req('GET', '/api/v1/backup-runs'))).status).toBe(403);
    expect((await objectsRoute.GET(req('GET', '/api/v1/backup-destinations/1/objects'), params(1))).status).toBe(403);
  });
});
