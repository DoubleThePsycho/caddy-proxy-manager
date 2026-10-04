/**
 * The token a pull replica's fingerprints are keyed with (stored encrypted on
 * the master, ee/fleet/pull-replicas.ts) follows a SESSION_SECRET rotation
 * like every other stored secret (src/lib/secret-rotation.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  config: {
    sessionSecret: 'old-operator-secret-abcdefghijklmnopqrstuvwxyz',
    previousSessionSecrets: [] as string[],
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

import * as schema from '../../src/lib/db/schema';
import { decryptSecret, encryptSecret, reencryptSecret } from '../../src/lib/secret';
import { reencryptStoredSecrets } from '../../src/lib/secret-rotation';
import { pullFingerprintToken } from '@/ee/fleet/pull-config';
import { first } from '@/src/lib/db/ops';

const OLD_SECRET = 'old-operator-secret-abcdefghijklmnopqrstuvwxyz';
const NEW_SECRET = 'new-operator-secret-zyxwvutsrqponmlkjihgfedcba';

describe('pull replica secret rotation', () => {
  it('re-encrypts the fingerprint token stored under SESSION_SECRET_PREVIOUS; the credential hash stays', async () => {
    const now = new Date().toISOString();
    const token = pullFingerprintToken(`pull_${'c'.repeat(43)}`);
    const instance = (await first(ctx.db.insert(schema.instances).values({
      name: 'edge', baseUrl: 'pull:00000000-0000-4000-8000-000000000001', apiToken: '', syncMode: 'pull', createdAt: now, updatedAt: now,
    }).returning()))!;
    await ctx.db.insert(schema.fleetPullReplicas).values({
      instanceId: instance.id, credentialHash: 'a'.repeat(64), credentialPrefix: 'pull_cccccc', fingerprintToken: encryptSecret(token),
      createdAt: now, updatedAt: now,
    });

    ctx.config.sessionSecret = NEW_SECRET;
    ctx.config.previousSessionSecrets = [OLD_SECRET];
    expect(await reencryptStoredSecrets()).toMatchObject({ reencrypted: 1, failed: 0 });

    ctx.config.previousSessionSecrets = [];
    const row = (await first(ctx.db.select().from(schema.fleetPullReplicas).where(eq(schema.fleetPullReplicas.instanceId, instance.id)).limit(1)))!;
    expect(reencryptSecret(row.fingerprintToken!)).toBeNull();
    expect(decryptSecret(row.fingerprintToken!)).toBe(token);
    expect(row.credentialHash).toBe('a'.repeat(64));
  });
});
