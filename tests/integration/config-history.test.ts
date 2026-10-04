/**
 * Configuration history (ee/config-history) on a real in-memory database:
 * snapshot content, automatic recording, retention, restore round trips, the
 * pre-restore safety snapshot, rollback when Caddy rejects, slave refusal and
 * the license gate on every write path.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import {
  CA_KEY, CERT_KEY, DNS_TOKEN, ENTRY_HASH, OUTSIDE, installLicense, licenseSigner, now, seedConfiguration, setSettingRow,
  type Fixture,
} from '../helpers/config-fixture';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { applyCaddyConfig } from '../../src/lib/caddy';
import { logAuditEvent } from '../../src/lib/audit';
import { CaddyApplyError } from '../../src/lib/caddy-apply-error';
import { ApiConflictError } from '../../src/lib/api-errors';
import { decryptSecret, isEncryptedSecret } from '../../src/lib/secret';
import {
  CONFIG_SETTING_KEYS, CONFIG_TABLE_NAMES, readCurrentConfigContent, type ConfigContent,
} from '../../src/lib/config-content';
import { ConfigurationApplyError, ConfigurationWriteError } from '../../src/lib/config-replace';
import { setTrustedLicenseKeysForTests } from '../../ee/licensing/public-keys';
import { LicenseRequiredError } from '../../ee/licensing/store';
import {
  getSnapshotContent, listSnapshots, recordConfigSnapshotAfterApply,
} from '../../ee/config-history/snapshots';
import {
  createManualSnapshot, deleteAllSnapshots, deleteSnapshot, getSnapshotDetail, getSnapshotDiff, restoreSnapshot,
  updateHistorySettings,
} from '../../ee/config-history/service';
import { configFingerprint } from '../../ee/config-history/fingerprint';
import { HISTORY_SETTING_KEY } from '../../ee/config-history/settings';
import { first as dbFirst } from '@/src/lib/db/ops';

let fx: Fixture;

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  setTrustedLicenseKeysForTests(licenseSigner.keys);
  fx = await seedConfiguration(ctx.db);
});

afterAll(() => setTrustedLicenseKeysForTests(null));

async function enableHistory(retention = 200): Promise<void> {
  await setSettingRow(ctx.db, HISTORY_SETTING_KEY, { enabled: true, retention });
}

async function storedContent(id: number): Promise<string> {
  return (await dbFirst(ctx.db.select({ content: schema.configSnapshots.content }).from(schema.configSnapshots)
    .where(eq(schema.configSnapshots.id, id)).limit(1)))!.content;
}

async function snapshotCount(): Promise<number> {
  return (await dbFirst(ctx.db.select({ n: sql<number>`count(*)` }).from(schema.configSnapshots).limit(1)))!.n;
}

/** Changes every kind of configuration item, and nothing outside the configuration. */
async function changeConfiguration(): Promise<void> {
  const t = now();
  await ctx.db.update(schema.proxyHosts).set({
    name: 'App v2', upstreams: '["backend:9090"]',
    meta: JSON.stringify({ waf: { enabled: false, mode: 'On' }, custom_headers: { 'X-Env': 'prod' } }), updatedAt: t,
  }).where(eq(schema.proxyHosts.id, fx.hostId));
  await ctx.db.insert(schema.proxyHosts).values({
    name: 'Added later', domains: '["new.example.com"]', upstreams: '["new:80"]', createdAt: t, updatedAt: t,
  });
  await ctx.db.delete(schema.l4ProxyHosts).where(eq(schema.l4ProxyHosts.id, fx.l4Id));
  await ctx.db.update(schema.groups).set({ name: 'Engineers', updatedAt: t }).where(eq(schema.groups.id, fx.groupId));
  await ctx.db.update(schema.accessListEntries).set({ passwordHash: '$2b$12$another-hash', updatedAt: t })
    .where(eq(schema.accessListEntries.id, fx.entryId));
  await setSettingRow(ctx.db, 'waf', { enabled: false, mode: 'Off', load_owasp_crs: false, custom_directives: '' });
  await setSettingRow(ctx.db, 'geoblock', { enabled: true, block_countries: ['XX'] });
}

