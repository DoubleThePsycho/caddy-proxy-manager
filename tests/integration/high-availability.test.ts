/**
 * High availability, phase 1 (ee/high-availability): the certificate storage
 * REST API and dashboard actions (enabling, changing, going back to local
 * storage, removing, testing), secrets never leaving through the API or the
 * audit log,
 * the rollback when Caddy refuses the storage, slaves, configuration
 * import/restore, instance sync and fleet revisions, and the permission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import { startFakeRedis, type FakeRedis } from '../helpers/fake-redis';
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

import { GET, PUT, DELETE } from '@/app/api/v1/high-availability/storage/route';
import { POST as TEST } from '@/app/api/v1/high-availability/storage/test/route';
import { GET as getOpenApi } from '@/app/api/v1/openapi.json/route';
import {
  removeCertificateStorageAction,
  saveCertificateStorageAction,
  testCertificateStorageAction,
} from '@/ee/high-availability/ui/certificate-storage-actions';
import { applyCaddyConfig } from '@/src/lib/caddy';
import { CaddyApplyError } from '@/src/lib/caddy-apply-error';
import { logAuditEvent } from '@/src/lib/audit';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '@/src/lib/secret';
import { readCurrentConfigContent } from '@/src/lib/config-content';
import { replaceConfiguration } from '@/src/lib/config-replace';
import { applySyncPayload, buildSyncPayload, buildSyncPayloadFromContent, type SyncPayload } from '@/src/lib/instance-sync';
import { ADMIN_LEVEL_PERMISSIONS, PERMISSION_AREAS, UNSCOPED_ONLY_PERMISSIONS, isAdminLevel } from '@/src/lib/permissions';
import { currentFleetContent } from '@/ee/fleet/revisions';
import type { CertificateStorageView, StoredCertificateStorage, StorageTestResult } from '@/ee/high-availability/types';
import { first } from '@/src/lib/db/ops';

const PASSWORD = 'valkey-password-sentinel-7c1e';
const KEY = 'encryption-key-sentinel-0123456789abcdef';
const KEY_NAME = 'certificate_storage';

async function setRow(key: string, value: unknown) {
  const json = JSON.stringify(value);
  const updatedAt = new Date().toISOString();
  await ctx.db.insert(schema.settings).values({ key, value: json, updatedAt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: json, updatedAt } });
}

async function stored(key = KEY_NAME): Promise<StoredCertificateStorage | null> {
  const row = await first(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1));
  return row ? JSON.parse(row.value) : null;
}

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/high-availability/storage', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

async function call(handler: (request: NextRequest) => Promise<Response>, method: string, body?: unknown) {
  const response = await handler(request(method, body));
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) };
}

const redisInput = (overrides: Record<string, unknown> = {}) => ({
  mode: 'standalone',
  addresses: ['valkey.example.com:6379'],
  password: PASSWORD,
  encryptionKey: KEY,
  keyPrefix: 'caddy/cluster-a',
  ...overrides,
});

function auditCalls() {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event);
}

const fakes: FakeRedis[] = [];

beforeEach(() => {
  ctx.db = createTestDb();
  vi.mocked(logAuditEvent).mockClear();
  vi.mocked(applyCaddyConfig).mockReset();
  vi.mocked(applyCaddyConfig).mockResolvedValue({ ok: true } as never);
  delete process.env.INSTANCE_MODE;
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describe('GET /api/v1/high-availability/storage', () => {
  it('reports local storage by default', async () => {
    const { status, data } = await call(GET, 'GET');
    expect(status).toBe(200);
    expect(data).not.toHaveProperty('configurable');
    expect(data).toMatchObject({
      backend: 'local', redis: null, source: 'default', editable: true, error: null, migration: null,
      envPrefix: 'CADDY_STORAGE_',
    });
  });
});

describe('enabling and changing', () => {
  it('enables it, stores the secrets encrypted and never returns them', async () => {
    const { status, text, data } = await call(PUT, 'PUT', { backend: 'redis', redis: redisInput() });
    expect(status).toBe(200);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('enc:v1:');
    expect(data as CertificateStorageView).toMatchObject({
      backend: 'redis', source: 'local',
      redis: { mode: 'standalone', addresses: ['valkey.example.com:6379'], keyPrefix: 'caddy/cluster-a', hasPassword: true, hasEncryptionKey: true },
      migration: { environment: ['CADDY_STORAGE_PASSWORD', 'CADDY_STORAGE_ENCRYPTION_KEY'] },
    });
    const value = (await stored())!;
    expect(isEncryptedSecret(value.redis!.password!)).toBe(true);
    expect(decryptSecret(value.redis!.password!)).toBe(PASSWORD);
    expect(decryptSecret(value.redis!.encryptionKey!)).toBe(KEY);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);

    const [event] = auditCalls();
    expect(event).toMatchObject({
      action: 'certificate_storage_updated',
      entityType: 'certificate_storage',
      summary: expect.stringMatching(/Switched certificate storage to Redis\/Valkey/),
      data: { backend: 'redis', previousBackend: 'local', secretsChanged: ['password', 'encryptionKey'], redis: { secrets: { password: 'stored' } } },
    });
    expect(JSON.stringify(event)).not.toMatch(new RegExp(`${PASSWORD}|${KEY}|enc:v1:`));
    expect(JSON.stringify((await call(GET, 'GET')).data)).not.toMatch(/enc:v1:|sentinel-7c1e/);
  });

  it('takes the same settings as no change, and changes, switches back, enables again and removes', async () => {
    await call(PUT, 'PUT', { backend: 'redis', redis: redisInput() });
    vi.mocked(applyCaddyConfig).mockClear();

    // Saving the same settings again (secrets left empty) changes nothing.
    const same = await call(PUT, 'PUT', { backend: 'redis', redis: redisInput({ password: '', encryptionKey: '' }) });
    expect(same.status).toBe(200);
    expect(applyCaddyConfig).not.toHaveBeenCalled();

    const changed = await call(PUT, 'PUT', { backend: 'redis', redis: redisInput({ password: '', encryptionKey: '', keyPrefix: 'other' }) });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({ backend: 'redis', redis: { keyPrefix: 'other', hasPassword: true, hasEncryptionKey: true } });
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);

    const local = await call(PUT, 'PUT', { backend: 'local' });
    expect(local.status).toBe(200);
    expect(local.data).toMatchObject({ backend: 'local', redis: { hasPassword: true } });
    expect((await stored())!.backend).toBe('local');

    const again = await call(PUT, 'PUT', { backend: 'redis' });
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ backend: 'redis', redis: { keyPrefix: 'other', hasPassword: true } });

    const removed = await call(DELETE, 'DELETE');
    expect(removed.status).toBe(200);
    expect(removed.data).toMatchObject({ backend: 'local', redis: null, source: 'default' });
    expect(await stored()).toBeNull();
    expect(auditCalls().map((event) => event.action)).toEqual([
      'certificate_storage_updated', 'certificate_storage_updated', 'certificate_storage_updated', 'certificate_storage_updated',
      'certificate_storage_removed',
    ]);
  });
});

describe('PUT /api/v1/high-availability/storage', () => {
  it('validates the input', async () => {
    for (const body of [
      'not json',
      { backend: 'redis' },
      { backend: 'redis', redis: redisInput({ addresses: ['valkey.example.com'] }) },
      { backend: 'redis', redis: redisInput({ passwordEnv: 'SESSION_SECRET', password: undefined }) },
      { backend: 'redis', redis: redisInput(), unknown: true },
    ]) {
      const response = typeof body === 'string'
        ? await PUT(new NextRequest('http://localhost/api/v1/high-availability/storage', { method: 'PUT', body }))
        : await PUT(request('PUT', body));
      expect(response.status).toBe(400);
    }
    expect(await stored()).toBeNull();
  });

  it('asks for the password again before sending it to another server', async () => {
    await call(PUT, 'PUT', { backend: 'redis', redis: redisInput() });
    const moved = await call(PUT, 'PUT', { backend: 'redis', redis: redisInput({ addresses: ['attacker.example.org:6379'], password: '' }) });
    expect(moved.status).toBe(400);
    expect(moved.data.error).toMatch(/Enter the password again/);
    expect((await stored())!.redis!.addresses).toEqual(['valkey.example.com:6379']);
  });

  it('puts the previous setting back when Caddy refuses the storage', async () => {
    await call(PUT, 'PUT', { backend: 'local', redis: redisInput() });
    const before = await stored();
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(
      new CaddyApplyError('Caddy rejected configuration: Caddy could not reach the certificate storage server', 'CADDY_REJECTED')
    );
    const { status, data } = await call(PUT, 'PUT', { backend: 'redis' });
    expect(status).toBe(502);
    expect(data.error).toBe(
      'Caddy did not accept the certificate storage (Caddy rejected configuration: Caddy could not reach the certificate storage server). Nothing was changed.'
    );
    expect(await stored()).toEqual(before);
    // Applied, refused, applied again with the previous setting.
    expect(applyCaddyConfig).toHaveBeenCalledTimes(3);
  });

  it('is refused on a sync slave, which shows the master\'s setting', async () => {
    process.env.INSTANCE_MODE = 'slave';
    await setRow(`synced:${KEY_NAME}`, { backend: 'redis', redis: { ...(await prepared()), password: encryptSecret(PASSWORD) } });
    const put = await call(PUT, 'PUT', { backend: 'local' });
    expect(put.status).toBe(409);
    expect(put.data.error).toMatch(/uses the master's certificate storage setting/);
    const view = (await call(GET, 'GET')).data as CertificateStorageView;
    expect(view).toMatchObject({ backend: 'redis', source: 'master', editable: false, redis: { hasPassword: true } });
  });
});

/** Redis settings as stored, without secrets. */
async function prepared() {
  return { mode: 'standalone', addresses: ['valkey.example.com:6379'], db: 0, keyPrefix: 'caddy', tls: { enabled: false, insecureSkipVerify: false } };
}

