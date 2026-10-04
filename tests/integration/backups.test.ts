/**
 * Scheduled backups (ee/backups) against an in-memory database and a fake S3
 * bucket: secret storage and redaction, validation, the uploaded export
 * file, retention, failure handling and backoff, the scheduler, the
 * connection test, restore through the import path, and the backup_failed
 * alert evaluator.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';
import { createPgReplica } from '../helpers/pg-test-db';
import * as schema from '../../src/lib/db/schema';
import { CERT_KEY, DNS_TOKEN, installLicense, licenseSigner, seedConfiguration, setSettingRow, type Fixture } from '../helpers/config-fixture';
import { FakeS3 } from '../helpers/fake-s3';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { applyCaddyConfig } from '../../src/lib/caddy';
import { logAuditEvent } from '../../src/lib/audit';
import { ApiValidationError } from '../../src/lib/api-errors';
import { decryptSecret, isEncryptedSecret } from '../../src/lib/secret';
import { decodeConfigurationExport } from '../../src/lib/config-transfer';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { HISTORY_SETTING_KEY } from '../../ee/config-history/settings';
import {
  createBackupDestination,
  deleteBackupDestination,
  getBackupDestination,
  listBackupDestinations,
  updateBackupDestination,
} from '../../ee/backups/destinations';
import {
  MAX_RUNS_PER_DESTINATION,
  listBackupObjects,
  listBackupRuns,
  markInterruptedRuns,
  restoreBackup,
  retryDelayMs,
  runBackup,
  runBackupNow,
  runDueBackups,
  testBackupDestination,
} from '../../ee/backups/runner';
import { S3Error } from '../../ee/backups/s3';
import { BACKUP_FILE_PATTERN } from '../../ee/backups/types';
import { evaluateBackupFailed } from '../../ee/alerting/evaluators';
import { createAlertRule } from '../../ee/alerting/rules';
import { first as dbFirst } from '@/src/lib/db/ops';
import { withClusterLock, type ClusterLockOptions } from '@/src/lib/db/locks';
import { destinationLockName } from '../../ee/backups/locks';

const SECRET = 'S3-SECRET-ACCESS-KEY-sentinel/abc+def';
const PASSPHRASE = 'backup passphrase sentinel 42';
const ENDPOINT = 'https://s3.eu-central-1.amazonaws.com';

let fx: Fixture;
let fake: FakeS3;

function newFake() {
  return new FakeS3({ endpoint: ENDPOINT, bucket: 'acme-backups', pathStyle: false, accessKeyId: 'AKIAEXAMPLE', region: 'eu-central-1' });
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  fx = await seedConfiguration(ctx.db);
  await installLicense(ctx.db, 'business');
  fake = newFake();
});

afterAll(() => setTrustedLicenseKeysForTests(null));

async function removeLicense() {
  await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Offsite',
    endpoint: ENDPOINT,
    region: 'eu-central-1',
    bucket: 'acme-backups',
    prefix: 'ingressi',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: SECRET,
    passphrase: PASSPHRASE,
    schedule: { kind: 'daily', time: '03:00' },
    timeZone: 'UTC',
    retention: 30,
    ...overrides,
  };
}

async function destination(overrides: Record<string, unknown> = {}, now?: Date) {
  return createBackupDestination(input(overrides), fx.adminId, now);
}

async function row(id: number) {
  return (await dbFirst(ctx.db.select().from(schema.backupDestinations).where(eq(schema.backupDestinations.id, id)).limit(1)))!;
}

const deps = () => ({ fetch: fake.fetch });

function backupKeys(prefix = 'ingressi/') {
  return fake.keys().filter((key) => key.startsWith(prefix) && BACKUP_FILE_PATTERN.test(key.slice(prefix.length)));
}

describe('destinations', () => {
  it('stores the secret access key and passphrase encrypted and never returns them', async () => {
    const view = await destination();
    expect(view).toMatchObject({
      name: 'Offsite',
      endpoint: ENDPOINT,
      bucket: 'acme-backups',
      prefix: 'ingressi',
      pathStyle: false,
      accessKeyId: 'AKIAEXAMPLE',
      hasSecretAccessKey: true,
      hasPassphrase: true,
      schedule: { kind: 'daily', time: '03:00' },
      timeZone: 'UTC',
      retention: 30,
      running: false,
    });
    const stored = await row(view.id);
    expect(isEncryptedSecret(stored.secretAccessKey)).toBe(true);
    expect(isEncryptedSecret(stored.passphrase)).toBe(true);
    expect(decryptSecret(stored.secretAccessKey)).toBe(SECRET);
    expect(decryptSecret(stored.passphrase)).toBe(PASSPHRASE);

    const visible = JSON.stringify([view, await listBackupDestinations(), await getBackupDestination(view.id)]);
    expect(visible).not.toContain(SECRET);
    expect(visible).not.toContain(PASSPHRASE);
    expect(visible).not.toContain('enc:v1:');
    const audited = JSON.stringify(vi.mocked(logAuditEvent).mock.calls);
    expect(audited).toContain('backup_destination_created');
    expect(audited).not.toContain(SECRET);
    expect(audited).not.toContain(PASSPHRASE);
  });

  it('computes the next run in the destination time zone', async () => {
    const now = new Date('2026-07-01T12:00:00Z');
    const rome = await destination({ timeZone: 'Europe/Rome' }, now);
    expect(rome.nextRunAt).toBe('2026-07-02T01:00:00.000Z');
    const weekly = await destination({ schedule: { kind: 'weekly', day: 'monday', time: '22:30' } }, now);
    expect(weekly.nextRunAt).toBe('2026-07-06T22:30:00.000Z');
    const off = await destination({ enabled: false }, now);
    expect(off.nextRunAt).toBeNull();
  });

  it('normalizes the endpoint, region and prefix', async () => {
    const view = await destination({ endpoint: ' https://S3.Example.COM/ ', region: 'EU-Central-1', prefix: '/a/b/', pathStyle: true });
    expect(view).toMatchObject({ endpoint: 'https://s3.example.com', region: 'eu-central-1', prefix: 'a/b' });
    const root = await destination({ prefix: '' });
    expect(root.prefix).toBe('');
  });

  it.each([
    [{ endpoint: 'ftp://s3.example.com' }, /http or https/],
    [{ endpoint: 'https://s3.example.com/bucket' }, /must not have a path/],
    [{ endpoint: 'https://s3.example.com/?x=1' }, /must not have a path/],
    [{ endpoint: 'https://user:hunter2@s3.example.com' }, /must not contain credentials/],
    [{ endpoint: 'not a url' }, /must be a URL/],
    [{ secretAccessKey: undefined }, /secretAccessKey is required/],
    [{ passphrase: 'too short' }, /at least 12 characters/],
    [{ passphrase: undefined }, /passphrase is required/],
    [{ accessKeyId: 'AKIA/EXAMPLE' }, /accessKeyId/],
    [{ bucket: 'ab' }, /bucket must be/],
    [{ bucket: 'Under_Score' }, /path-style/],
    [{ endpoint: 'http://10.0.0.5:9000' }, /path-style/],
    [{ endpoint: 'http://minio:9000' }, /path-style/],
    [{ prefix: 'a/../b' }, /prefix/],
    [{ prefix: 'a//b' }, /prefix/],
    [{ prefix: 'a b' }, /prefix/],
    [{ region: 'eu central' }, /region/],
    [{ retention: 0 }, /retention/],
    [{ retention: 1001 }, /retention/],
    [{ timeZone: 'Mars/Base' }, /IANA time zone/],
    [{ schedule: { kind: 'daily', time: '25:00' } }, /HH:MM/],
    [{ schedule: { kind: 'monthly' } }, /schedule.kind/],
    [{ extra: true }, /Unknown field "extra"/],
  ])('rejects %j', async (overrides, message) => {
    const error = await destination(overrides).catch((e) => e);
    expect(error).toBeInstanceOf(ApiValidationError);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain('hunter2');
    expect(await ctx.db.select().from(schema.backupDestinations)).toHaveLength(0);
  });

  it('accepts MinIO with path-style addressing', async () => {
    const view = await destination({ endpoint: 'http://minio:9000', pathStyle: true, bucket: 'Legacy_Bucket', region: 'us-east-1' });
    expect(view).toMatchObject({ endpoint: 'http://minio:9000', pathStyle: true, bucket: 'Legacy_Bucket' });
  });

  it('is refused on a sync slave', async () => {
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    await expect(destination()).rejects.toMatchObject({ status: 409 });
  });

  it('keeps stored secrets on update and asks for the secret again when the endpoint changes', async () => {
    const view = await destination();
    const before = await row(view.id);
    const renamed = await updateBackupDestination(view.id, { name: 'Renamed', secretAccessKey: '', passphrase: '' }, fx.adminId);
    expect(renamed.name).toBe('Renamed');
    expect((await row(view.id)).secretAccessKey).toBe(before.secretAccessKey);
    expect((await row(view.id)).passphrase).toBe(before.passphrase);

    await expect(updateBackupDestination(view.id, { endpoint: 'https://s3.attacker.example' }, fx.adminId)).rejects.toThrow(
      /Enter the secret access key again/
    );
    const moved = await updateBackupDestination(
      view.id,
      { endpoint: 'https://s3.other.example', secretAccessKey: 'new-secret', passphrase: 'a brand new passphrase' },
      fx.adminId
    );
    expect(moved.endpoint).toBe('https://s3.other.example');
    expect(decryptSecret((await row(view.id)).secretAccessKey)).toBe('new-secret');
    expect(decryptSecret((await row(view.id)).passphrase)).toBe('a brand new passphrase');
    const audited = JSON.stringify(vi.mocked(logAuditEvent).mock.calls);
    expect(audited).toContain('"secretAccessKeyChanged":true');
    expect(audited).not.toContain('new-secret');
    expect(audited).not.toContain('a brand new passphrase');
  });

  it('disabling clears the next run; enabling again starts from the schedule without backoff', async () => {
    const view = await destination();
    await ctx.db.update(schema.backupDestinations).set({ consecutiveFailures: 4, nextRunAt: '2030-01-01T00:00:00.000Z' }).where(eq(schema.backupDestinations.id, view.id));
    const off = await updateBackupDestination(view.id, { enabled: false }, fx.adminId);
    expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    const on = await updateBackupDestination(view.id, { enabled: true }, fx.adminId, new Date('2026-10-02T10:00:00Z'));
    expect(on).toMatchObject({ enabled: true, nextRunAt: '2026-10-03T03:00:00.000Z', consecutiveFailures: 0 });
  });

  it('disables without a license even when a stored field no longer validates', async () => {
    const view = await destination();
    await ctx.db.update(schema.backupDestinations).set({ bucket: 'x', schedule: 'garbage' }).where(eq(schema.backupDestinations.id, view.id));
    await removeLicense();
    await expect(updateBackupDestination(view.id, { name: 'Renamed' }, fx.adminId)).rejects.toMatchObject({ status: 403 });
    const off = await updateBackupDestination(view.id, { enabled: false, name: 'Offsite' }, fx.adminId);
    expect(off).toMatchObject({ enabled: false, nextRunAt: null, name: 'Offsite' });
    expect((await row(view.id)).bucket).toBe('x');
  });

  it('deletes the destination with its runs and leaves the bucket alone', async () => {
    const view = await destination();
    await runBackup(view.id, 'manual', deps());
    expect(backupKeys()).toHaveLength(1);
    await deleteBackupDestination(view.id, fx.adminId);
    expect(await ctx.db.select().from(schema.backupDestinations)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.backupRuns)).toHaveLength(0);
    expect(backupKeys()).toHaveLength(1);
  });
});

describe('backup runs', () => {
  it('uploads the passphrase-encrypted export file with its checksum', async () => {
    const view = await destination();
    const run = await runBackup(view.id, 'manual', deps());

    expect(run).toMatchObject({ status: 'success', trigger: 'manual', destinationName: 'Offsite', error: null, warning: null, prunedCount: 0 });
    expect(run.objectKey).toMatch(/^ingressi\/ingressi-config-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);
    const object = fake.objects.get(run.objectKey!)!;
    expect(object.contentType).toBe('application/json');
    const sha = createHash('sha256').update(object.body).digest('hex');
    expect(object.metadata.sha256).toBe(sha);
    expect(run.sha256).toBe(sha);
    expect(run.sizeBytes).toBe(object.body.length);

    const text = object.body.toString('utf8');
    for (const secret of [CERT_KEY, DNS_TOKEN, SECRET, PASSPHRASE]) expect(text).not.toContain(secret);
    const file = JSON.parse(text);
    expect(file).toMatchObject({ format: 'ingressi-configuration', version: 1, cipher: 'aes-256-gcm' });
    const content = await decodeConfigurationExport(text, PASSPHRASE);
    expect(content.tables.proxyHosts[0]).toMatchObject({ name: 'App' });
    expect(decryptSecret(content.tables.certificates[0].privateKeyPem as string)).toBe(CERT_KEY);

    const stored = await row(view.id);
    expect(stored).toMatchObject({ lastStatus: 'success', lastError: null, consecutiveFailures: 0 });
    expect(stored.lastSuccessAt).not.toBeNull();
    expect((await listBackupRuns({ page: 1, perPage: 10 })).runs).toEqual([run]);
  });

  it('deletes backup files beyond the retention and nothing else', async () => {
    const view = await destination({ retention: 3 });
    fake.pageSize = 2;
    for (let day = 1; day <= 4; day++) fake.put(`ingressi/ingressi-config-2026-01-0${day}T00-00-00.000Z.json`, `old ${day}`);
    fake.put('ingressi/notes.txt', 'keep me');
    fake.put('ingressi/sub/ingressi-config-2026-01-01T00-00-00.000Z.json', 'nested, keep');
    fake.put('ingressi-other/ingressi-config-2026-01-01T00-00-00.000Z.json', 'other prefix, keep');
    fake.put('ingressi/ingressi-config-manual-copy.json', 'not our name, keep');

    const run = await runBackup(view.id, 'schedule', deps());
    expect(run.prunedCount).toBe(2);
    expect(backupKeys()).toEqual([
      'ingressi/ingressi-config-2026-01-03T00-00-00.000Z.json',
      'ingressi/ingressi-config-2026-01-04T00-00-00.000Z.json',
      run.objectKey,
    ]);
    for (const kept of ['ingressi/notes.txt', 'ingressi/sub/ingressi-config-2026-01-01T00-00-00.000Z.json', 'ingressi-other/ingressi-config-2026-01-01T00-00-00.000Z.json', 'ingressi/ingressi-config-manual-copy.json']) {
      expect(fake.objects.has(kept), kept).toBe(true);
    }
  });

  it('counts the new file even when the listing does not show it yet', async () => {
    const view = await destination({ retention: 1 });
    const old = ['ingressi/ingressi-config-2026-01-01T00-00-00.000Z.json', 'ingressi/ingressi-config-2026-01-02T00-00-00.000Z.json'];
    for (const key of old) fake.put(key, 'old');
    fake.listed = (key) => old.includes(key);
    const run = await runBackup(view.id, 'schedule', deps());
    expect(run.prunedCount).toBe(2);
    expect(backupKeys()).toEqual([run.objectKey]);
  });

  it('records a failed upload, backs off and recovers', async () => {
    const view = await destination();
    fake.fail = (method) => (method === 'PUT' ? { status: 403, code: 'AccessDenied' } : null);
    const t0 = new Date('2026-10-02T10:00:00Z');

    const first = await runBackup(view.id, 'schedule', { ...deps(), now: () => t0 });
    expect(first.status).toBe('failed');
    expect(first.error).toBe(
      'Upload failed: HTTP 403 (AccessDenied) from the storage: access denied; check that the key may read, write, list and delete objects in the bucket'
    );
    expect(await row(view.id)).toMatchObject({ lastStatus: 'failed', consecutiveFailures: 1, nextRunAt: '2026-10-02T10:05:00.000Z', lastError: first.error });

    const t1 = new Date('2026-10-02T10:05:00Z');
    await runBackup(view.id, 'schedule', { ...deps(), now: () => t1 });
    expect(await row(view.id)).toMatchObject({ consecutiveFailures: 2, nextRunAt: '2026-10-02T10:15:00.000Z' });

    // Retries never wait past the next scheduled run.
    await ctx.db.update(schema.backupDestinations).set({ consecutiveFailures: 10 }).where(eq(schema.backupDestinations.id, view.id));
    await runBackup(view.id, 'schedule', { ...deps(), now: () => new Date('2026-10-02T23:00:00Z') });
    expect(await row(view.id)).toMatchObject({ consecutiveFailures: 11, nextRunAt: '2026-10-03T03:00:00.000Z' });

    const runs = await ctx.db.select().from(schema.backupRuns);
    expect(JSON.stringify(runs)).not.toContain(SECRET);
    expect(JSON.stringify(runs)).not.toContain('detail that must not leak');

    fake.fail = () => null;
    const recovered = await runBackup(view.id, 'schedule', { ...deps(), now: () => new Date('2026-10-03T03:00:30Z') });
    expect(recovered.status).toBe('success');
    expect(await row(view.id)).toMatchObject({ lastStatus: 'success', lastError: null, consecutiveFailures: 0, nextRunAt: '2026-10-04T03:00:00.000Z' });
  });

  it('backs off 5 minutes doubling up to 6 hours', () => {
    expect([0, 1, 2, 3, 4, 7, 8, 30].map((failures) => retryDelayMs(failures) / 60_000)).toEqual([0, 5, 10, 20, 40, 320, 360, 360]);
  });

  it('reports a failed retention step as a warning on a successful run', async () => {
    const view = await destination();
    fake.fail = (_method, _key, url) => (url.searchParams.get('list-type') ? { status: 500 } : null);
    const run = await runBackup(view.id, 'schedule', deps());
    expect(run).toMatchObject({ status: 'success', prunedCount: null });
    expect(run.warning).toBe('The backup was uploaded, but deleting older backups failed: HTTP 500 from the storage');
    expect((await row(view.id)).lastStatus).toBe('success');
  });

  it('records why the export could not be built', async () => {
    const view = await destination();
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    const run = await runBackup(view.id, 'schedule', deps());
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^Could not build the export file: This instance is a sync slave/);
    expect(fake.requests).toHaveLength(0);
  });

  it('reports a stored secret that no longer decrypts without leaking anything', async () => {
    const view = await destination();
    await ctx.db.update(schema.backupDestinations).set({ secretAccessKey: 'enc:v1:AAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA' }).where(eq(schema.backupDestinations.id, view.id));
    const run = await runBackup(view.id, 'schedule', deps());
    expect(run.error).toBe('Backup failed: The stored secret access key cannot be decrypted with SESSION_SECRET; enter it again');
  });

  it('runs one backup per destination at a time', async () => {
    const view = await destination();
    const first = runBackup(view.id, 'schedule', deps());
    expect((await getBackupDestination(view.id)).running).toBe(true);
    await expect(runBackup(view.id, 'manual', deps())).rejects.toMatchObject({ status: 409 });
    expect((await first).status).toBe('success');
    expect((await getBackupDestination(view.id)).running).toBe(false);
  });

  it('keeps the newest runs per destination', async () => {
    const view = await destination();
    for (let i = 0; i < MAX_RUNS_PER_DESTINATION + 5; i++) {
      await ctx.db.insert(schema.backupRuns).values({ destinationId: view.id, trigger: 'schedule', status: 'success', startedAt: '2026-01-01T00:00:00.000Z' });
    }
    await runBackup(view.id, 'schedule', deps());
    const runs = await listBackupRuns({ page: 1, perPage: 5, destinationId: view.id });
    expect(runs.total).toBe(MAX_RUNS_PER_DESTINATION);
    expect(runs.runs[0].status).toBe('success');
    expect(runs.runs[0].objectKey).not.toBeNull();
  });

  it('leaves a destination alone while its backup runs elsewhere (another replica holds its lock)', async () => {
    const replica = testDbIsPostgres() ? createPgReplica() : null;
    // On PostgreSQL another replica's pool; on SQLite the lock held in this process.
    const elsewhere: ClusterLockOptions = replica ? { pool: replica.pool } : {};
    try {
      const now = new Date('2026-10-02T10:00:00Z');
      const view = await destination();
      await ctx.db.update(schema.backupDestinations).set({ nextRunAt: '2026-10-02T09:00:00.000Z' }).where(eq(schema.backupDestinations.id, view.id));
      await ctx.db.insert(schema.backupRuns).values({ destinationId: view.id, trigger: 'manual', status: 'running', startedAt: '2026-10-02T09:59:00.000Z' });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve; });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const holder = withClusterLock(destinationLockName(view.id), async () => { held(); await released; }, elsewhere);
      await holding;

      // Not due here: the run in progress takes care of it, and it is not interrupted.
      expect(await runDueBackups({ ...deps(), now: () => now })).toEqual({ due: 0, succeeded: 0, failed: 0 });
      expect(await markInterruptedRuns()).toBe(0);
      expect((await getBackupDestination(view.id)).running).toBe(true);
      expect((await listBackupDestinations()).find((item) => item.id === view.id)?.running).toBe(true);
      await expect(runBackup(view.id, 'manual', deps())).rejects.toMatchObject({ status: 409 });
      expect(fake.requests).toHaveLength(0);

      // That process stops without finishing the run: its lock is free, the run is marked.
      release();
      await holder;
      expect(await markInterruptedRuns()).toBe(1);
      expect((await getBackupDestination(view.id)).running).toBe(false);
    } finally {
      await replica?.close();
    }
  });

  it('marks runs a stopped process left running as interrupted', async () => {
    const view = await destination();
    await ctx.db.insert(schema.backupRuns).values({ destinationId: view.id, trigger: 'schedule', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(await markInterruptedRuns()).toBe(1);
    const [run] = (await listBackupRuns({ page: 1, perPage: 5 })).runs;
    expect(run).toMatchObject({ status: 'failed', error: 'Interrupted: the server stopped during the backup' });
  });

  it('"Back up now" needs the license and is audited', async () => {
    const view = await destination();
    await removeLicense();
    await expect(runBackupNow(view.id, fx.adminId, deps())).rejects.toMatchObject({ status: 403 });
    expect(fake.requests).toHaveLength(0);
    await installLicense(ctx.db, 'business');
    const run = await runBackupNow(view.id, fx.adminId, deps());
    expect(run.status).toBe('success');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'backup_run_manual', entityId: view.id }));
  });
});

describe('scheduler', () => {
  it('runs due, enabled destinations without a license and leaves the rest', async () => {
    const now = new Date('2026-10-02T10:00:00Z');
    const due = await destination({ name: 'Due', prefix: 'due' });
    const later = await destination({ name: 'Later', prefix: 'later' }, now);
    const off = await destination({ name: 'Off', prefix: 'off', enabled: false });
    const unscheduled = await destination({ name: 'Unscheduled', prefix: 'unscheduled' });
    await ctx.db.update(schema.backupDestinations).set({ nextRunAt: '2026-10-02T09:59:00.000Z' }).where(eq(schema.backupDestinations.id, due.id));
    await ctx.db.update(schema.backupDestinations).set({ nextRunAt: null }).where(eq(schema.backupDestinations.id, unscheduled.id));
    await removeLicense();

    const result = await runDueBackups({ ...deps(), now: () => now });
    expect(result).toEqual({ due: 1, succeeded: 1, failed: 0 });
    expect(backupKeys('due/')).toHaveLength(1);
    expect(backupKeys('later/')).toHaveLength(0);
    expect(backupKeys('off/')).toHaveLength(0);
    expect((await row(due.id)).nextRunAt).toBe('2026-10-03T03:00:00.000Z');
    expect((await row(later.id)).nextRunAt).toBe('2026-10-03T03:00:00.000Z');
    expect((await row(off.id)).nextRunAt).toBeNull();
    expect((await row(unscheduled.id)).nextRunAt).toBe('2026-10-03T03:00:00.000Z');
    expect((await listBackupRuns({ page: 1, perPage: 10 })).runs.map((run) => run.trigger)).toEqual(['schedule']);
  });

  it('carries on with other destinations when one fails', async () => {
    const now = new Date('2026-10-02T10:00:00Z');
    const broken = await destination({ name: 'Broken', prefix: 'broken' });
    const fine = await destination({ name: 'Fine', prefix: 'fine' });
    await ctx.db.update(schema.backupDestinations).set({ nextRunAt: '2026-10-02T09:00:00.000Z' });
    fake.fail = (_method, key) => (key?.startsWith('broken/') ? { status: 503, code: 'SlowDown' } : null);
    expect(await runDueBackups({ ...deps(), now: () => now })).toEqual({ due: 2, succeeded: 1, failed: 1 });
    expect(await row(broken.id)).toMatchObject({ lastStatus: 'failed', consecutiveFailures: 1 });
    expect(await row(fine.id)).toMatchObject({ lastStatus: 'success' });
  });
});

describe('connection test', () => {
  it('writes, reads back and deletes a test object', async () => {
    const view = await destination();
    const result = await testBackupDestination(view.id, fx.adminId, deps());
    expect(result).toMatchObject({ ok: true, error: null, failedStep: null });
    expect(fake.requests.map((request) => request.method)).toEqual(['PUT', 'GET', 'DELETE']);
    expect(fake.requests[0].url.pathname).toMatch(/^\/ingressi\/ingressi-connection-test-[0-9a-f]{16}\.txt$/);
    expect(fake.keys()).toEqual([]);
  });

  it('names the failing step and cleans up', async () => {
    const view = await destination();
    fake.fail = (method) => (method === 'GET' ? { status: 403, code: 'AccessDenied' } : null);
    const result = await testBackupDestination(view.id, fx.adminId, deps());
    expect(result).toMatchObject({ ok: false, failedStep: 'read' });
    expect(result.error).toMatch(/^HTTP 403 \(AccessDenied\)/);
    expect(fake.keys()).toEqual([]);
  });

  it('needs the license', async () => {
    const view = await destination();
    await removeLicense();
    await expect(testBackupDestination(view.id, fx.adminId, deps())).rejects.toMatchObject({ status: 403 });
  });
});

describe('restore', () => {
  async function backedUp(overrides: Record<string, unknown> = {}) {
    const view = await destination(overrides);
    const run = await runBackup(view.id, 'manual', deps());
    return { view, key: run.objectKey! };
  }

  it('lists stored backups newest first, without a license', async () => {
    const { view, key } = await backedUp();
    fake.put('ingressi/ingressi-config-2026-01-01T00-00-00.000Z.json', 'older');
    fake.put('ingressi/readme.txt', 'not a backup');
    await removeLicense();
    const listing = await listBackupObjects(view.id, deps());
    expect(listing.complete).toBe(true);
    expect(listing.objects.map((object) => object.key)).toEqual([key, 'ingressi/ingressi-config-2026-01-01T00-00-00.000Z.json']);
    expect(listing.objects[1]).toMatchObject({ sizeBytes: 5 });
  });

  it('imports a stored backup and keeps the replaced configuration in history', async () => {
    const { view, key } = await backedUp();
    await setSettingRow(ctx.db, HISTORY_SETTING_KEY, { enabled: true, retention: 200 });
    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed after the backup' });

    const result = await restoreBackup(view.id, { key }, fx.adminId, deps());
    expect(result.key).toBe(key);
    expect(result.counts).toMatchObject({ proxyHosts: 1, certificates: 1 });
    expect(result.beforeSnapshotId).toEqual(expect.any(Number));
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).limit(1)))!.name).toBe('App');
    const snapshot = (await dbFirst(ctx.db.select().from(schema.configSnapshots).where(eq(schema.configSnapshots.id, result.beforeSnapshotId!)).limit(1)))!;
    expect(snapshot.reason).toBe('import');
    expect(snapshot.content).toContain('Changed after the backup');
    expect(applyCaddyConfig).toHaveBeenCalled();
    const actions = vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['config_imported', 'config_backup_restored']));
  });

  it('uses a given passphrase, so older backups stay restorable after the passphrase changed', async () => {
    const { view, key } = await backedUp();
    await updateBackupDestination(view.id, { passphrase: 'the new passphrase 2027' }, fx.adminId);
    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed' });

    await expect(restoreBackup(view.id, { key }, fx.adminId, deps())).rejects.toThrow(/Wrong passphrase/);
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).limit(1)))!.name).toBe('Changed');
    await restoreBackup(view.id, { key, passphrase: PASSPHRASE }, fx.adminId, deps());
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).limit(1)))!.name).toBe('App');
  });

  it.each([
    [{ key: 'ingressi/readme.txt' }],
    [{ key: 'other/ingressi-config-2026-01-01T00-00-00.000Z.json' }],
    [{ key: 'ingressi/sub/ingressi-config-2026-01-01T00-00-00.000Z.json' }],
    [{}],
    [{ key: 'ingressi/ingressi-config-2026-01-01T00-00-00.000Z.json', extra: 1 }],
  ])('refuses %j', async (body) => {
    const view = await destination();
    await expect(restoreBackup(view.id, body, fx.adminId, deps())).rejects.toBeInstanceOf(ApiValidationError);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a file that does not match its stored checksum', async () => {
    const { view, key } = await backedUp();
    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed' });
    fake.tamper = (body) => Buffer.from(body.toString('utf8').replace('"App"', '"Evil"'));
    const error = await restoreBackup(view.id, { key }, fx.adminId, deps()).catch((e) => e);
    expect(error).toBeInstanceOf(S3Error);
    expect(error.message).toMatch(/does not match the SHA-256 checksum/);
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).limit(1)))!.name).toBe('Changed');
  });

  it('needs the license and is refused on a sync slave', async () => {
    const { view, key } = await backedUp();
    await removeLicense();
    await expect(restoreBackup(view.id, { key }, fx.adminId, deps())).rejects.toMatchObject({ status: 403 });
    await installLicense(ctx.db, 'business');
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    await expect(restoreBackup(view.id, { key }, fx.adminId, deps())).rejects.toMatchObject({ status: 409 });
  });
});

describe('backup_failed alerts', () => {
  it('fires for enabled destinations that failed often enough', async () => {
    const failing = await destination({ name: 'Failing' });
    const ok = await destination({ name: 'OK' });
    const off = await destination({ name: 'Off' });
    const stamp = '2026-10-02T10:00:00.000Z';
    await ctx.db.update(schema.backupDestinations).set({ lastStatus: 'failed', lastRunAt: stamp, lastError: 'Upload failed: HTTP 403 (AccessDenied) from the storage', consecutiveFailures: 3 }).where(eq(schema.backupDestinations.id, failing.id));
    await ctx.db.update(schema.backupDestinations).set({ lastStatus: 'success', lastRunAt: stamp, consecutiveFailures: 0 }).where(eq(schema.backupDestinations.id, ok.id));
    await ctx.db.update(schema.backupDestinations).set({ enabled: false, lastStatus: 'failed', consecutiveFailures: 5 }).where(eq(schema.backupDestinations.id, off.id));

    const result = await evaluateBackupFailed({ minFailures: 1 });
    expect(result.status === 'ok' && result.findings).toEqual([
      expect.objectContaining({
        subjectKey: `backup_destination:${failing.id}`,
        severity: 'critical',
        title: 'Backup to "Failing" failed 3 times in a row',
        facts: expect.objectContaining({ consecutiveFailures: 3, error: 'Upload failed: HTTP 403 (AccessDenied) from the storage' }),
      }),
    ]);
    expect(await evaluateBackupFailed({ minFailures: 4 })).toEqual({ status: 'ok', findings: [] });
  });

  it('is a paid rule type', async () => {
    await removeLicense();
    await expect(createAlertRule({ name: 'Backups', type: 'backup_failed' }, fx.adminId)).rejects.toMatchObject({ status: 403 });
    await installLicense(ctx.db, 'business');
    const rule = await createAlertRule({ name: 'Backups', type: 'backup_failed', params: { minFailures: 2 } }, fx.adminId);
    expect(rule.params).toEqual({ minFailures: 2 });
    await expect(createAlertRule({ name: 'Bad', type: 'backup_failed', params: { minFailures: 0 } }, fx.adminId)).rejects.toThrow(/minFailures/);
  });
});