describe('snapshot content', () => {
  it('holds every configuration table and settings group, with secrets as stored', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    const raw = await storedContent(snapshot.id);
    const parsed = JSON.parse(raw) as ConfigContent;

    expect(Object.keys(parsed.tables).sort()).toEqual([...CONFIG_TABLE_NAMES].sort());
    expect(Object.keys(parsed.settings).sort()).toEqual([...CONFIG_SETTING_KEYS].sort());
    expect(parsed.tables.proxyHosts.map((row) => row.name)).toEqual(['App']);
    expect(parsed.tables.forwardAuthAccess).toHaveLength(2);

    // Secret columns are kept exactly as stored: encrypted with the local key.
    const certRow = (await dbFirst(ctx.db.select().from(schema.certificates).limit(1)))!;
    expect(parsed.tables.certificates[0].privateKeyPem).toBe(certRow.privateKeyPem);
    expect(isEncryptedSecret(parsed.tables.caCertificates[0].privateKeyPem as string)).toBe(true);
    const dns = parsed.settings.dns_provider as { providers: { cloudflare: { api_token: string } } };
    expect(isEncryptedSecret(dns.providers.cloudflare.api_token)).toBe(true);
    expect(decryptSecret(dns.providers.cloudflare.api_token)).toBe(DNS_TOKEN);
    for (const plaintext of [CERT_KEY, CA_KEY, DNS_TOKEN, 'CERT-PLAINTEXT', 'CA-PLAINTEXT']) {
      expect(raw).not.toContain(plaintext);
    }
    expect(snapshot.sizeBytes).toBe(Buffer.byteLength(raw));
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('excludes users, memberships, sessions, tokens, OAuth, instances, audit, license and other settings', async () => {
    await installLicense(ctx.db);
    const raw = await storedContent((await createManualSnapshot(fx.adminId)).id);
    for (const value of Object.values(OUTSIDE)) {
      expect(raw).not.toContain(value);
    }
    const parsed = JSON.parse(raw);
    for (const excluded of ['users', 'groupMembers', 'sessions', 'accounts', 'apiTokens', 'oauthProviders', 'instances',
      'auditEvents', 'forwardAuthSessions', 'configSnapshots']) {
      expect(parsed.tables).not.toHaveProperty(excluded);
    }
    for (const key of ['license', 'instance_mode', HISTORY_SETTING_KEY, 'instance_master_token']) {
      expect(parsed.settings).not.toHaveProperty(key);
    }
  });
});

describe('automatic recording', () => {
  it('records nothing while history is disabled', async () => {
    await recordConfigSnapshotAfterApply();
    expect(await snapshotCount()).toBe(0);
  });

  it('records a changed configuration once, with a summary of the change', async () => {
    await enableHistory();
    await recordConfigSnapshotAfterApply();
    await recordConfigSnapshotAfterApply();
    expect(await snapshotCount()).toBe(1);
    const [first] = (await listSnapshots()).snapshots;
    expect(first).toMatchObject({ reason: 'auto', userId: null });
    expect(first.summary).toMatch(/^Initial snapshot: 1 certificate, 1 CA certificate/);

    await ctx.db.update(schema.proxyHosts).set({ name: 'Renamed', updatedAt: now() }).where(eq(schema.proxyHosts.id, fx.hostId));
    await recordConfigSnapshotAfterApply();
    const { snapshots, total } = await listSnapshots();
    expect(total).toBe(2);
    expect(snapshots[0].summary).toBe('Proxy hosts: changed “Renamed”');
  });

  it('ignores changes that only touch timestamps', async () => {
    await enableHistory();
    await recordConfigSnapshotAfterApply();
    await ctx.db.update(schema.proxyHosts).set({ updatedAt: '2030-01-01T00:00:00.000Z' });
    await recordConfigSnapshotAfterApply();
    expect(await snapshotCount()).toBe(1);
  });

  it('keeps recording without a license once enabled (recording is not gated)', async () => {
    await enableHistory();
    // An expired key past its grace period.
    await installLicense(ctx.db, 'homelab', { iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z' });
    await recordConfigSnapshotAfterApply();
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    await ctx.db.update(schema.proxyHosts).set({ name: 'Still recorded' });
    await recordConfigSnapshotAfterApply();
    expect(await snapshotCount()).toBe(2);
  });

  it('records nothing on a sync slave', async () => {
    await enableHistory();
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    await recordConfigSnapshotAfterApply();
    expect(await snapshotCount()).toBe(0);
  });

  it('never throws, even when the database fails', async () => {
    await enableHistory();
    const real = ctx.db;
    ctx.db = { transaction: () => { throw new Error('disk I/O error'); }, query: real.query } as unknown as TestDb;
    try {
      await expect(recordConfigSnapshotAfterApply()).resolves.toBeUndefined();
    } finally {
      ctx.db = real;
    }
  });

  it('keeps only the newest snapshots', async () => {
    await enableHistory(3);
    for (let index = 0; index < 5; index++) {
      await ctx.db.update(schema.proxyHosts).set({ name: `Name ${index}` });
      await recordConfigSnapshotAfterApply();
    }
    const { snapshots, total } = await listSnapshots();
    expect(total).toBe(3);
    expect(snapshots.map((s) => s.summary)).toEqual([
      'Proxy hosts: changed “Name 4”', 'Proxy hosts: changed “Name 3”', 'Proxy hosts: changed “Name 2”',
    ]);
  });
});

describe('history settings', () => {
  it('records a first snapshot when recording is turned on, and prunes when retention shrinks', async () => {
    await installLicense(ctx.db);
    await updateHistorySettings({ enabled: true }, fx.adminId);
    expect(await snapshotCount()).toBe(1);
    for (let index = 0; index < 3; index++) await createManualSnapshot(fx.adminId);
    expect(await snapshotCount()).toBe(4);
    const settings = await updateHistorySettings({ retention: 2 }, fx.adminId);
    expect(settings).toEqual({ enabled: true, retention: 2 });
    expect(await snapshotCount()).toBe(2);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'config_history_settings_updated' }));
  });

  it.each([
    [{}], [{ enabled: 'yes' }], [{ retention: 0 }], [{ retention: 10_001 }], [{ retention: 2.5 }], [{ other: true }], [null],
  ])('rejects %j', async (body) => {
    await installLicense(ctx.db);
    await expect(updateHistorySettings(body, fx.adminId)).rejects.toMatchObject({ status: 400 });
  });
});

