/**
 * Configuration export/import (Community): passphrase-encrypted secrets,
 * strict validation, round trips (also to another installation), wrong
 * passphrases, the before-import snapshot and slave refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, disableForeignKeys, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { encryptUnderOtherSecret } from '../helpers/encrypt-under-other-secret';
import {
  CA_KEY, CERT_KEY, DNS_TOKEN, ENTRY_HASH, OUTSIDE, now, seedConfiguration, setSettingRow, type Fixture,
} from '../helpers/config-fixture';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import { applyCaddyConfig } from '../../src/lib/caddy';
import { logAuditEvent } from '../../src/lib/audit';
import { ApiValidationError } from '../../src/lib/api-errors';
import { decryptSecret, isEncryptedSecret } from '../../src/lib/secret';
import { readCurrentConfigContent, type ConfigContent } from '../../src/lib/config-content';
import {
  decodeConfigurationExport, exportConfiguration, importConfiguration, type ConfigExportFile,
} from '../../src/lib/config-transfer';
import { beforeImportSnapshotHook, listSnapshots } from '../../ee/config-history/snapshots';
import { HISTORY_SETTING_KEY } from '../../ee/config-history/settings';
import { first } from '@/src/lib/db/ops';

const PASSPHRASE = 'correct horse battery staple';

let fx: Fixture;

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(applyCaddyConfig).mockResolvedValue(undefined as never);
  fx = await seedConfiguration(ctx.db);
});

async function exportFile(): Promise<ConfigExportFile> {
  return (await exportConfiguration(PASSPHRASE, fx.adminId)).file;
}

/** A configuration with attribution cleared, as an export carries it. */
function withoutAttribution(content: ConfigContent): ConfigContent {
  const copy = structuredClone(content);
  for (const rows of Object.values(copy.tables)) {
    for (const row of rows) {
      for (const column of ['createdBy', 'ownerUserId']) if (column in row) row[column] = null;
    }
  }
  return copy;
}

/** The content with every encrypted value replaced by its plaintext, for comparison. */
function decrypted(content: ConfigContent): unknown {
  return JSON.parse(JSON.stringify(content), (_key, value) =>
    typeof value === 'string' && isEncryptedSecret(value) ? `plain:${decryptSecret(value)}` : value
  );
}

describe('export', () => {
  it('encrypts every secret with the passphrase and nothing else', async () => {
    const { filename, file } = await exportConfiguration(PASSPHRASE, fx.adminId);
    const text = JSON.stringify(file);

    expect(filename).toMatch(/^ingressi-configuration-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/);
    expect(file).toMatchObject({ format: 'ingressi-configuration', version: 1, cipher: 'aes-256-gcm' });
    expect(file.kdf).toMatchObject({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
    for (const secret of [CERT_KEY, CA_KEY, DNS_TOKEN, ENTRY_HASH, 'CERT-PLAINTEXT', 'CA-PLAINTEXT']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('enc:v1:');
    expect(file.content.tables.certificates[0].privateKeyPem).toMatch(/^pp:v1:/);
    expect(file.content.tables.caCertificates[0].privateKeyPem).toMatch(/^pp:v1:/);
    expect(file.content.tables.accessListEntries[0].passwordHash).toMatch(/^pp:v1:/);
    const dns = file.content.settings.dns_provider as { providers: { cloudflare: { api_token: string } } };
    expect(dns.providers.cloudflare.api_token).toMatch(/^pp:v1:/);
    // Everything else stays readable.
    expect(file.content.tables.proxyHosts[0]).toMatchObject({ name: 'App', domains: '["app.example.com"]' });
    expect(file.content.settings.general).toEqual({ primaryDomain: 'example.com', acmeEmail: 'acme@example.com' });
  });

  it('leaves out everything outside the configuration and user attribution', async () => {
    const file = await exportFile();
    const text = JSON.stringify(file);
    for (const value of Object.values(OUTSIDE)) {
      if (value === OUTSIDE.memberEmail) continue; // named by a forward-auth grant, see below
      expect(text).not.toContain(value);
    }
    expect(file.users).toEqual({ [String(fx.memberId)]: OUTSIDE.memberEmail });
    expect(file.content.tables.proxyHosts[0].ownerUserId).toBeNull();
    expect(file.content.tables.certificates[0].createdBy).toBeNull();
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'config_exported', userId: fx.adminId }));
  });

  it('needs a passphrase of at least 12 characters', async () => {
    for (const passphrase of [undefined, '', 'short pass', 42]) {
      await expect(exportConfiguration(passphrase, fx.adminId)).rejects.toBeInstanceOf(ApiValidationError);
    }
  });

  it('refuses when a stored secret cannot be decrypted', async () => {
    await ctx.db.update(schema.certificates).set({ privateKeyPem: encryptUnderOtherSecret('lost') });
    await expect(exportConfiguration(PASSPHRASE, fx.adminId)).rejects.toMatchObject({ status: 409 });
  });

  it('is refused on a sync slave', async () => {
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    await expect(exportConfiguration(PASSPHRASE, fx.adminId)).rejects.toMatchObject({ status: 409 });
  });
});