describe('POST /api/v1/high-availability/storage/test', () => {
  it('needs something to test', async () => {
    const { status, data } = await call(TEST, 'POST');
    expect(status).toBe(400);
    expect(data.error).toMatch(/Nothing to test/);
  });

  it('tests the settings sent, and the stored ones, from this instance', async () => {
    const fake = await startFakeRedis({ password: PASSWORD });
    fakes.push(fake);
    const candidate = await call(TEST, 'POST', { redis: redisInput({ addresses: [fake.address] }) });
    expect(candidate.status).toBe(200);
    expect(candidate.data as StorageTestResult).toMatchObject({ ok: true, complete: true, server: fake.address });
    expect(await stored()).toBeNull();

    await call(PUT, 'PUT', { backend: 'local', redis: redisInput({ addresses: [fake.address] }) });
    const saved = await call(TEST, 'POST');
    expect(saved.data).toMatchObject({ ok: true });
    // The stored password only goes where it was entered for.
    const elsewhere = await call(TEST, 'POST', { redis: redisInput({ addresses: ['attacker.example.org:6379'], password: '' }) });
    expect(elsewhere.status).toBe(400);

    const tested = auditCalls().filter((event) => event.action === 'certificate_storage_tested');
    expect(tested).toHaveLength(2);
    expect(JSON.stringify(tested)).not.toContain(PASSWORD);
  });
});