describe('restore', () => {
  it('round-trips: snapshot, change, restore gives the snapshot content back', async () => {
    await installLicense(ctx.db);
    const original = await readCurrentConfigContent();
    const snapshot = await createManualSnapshot(fx.adminId);
    await changeConfiguration();
    expect(configFingerprint(await readCurrentConfigContent())).not.toBe(configFingerprint(original));

    const result = await restoreSnapshot(snapshot.id, fx.adminId);

    expect(result).toMatchObject({ restoredSnapshotId: snapshot.id, warning: null });
    expect(await readCurrentConfigContent()).toEqual(original);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'config_restored', entityId: snapshot.id, userId: fx.adminId,
    }));
  });

  it('leaves users, memberships, sessions, tokens and other settings alone', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    await changeConfiguration();
    const outside = async () => ({
      users: await ctx.db.select().from(schema.users),
      members: await ctx.db.select().from(schema.groupMembers),
      sessions: await ctx.db.select().from(schema.sessions),
      tokens: await ctx.db.select().from(schema.apiTokens),
      oauth: await ctx.db.select().from(schema.oauthProviders),
      instances: await ctx.db.select().from(schema.instances),
      faSessions: await ctx.db.select().from(schema.forwardAuthSessions),
      other: (await ctx.db.select().from(schema.settings))
        .filter((row) => !(CONFIG_SETTING_KEYS as readonly string[]).includes(row.key) && row.key !== HISTORY_SETTING_KEY),
    });
    const before = await outside();
    await restoreSnapshot(snapshot.id, fx.adminId);
    expect(await outside()).toEqual(before);
    // The renamed group keeps its members across the restore.
    expect(before.members).toHaveLength(1);
  });

  it('saves the configuration it replaces first, which restores back', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    await changeConfiguration();
    const changed = await readCurrentConfigContent();

    const { beforeSnapshotId } = await restoreSnapshot(snapshot.id, fx.adminId);

    const [newest] = (await listSnapshots()).snapshots;
    expect(newest).toMatchObject({ id: beforeSnapshotId, reason: 'before_restore', userId: fx.adminId, userName: 'Admin' });
    expect(await getSnapshotContent(beforeSnapshotId)).toEqual(changed);

    await restoreSnapshot(beforeSnapshotId, fx.adminId);
    expect(await readCurrentConfigContent()).toEqual(changed);
  });

  it('puts the previous configuration back when Caddy rejects the restored one', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    await changeConfiguration();
    const changed = await readCurrentConfigContent();
    const members = await ctx.db.select().from(schema.groupMembers);
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Caddy rejected configuration', 'CADDY_REJECTED'));

    const error = await restoreSnapshot(snapshot.id, fx.adminId).catch((e) => e);

    expect(error).toBeInstanceOf(ConfigurationApplyError);
    expect(error.message).toBe('Caddy did not accept the configuration: Caddy rejected configuration. Nothing was changed.');
    expect(await readCurrentConfigContent()).toEqual(changed);
    expect(await ctx.db.select().from(schema.groupMembers)).toEqual(members);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(2); // the restore, then the previous configuration again
    expect((await listSnapshots()).snapshots[0].reason).toBe('before_restore');
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'config_restore_failed' }));
  });

  it('keeps the restore when only the slave sync failed', async () => {
    await installLicense(ctx.db);
    const original = await readCurrentConfigContent();
    const snapshot = await createManualSnapshot(fx.adminId);
    await changeConfiguration();
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(
      new CaddyApplyError('Caddy configuration applied but instance synchronization failed', 'INSTANCE_SYNC_FAILED')
    );
    const result = await restoreSnapshot(snapshot.id, fx.adminId);
    expect(result.warning).toMatch(/synchronizing it to the slave instances failed/);
    expect(await readCurrentConfigContent()).toEqual(original);
  });

  it('changes nothing, not even the safety snapshot, when the snapshot conflicts with itself', async () => {
    await installLicense(ctx.db);
    const content = await readCurrentConfigContent();
    const t = now();
    content.tables.groups.push({ ...content.tables.groups[0], id: 99, createdAt: t, updatedAt: t });
    const bad = (await dbFirst(ctx.db.insert(schema.configSnapshots).values({
      createdAt: t, reason: 'manual', summary: 'duplicate group names', fingerprint: 'x',
      content: JSON.stringify(content), sizeBytes: 1,
    }).returning()))!;
    const before = await readCurrentConfigContent();

    const error = await restoreSnapshot(bad.id, fx.adminId).catch((e) => e);

    expect(error).toBeInstanceOf(ConfigurationWriteError);
    expect(error.status).toBe(409);
    expect(await readCurrentConfigContent()).toEqual(before);
    expect(await snapshotCount()).toBe(1);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('refuses a snapshot that does not fit the schema with 409', async () => {
    await installLicense(ctx.db);
    const bad = (await dbFirst(ctx.db.insert(schema.configSnapshots).values({
      createdAt: now(), reason: 'manual', summary: 'bad', fingerprint: 'x',
      content: JSON.stringify({ version: 1, tables: { proxyHosts: [{ id: 1, bogus: true }] }, settings: {} }), sizeBytes: 1,
    }).returning()))!;
    await expect(restoreSnapshot(bad.id, fx.adminId)).rejects.toMatchObject({ status: 409 });
    expect(await snapshotCount()).toBe(1);
  });

  it('drops grants for users deleted since the snapshot and clears their attribution', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    await ctx.db.delete(schema.forwardAuthAccess).where(eq(schema.forwardAuthAccess.userId, fx.memberId));
    await ctx.db.delete(schema.groupMembers).where(eq(schema.groupMembers.userId, fx.memberId));
    await ctx.db.delete(schema.forwardAuthSessions);
    await ctx.db.delete(schema.users).where(eq(schema.users.id, fx.memberId));
    // The admin owns the hosts in the snapshot; take that away too.
    await disableForeignKeys(ctx.db);
    await ctx.db.delete(schema.sessions);
    await ctx.db.delete(schema.apiTokens);
    await ctx.db.delete(schema.users).where(eq(schema.users.id, fx.adminId));

    await restoreSnapshot(snapshot.id, fx.adminId);

    const grants = await ctx.db.select().from(schema.forwardAuthAccess);
    expect(grants.map((g) => [g.userId, g.groupId])).toEqual([[null, fx.groupId]]);
    expect((await dbFirst(ctx.db.select().from(schema.proxyHosts).limit(1)))!.ownerUserId).toBeNull();
    expect((await dbFirst(ctx.db.select().from(schema.certificates).limit(1)))!.createdBy).toBeNull();
  });

  it('works with foreign keys off, as in production', async () => {
    await disableForeignKeys(ctx.db);
    await installLicense(ctx.db);
    const original = await readCurrentConfigContent();
    const snapshot = await createManualSnapshot(fx.adminId);
    await changeConfiguration();
    await restoreSnapshot(snapshot.id, fx.adminId);
    expect(await readCurrentConfigContent()).toEqual(original);
    expect(await ctx.db.select().from(schema.groupMembers)).toHaveLength(1);
    expect(await ctx.db.select().from(schema.forwardAuthSessions)).toHaveLength(1);
  });

  it('returns 404 for an unknown snapshot', async () => {
    await installLicense(ctx.db);
    await expect(restoreSnapshot(12345, fx.adminId)).rejects.toThrow('Snapshot not found');
  });
});