describe('import', () => {
  it('round-trips on the same installation', async () => {
    const original = await readCurrentConfigContent();
    const file = await exportFile();
    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed', updatedAt: now() });
    await ctx.db.delete(schema.l4ProxyHosts);
    await setSettingRow(ctx.db, 'waf', { enabled: false });

    const result = await importConfiguration({ file: JSON.stringify(file), passphrase: PASSPHRASE, userId: fx.adminId });

    expect(result.warning).toBeNull();
    expect(result.counts).toMatchObject({ proxyHosts: 1, l4ProxyHosts: 1, certificates: 1, settings: 3 });
    const imported = await readCurrentConfigContent();
    expect(decrypted(imported)).toEqual(decrypted(withoutAttribution(original)));
    // Secrets are encrypted again with the local key, not copied.
    const cert = imported.tables.certificates[0].privateKeyPem as string;
    expect(isEncryptedSecret(cert)).toBe(true);
    expect(cert).not.toBe(original.tables.certificates[0].privateKeyPem);
    expect(decryptSecret(cert)).toBe(CERT_KEY);
    expect(imported.tables.accessListEntries[0].passwordHash).toBe(ENTRY_HASH);
    // Group names did not change, so memberships stay; forward-auth sign-ins end.
    expect(await ctx.db.select().from(schema.groupMembers)).toHaveLength(1);
    expect(await ctx.db.select().from(schema.forwardAuthSessions)).toHaveLength(0);
    expect(applyCaddyConfig).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'config_imported', userId: fx.adminId }));
  });

  it('moves to another installation, mapping forward-auth grants by email', async () => {
    const source = await readCurrentConfigContent();
    const file = await exportFile();

    // A fresh installation whose users have other ids.
    ctx.db = createTestDb();
    const t = now();
    const stranger = (await first(ctx.db.insert(schema.users).values({
      email: 'stranger@example.com', role: 'admin', status: 'active', createdAt: t, updatedAt: t,
    }).returning()))!;
    await ctx.db.insert(schema.users).values({
      email: 'someone-else@example.com', role: 'user', status: 'active', createdAt: t, updatedAt: t,
    });
    const member = (await first(ctx.db.insert(schema.users).values({
      email: 'MEMBER@example.com', role: 'user', status: 'active', createdAt: t, updatedAt: t,
    }).returning()))!;
    expect(member.id).not.toBe(fx.memberId);

    await importConfiguration({ file, passphrase: PASSPHRASE, userId: stranger.id });

    const imported = await readCurrentConfigContent();
    expect(imported.tables.proxyHosts.map((row) => row.name)).toEqual(['App']);
    expect(imported.tables.forwardAuthAccess.map((g) => [g.userId, g.groupId])).toEqual([[null, fx.groupId], [member.id, null]]);
    const expected = withoutAttribution(source);
    expected.tables.forwardAuthAccess = expected.tables.forwardAuthAccess.map((g) =>
      g.userId === fx.memberId ? { ...g, userId: member.id } : g
    );
    expect(decrypted(imported)).toEqual(decrypted(expected));
  });

  it('drops grants for users the installation does not have', async () => {
    const file = await exportFile();
    await ctx.db.update(schema.users).set({ email: 'renamed@example.com' }).where(eq(schema.users.id, fx.memberId));
    await importConfiguration({ file, passphrase: PASSPHRASE, userId: fx.adminId });
    expect((await ctx.db.select().from(schema.forwardAuthAccess)).map((g) => g.userId)).toEqual([null]);
  });

  it('does not keep local members in an imported group that has another name', async () => {
    const file = await exportFile();
    await ctx.db.update(schema.groups).set({ name: 'Local admins' }).where(eq(schema.groups.id, fx.groupId));
    await importConfiguration({ file, passphrase: PASSPHRASE, userId: fx.adminId });
    expect((await first(ctx.db.select().from(schema.groups).limit(1)))!.name).toBe('Developers');
    expect(await ctx.db.select().from(schema.groupMembers)).toHaveLength(0);
  });

  it('rejects a wrong passphrase with 400 and changes nothing', async () => {
    const file = await exportFile();
    await ctx.db.update(schema.proxyHosts).set({ name: 'Changed' });
    const before = await readCurrentConfigContent();
    await setSettingRow(ctx.db, HISTORY_SETTING_KEY, { enabled: true, retention: 200 });

    const error = await importConfiguration({
      file, passphrase: 'not the passphrase', userId: fx.adminId, beforeWrite: beforeImportSnapshotHook(fx.adminId),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiValidationError);
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^Wrong passphrase/);
    expect(await readCurrentConfigContent()).toEqual(before);
    expect((await listSnapshots()).total).toBe(0);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', () => '{nope', /not JSON/],
    ['another format', (f: ConfigExportFile) => ({ ...f, format: 'something-else' }), /format must be/],
    ['a newer version', (f: ConfigExportFile) => ({ ...f, version: 2 }), /version 2/],
    ['an unknown field', (f: ConfigExportFile) => ({ ...f, extra: true }), /unknown field "extra"/],
    ['an unknown table', (f: ConfigExportFile) => ({ ...f, content: { ...f.content, tables: { ...f.content.tables, users: [] } } }), /unknown table "users"/],
    ['an unknown setting', (f: ConfigExportFile) => ({ ...f, content: { ...f.content, settings: { ...f.content.settings, license: {} } } }), /unknown setting "license"/],
    ['a wrongly typed column', (f: ConfigExportFile) => {
      const copy = structuredClone(f);
      copy.content.tables.proxyHosts[0].enabled = 'yes';
      return copy;
    }, /proxyHosts\[0\]\.enabled must be a boolean/],
    ['a secret moved to another place', (f: ConfigExportFile) => {
      const copy = structuredClone(f);
      copy.content.tables.caCertificates[0].privateKeyPem = copy.content.tables.certificates[0].privateKeyPem;
      return copy;
    }, /does not decrypt; the file is damaged/],
    ['a secret under an instance key', (f: ConfigExportFile) => {
      const copy = structuredClone(f);
      copy.content.tables.certificates[0].privateKeyPem = encryptUnderOtherSecret('key');
      return copy;
    }, /encrypted with an instance key/],
    ['weak scrypt parameters', (f: ConfigExportFile) => ({ ...f, kdf: { ...f.kdf, N: 1024 } }), /kdf\.N is out of range/],
  ])('rejects %s with 400 before changing anything', async (_name, mutate, message) => {
    const file = await exportFile();
    const before = await readCurrentConfigContent();
    const error = await importConfiguration({
      file: (mutate as (f: ConfigExportFile) => unknown)(file), passphrase: PASSPHRASE, userId: fx.adminId,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiValidationError);
    expect(error.message).toMatch(message);
    expect(await readCurrentConfigContent()).toEqual(before);
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('accepts plaintext secrets in a hand-written file and encrypts them locally', async () => {
    const file = await exportFile();
    const copy = structuredClone(file);
    copy.content.tables.certificates[0].privateKeyPem = 'HAND-WRITTEN-KEY';
    const content = await decodeConfigurationExport(copy, PASSPHRASE);
    const value = content.tables.certificates[0].privateKeyPem as string;
    expect(isEncryptedSecret(value)).toBe(true);
    expect(decryptSecret(value)).toBe('HAND-WRITTEN-KEY');
  });

  it('saves the configuration it replaces when history is enabled, without a license', async () => {
    const file = await exportFile();
    await ctx.db.update(schema.proxyHosts).set({ name: 'Before import' });
    const before = await readCurrentConfigContent();
    await setSettingRow(ctx.db, HISTORY_SETTING_KEY, { enabled: true, retention: 200 });
    const saved = { snapshotId: null as number | null };

    await importConfiguration({ file, passphrase: PASSPHRASE, userId: fx.adminId, beforeWrite: beforeImportSnapshotHook(fx.adminId, saved) });

    const { snapshots } = await listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ id: saved.snapshotId, reason: 'import', userId: fx.adminId });
    const stored = (await first(ctx.db.select().from(schema.configSnapshots).limit(1)))!;
    expect(JSON.parse(stored.content).tables.proxyHosts[0].name).toBe('Before import');
    expect(JSON.parse(stored.content)).toEqual(JSON.parse(JSON.stringify(before)));
  });

  it('saves no snapshot when history is disabled', async () => {
    const file = await exportFile();
    const saved = { snapshotId: null as number | null };
    await importConfiguration({ file, passphrase: PASSPHRASE, userId: fx.adminId, beforeWrite: beforeImportSnapshotHook(fx.adminId, saved) });
    expect(saved.snapshotId).toBeNull();
    expect((await listSnapshots()).total).toBe(0);
  });

  it('puts the configuration back when Caddy rejects the imported one', async () => {
    const file = await exportFile();
    await ctx.db.update(schema.proxyHosts).set({ name: 'Kept' });
    const before = await readCurrentConfigContent();
    const faSessions = await ctx.db.select().from(schema.forwardAuthSessions);
    const { CaddyApplyError } = await import('../../src/lib/caddy-apply-error');
    vi.mocked(applyCaddyConfig).mockRejectedValueOnce(new CaddyApplyError('Unable to reach Caddy API', 'CADDY_UNREACHABLE'));

    await expect(importConfiguration({ file, passphrase: PASSPHRASE, userId: fx.adminId })).rejects.toThrow(
      'Caddy did not accept the configuration: Unable to reach Caddy API. Nothing was changed.'
    );
    expect(await readCurrentConfigContent()).toEqual(before);
    expect(await ctx.db.select().from(schema.forwardAuthSessions)).toEqual(faSessions);
  });

  it('is refused on a sync slave', async () => {
    const file = await exportFile();
    await setSettingRow(ctx.db, 'instance_mode', 'slave');
    await expect(importConfiguration({ file, passphrase: PASSPHRASE, userId: fx.adminId })).rejects.toMatchObject({ status: 409 });
    expect(applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('works with foreign keys off, as in production', async () => {
    await disableForeignKeys(ctx.db);
    const original = await readCurrentConfigContent();
    const file = await exportFile();
    await ctx.db.delete(schema.proxyHosts);
    await importConfiguration({ file, passphrase: PASSPHRASE, userId: fx.adminId });
    expect(decrypted(await readCurrentConfigContent())).toEqual(decrypted(withoutAttribution(original)));
  });
});