describe('dashboard actions', () => {
  it('return the error instead of throwing, and the view on success', async () => {
    expect(await saveCertificateStorageAction({ backend: 'redis' })).toEqual({
      ok: false, error: 'Configure redis to use the redis backend',
    });
    const saved = await saveCertificateStorageAction({ backend: 'redis', redis: redisInput() });
    expect(saved).toMatchObject({ ok: true, view: { backend: 'redis' } });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    expect(await testCertificateStorageAction({ redis: { addresses: ['nope'] } })).toMatchObject({ ok: false });
    expect(await removeCertificateStorageAction()).toMatchObject({ ok: true, view: { backend: 'local', redis: null } });
  });
});

describe('replacing the whole configuration', () => {
  it('brings in, keeps and removes shared storage, and refuses a setting that is not valid', async () => {
    const withStorage = await readCurrentConfigContent();
    withStorage.settings.certificate_storage = { backend: 'redis', redis: { ...(await prepared()), password: encryptSecret(PASSWORD) } };
    await replaceConfiguration(withStorage, { mode: 'import' });
    expect(decryptSecret((await stored())!.redis!.password!)).toBe(PASSWORD);

    // The same storage, its secret encrypted again (as an import does), is no change.
    const same = await readCurrentConfigContent();
    same.settings.certificate_storage = { backend: 'redis', redis: { ...(await prepared()), password: encryptSecret(PASSWORD) } };
    await replaceConfiguration(same, { mode: 'restore' });
    const back = await readCurrentConfigContent();
    back.settings.certificate_storage = null;
    await replaceConfiguration(back, { mode: 'restore' });
    expect(await stored()).toBeNull();

    const invalid = await readCurrentConfigContent();
    invalid.settings.certificate_storage = { backend: 'redis', redis: null };
    await expect(replaceConfiguration(invalid, { mode: 'import' })).rejects.toThrow(/Certificate storage/);
  });

  it('encrypts plaintext secrets an import brings', async () => {
    const content = await readCurrentConfigContent();
    content.settings.certificate_storage = { backend: 'local', redis: { ...(await prepared()), password: PASSWORD } };
    await replaceConfiguration(content, { mode: 'import' });
    expect(isEncryptedSecret((await stored())!.redis!.password!)).toBe(true);
  });
});