describe('sync slaves', () => {
  it('refuse restores and manual snapshots with 409', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    const before = await readCurrentConfigContent();

    for (const attempt of [restoreSnapshot(snapshot.id, fx.adminId), createManualSnapshot(fx.adminId)]) {
      const error = await attempt.catch((e) => e);
      expect(error).toBeInstanceOf(ApiConflictError);
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/sync slave/);
    }
    expect(await readCurrentConfigContent()).toEqual(before);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('refuse when the mode comes from INSTANCE_MODE', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    vi.stubEnv('INSTANCE_MODE', 'slave');
    try {
      await expect(restoreSnapshot(snapshot.id, fx.adminId)).rejects.toMatchObject({ status: 409 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('license gate', () => {
  async function expectLicenseRequired(promise: Promise<unknown>) {
    const error = (await promise.catch((e) => e)) as LicenseRequiredError;
    expect(error).toBeInstanceOf(LicenseRequiredError);
    expect(error.status).toBe(403);
  }

  it('guards every write path without a license', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));
    await changeConfiguration();
    const before = await readCurrentConfigContent();

    await expectLicenseRequired(createManualSnapshot(fx.adminId));
    await expectLicenseRequired(updateHistorySettings({ enabled: true }, fx.adminId));
    await expectLicenseRequired(restoreSnapshot(snapshot.id, fx.adminId));

    expect(await readCurrentConfigContent()).toEqual(before);
    expect(await snapshotCount()).toBe(1);
    expect(await dbFirst(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, HISTORY_SETTING_KEY)).limit(1))).toBeUndefined();
  });

  it('needs the license to change settings while recording stays on', async () => {
    await enableHistory(200);
    await expectLicenseRequired(updateHistorySettings({ retention: 50 }, fx.adminId));
    await expectLicenseRequired(updateHistorySettings({ enabled: true }, fx.adminId));
    expect((await dbFirst(ctx.db.select().from(schema.settings).where(eq(schema.settings.key, HISTORY_SETTING_KEY)).limit(1)))!.value)
      .toBe(JSON.stringify({ enabled: true, retention: 200 }));
  });

  it('lets a lapsed install wind history down: turn recording off and delete snapshots', async () => {
    await installLicense(ctx.db);
    await updateHistorySettings({ enabled: true }, fx.adminId);
    for (let index = 0; index < 3; index++) await createManualSnapshot(fx.adminId);
    // Expired past the grace period.
    await installLicense(ctx.db, 'homelab', { iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z' });

    expect(await updateHistorySettings({ enabled: false, retention: 2 }, fx.adminId)).toEqual({ enabled: false, retention: 2 });
    expect(await snapshotCount()).toBe(2);
    await recordConfigSnapshotAfterApply();
    expect(await snapshotCount()).toBe(2);

    const [newest] = (await listSnapshots()).snapshots;
    await deleteSnapshot(newest.id, fx.adminId);
    expect(await snapshotCount()).toBe(1);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'config_snapshot_deleted', entityId: newest.id }));
    await expect(deleteSnapshot(newest.id, fx.adminId)).rejects.toThrow('Snapshot not found');

    expect(await deleteAllSnapshots(fx.adminId)).toBe(1);
    expect(await snapshotCount()).toBe(0);
    // Turning it back on needs a license again.
    await expectLicenseRequired(updateHistorySettings({ enabled: true }, fx.adminId));
  });

  it('refuses an edition without the feature and a key past its grace period', async () => {
    await installLicense(ctx.db, 'homelab', { iat: '2020-01-01T00:00:00.000Z', exp: '2021-01-01T00:00:00.000Z' });
    await expectLicenseRequired(createManualSnapshot(fx.adminId));
  });

  it('keeps history readable without a license', async () => {
    await installLicense(ctx.db);
    const snapshot = await createManualSnapshot(fx.adminId);
    await ctx.db.delete(schema.settings).where(eq(schema.settings.key, 'license'));

    expect((await listSnapshots()).total).toBe(1);
    expect((await getSnapshotDetail(snapshot.id)).content.counts.proxyHosts).toBe(1);
    expect((await getSnapshotDiff(snapshot.id, 'current')).diff.entities).toEqual([]);
  });
});

