/**
 * Recovering dashboard MFA:
 *  - changing ADMIN_USERNAME/ADMIN_PASSWORD (the documented account recovery)
 *    also turns off the primary admin's MFA, with a startup log line and an
 *    audit record; restarting with unchanged credentials keeps it;
 *  - a SESSION_SECRET rotation re-encrypts the stored TOTP secrets (Better
 *    Auth's encryption) and backup codes (encryptSecret) with the new secret.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const OLD_SECRET = 'old-operator-secret-abcdefghijklmnopqrstuvwxyz';
const NEW_SECRET = 'new-operator-secret-zyxwvutsrqponmlkjihgfedcba';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  config: {
    sessionSecret: 'old-operator-secret-abcdefghijklmnopqrstuvwxyz',
    previousSessionSecrets: [] as string[],
    adminUsername: 'admin',
    adminPassword: 'Env-Password-2026!',
  },
}));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});
vi.mock('../../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/config')>()),
  config: ctx.config,
}));

import { eq } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import * as schema from '../../src/lib/db/schema';
import { ensureAdminUser } from '../../src/lib/init-db';
import { decryptSecret, encryptSecret } from '../../src/lib/secret';
import { reencryptStoredSecrets } from '../../src/lib/secret-rotation';
import { getMfaStatus } from '../../src/lib/mfa';
import { logAuditEvent } from '../../src/lib/audit';
import { first } from '@/src/lib/db/ops';

const TOTP_SECRET = 'raw-totp-secret-0123456789abcdef';
const CODES = ['AAAAA-11111', 'BBBBB-22222'];

async function enrol(userId: number) {
  await ctx.db.insert(schema.twoFactors).values({
    userId,
    secret: await symmetricEncrypt({ key: ctx.config.sessionSecret, data: TOTP_SECRET }),
    backupCodes: encryptSecret(JSON.stringify(CODES)),
    verified: true,
  });
  await ctx.db.update(schema.users).set({ twoFactorEnabled: true }).where(eq(schema.users.id, userId));
}

beforeEach(async () => {
  for (const table of [schema.twoFactors, schema.sessions, schema.accounts, schema.settings, schema.users]) {
    await ctx.db.delete(table);
  }
  Object.assign(ctx.config, {
    sessionSecret: OLD_SECRET,
    previousSessionSecrets: [],
    adminUsername: 'admin',
    adminPassword: 'Env-Password-2026!',
  });
  vi.mocked(logAuditEvent).mockClear();
  vi.restoreAllMocks();
});

describe('ADMIN_USERNAME/ADMIN_PASSWORD recovery', { timeout: 20_000 }, () => {
  it('turns off the primary admin\'s MFA when the environment credentials change', async () => {
    await ensureAdminUser();
    await enrol(1);
    expect((await getMfaStatus(1)).enabled).toBe(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // A restart with the same credentials keeps MFA.
    await ensureAdminUser();
    expect((await getMfaStatus(1)).enabled).toBe(true);
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/multi-factor/);

    ctx.config.adminPassword = 'Recovered-Password-2026!';
    await ensureAdminUser();
    expect((await getMfaStatus(1)).enabled).toBe(false);
    expect(await ctx.db.select().from(schema.twoFactors)).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toContain(
      'Turned off multi-factor authentication for admin because the environment credentials changed'
    );
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa_reset', entityId: 1, userId: null }));
  });

  it('also applies to a changed ADMIN_USERNAME, and says nothing when there was no MFA', async () => {
    await ensureAdminUser();
    await enrol(1);
    ctx.config.adminUsername = 'operator';
    await ensureAdminUser();
    expect((await getMfaStatus(1)).enabled).toBe(false);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    ctx.config.adminPassword = 'Another-Password-2026!';
    await ensureAdminUser();
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/multi-factor/);
  });
});

describe('SESSION_SECRET rotation', () => {
  async function seedEnrolledUser(): Promise<number> {
    const now = new Date().toISOString();
    const [user] = await ctx.db.insert(schema.users).values({
      email: 'mfa@example.com', role: 'user', status: 'active', createdAt: now, updatedAt: now,
    }).returning();
    await enrol(user.id);
    return user.id;
  }

  it('re-encrypts the authenticator secret and the backup codes with the new secret', async () => {
    const userId = await seedEnrolledUser();
    ctx.config.sessionSecret = NEW_SECRET;
    ctx.config.previousSessionSecrets = [OLD_SECRET];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await reencryptStoredSecrets();
    expect(result).toMatchObject({ reencrypted: 2, failed: 0 });

    ctx.config.previousSessionSecrets = [];
    const row = (await first(ctx.db.select().from(schema.twoFactors).where(eq(schema.twoFactors.userId, userId)).limit(1)))!;
    expect(await symmetricDecrypt({ key: NEW_SECRET, data: row.secret })).toBe(TOTP_SECRET);
    expect(JSON.parse(decryptSecret(row.backupCodes))).toEqual(CODES);
    expect((await getMfaStatus(userId)).backupCodesRemaining).toBe(2);

    // Idempotent.
    expect(await reencryptStoredSecrets()).toMatchObject({ reencrypted: 0, failed: 0 });
  });

  it('reports a secret no key opens and leaves it alone', async () => {
    await seedEnrolledUser();
    ctx.config.sessionSecret = NEW_SECRET;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reencryptStoredSecrets();
    expect(result.failed).toBe(2);
    expect(warn.mock.calls.flat().join('\n')).toContain('MFA authenticator secret of user');
  });
});