describe('instance sync and fleet revisions', () => {
  const setting = async () => ({
    backend: 'redis',
    redis: { ...(await prepared()), password: encryptSecret(PASSWORD), encryptionKeyEnv: 'CADDY_STORAGE_ENCRYPTION_KEY' },
  });

  it('sends the setting with its secret decrypted for sealing, also from a fleet revision', async () => {
    await setRow(KEY_NAME, await setting());
    const payload = await buildSyncPayload();
    expect(payload.settings.certificate_storage).toMatchObject({ backend: 'redis', redis: { password: PASSWORD, encryptionKeyEnv: 'CADDY_STORAGE_ENCRYPTION_KEY' } });
    expect(payload.settings_secret_paths).toContainEqual(['certificate_storage', 'redis', 'password']);

    const revision = await currentFleetContent();
    expect(revision.settings.certificate_storage).toMatchObject({ backend: 'redis' });
    const fromRevision = await buildSyncPayloadFromContent(revision);
    expect(fromRevision.settings.certificate_storage).toEqual(payload.settings.certificate_storage);
    expect(fromRevision.settings_secret_paths).toContainEqual(['certificate_storage', 'redis', 'password']);
  });

  it('stores it on a slave with the secret encrypted under the slave\'s key; an older master\'s payload means local storage', async () => {
    await setRow(KEY_NAME, await setting());
    const payload = await buildSyncPayload();
    ctx.db = createTestDb();
    process.env.INSTANCE_MODE = 'slave';
    await applySyncPayload(payload);
    const synced = (await stored(`synced:${KEY_NAME}`))!;
    expect(isEncryptedSecret(synced.redis!.password!)).toBe(true);
    expect(decryptSecret(synced.redis!.password!)).toBe(PASSWORD);
    expect(synced.redis!.encryptionKeyEnv).toBe('CADDY_STORAGE_ENCRYPTION_KEY');

    const older: SyncPayload = { ...payload, settings: { ...payload.settings } };
    delete older.settings.certificate_storage;
    delete older.settings_secret_paths;
    await applySyncPayload(older);
    expect(await stored(`synced:${KEY_NAME}`)).toBeNull();
  });
});

describe('permission and API documentation', () => {
  it('has an administrator-level, unscoped write permission', () => {
    expect(PERMISSION_AREAS.high_availability).toMatchObject({ actions: ['read', 'write'], instanceWide: true });
    expect(ADMIN_LEVEL_PERMISSIONS).toContain('high_availability:write');
    expect(UNSCOPED_ONLY_PERMISSIONS).toContain('high_availability:write');
    expect(isAdminLevel(['high_availability:write'])).toBe(true);
    expect(isAdminLevel(['high_availability:read'])).toBe(false);
  });

  it('documents every endpoint', async () => {
    const spec = await (await getOpenApi(new NextRequest('http://localhost/api/v1/openapi.json'))).json();
    expect(spec.paths['/api/v1/high-availability/storage'].get.operationId).toBe('getCertificateStorage');
    expect(spec.paths['/api/v1/high-availability/storage'].put.operationId).toBe('setCertificateStorage');
    expect(spec.paths['/api/v1/high-availability/storage'].delete.operationId).toBe('removeCertificateStorage');
    expect(spec.paths['/api/v1/high-availability/storage/test'].post.operationId).toBe('testCertificateStorage');
    expect(spec.tags.map((tag: { name: string }) => tag.name)).toContain('High availability');
    expect(spec.components.schemas.RedisStorageInput.properties.passwordEnv.pattern).toBe('^CADDY_STORAGE_[A-Z0-9_]{1,64}$');
  });
});