describe('snapshot detail and diff', () => {
  it('summarizes content by name without values', async () => {
    await installLicense(ctx.db);
    const detail = await getSnapshotDetail((await createManualSnapshot(fx.adminId, { summary: 'Before upgrade' })).id);
    expect(detail.summary).toBe('Before upgrade');
    expect(detail.content.items.proxyHosts).toEqual([{ id: fx.hostId, label: 'App' }]);
    expect(detail.content.settings).toEqual(['general', 'dns_provider', 'waf']);
    expect(JSON.stringify(detail)).not.toContain(ENTRY_HASH);
  });

  it('compares with the current configuration, the previous snapshot or another snapshot', async () => {
    await installLicense(ctx.db);
    const first = await createManualSnapshot(fx.adminId);
    await changeConfiguration();
    const second = await createManualSnapshot(fx.adminId);

    const restorePreview = await getSnapshotDiff(first.id, 'current');
    expect(restorePreview.against).toEqual({ kind: 'current' });
    const hosts = restorePreview.diff.entities.find((e) => e.entity === 'proxyHosts')!;
    expect(hosts.removed.map((i) => i.label)).toEqual(['Added later']);
    expect(hosts.changed[0].changes).toEqual([
      { path: 'meta.waf.enabled', before: false, after: true },
      { path: 'name', before: 'App v2', after: 'App' },
      { path: 'upstreams', before: ['backend:9090'], after: ['backend:8080'] },
    ]);
    const entries = restorePreview.diff.entities.find((e) => e.entity === 'accessListEntries')!;
    expect(entries.changed[0].changes).toEqual([{ path: 'passwordHash', secret: true }]);
    expect(JSON.stringify(restorePreview)).not.toContain('another-hash');

    const previous = await getSnapshotDiff(second.id, 'previous');
    expect(previous.against).toEqual({ kind: 'snapshot', id: first.id });
    expect(previous.diff.entities.find((e) => e.entity === 'l4ProxyHosts')!.removed).toEqual([{ id: fx.l4Id, label: 'Postgres' }]);

    expect((await getSnapshotDiff(first.id, 'previous')).against).toEqual({ kind: 'empty' });
    expect((await getSnapshotDiff(first.id, String(second.id))).diff.totals).toEqual(
      (await getSnapshotDiff(first.id, 'current')).diff.totals
    );
    await expect(getSnapshotDiff(first.id, 'yesterday')).rejects.toMatchObject({ status: 400 });
    await expect(getSnapshotDiff(first.id, '999')).rejects.toThrow('not found');
  });
});
