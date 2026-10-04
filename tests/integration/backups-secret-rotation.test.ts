/**
 * Backup destination secrets (secret access key, export passphrase) follow a
 * SESSION_SECRET rotation like every other stored secret
 * (src/lib/secret-rotation.ts).
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

const OLD_SECRET = 'old-operator-secret-abcdefghijklmnopqrstuvwxyz';
const NEW_SECRET = 'new-operator-secret-zyxwvutsrqponmlkjihgfedcba';

describe('backup destination secret rotation', () => {
  it('re-encrypts the secret access key and the passphrase stored under SESSION_SECRET_PREVIOUS', async () => {
    const now = new Date().toISOString();
    const [destination] = await ctx.db.insert(schema.backupDestinations).values({
      name: 'Offsite', endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'bkt', accessKeyId: 'AKIA',
      secretAccessKey: encryptSecret('s3-secret'), passphrase: encryptSecret('export passphrase'),
      schedule: '{"kind":"daily","time":"03:00"}', createdAt: now, updatedAt: now,
    }).returning();

    ctx.config.sessionSecret = NEW_SECRET;
    ctx.config.previousSessionSecrets = [OLD_SECRET];
    expect(await reencryptStoredSecrets()).toMatchObject({ reencrypted: 2, failed: 0 });

    ctx.config.previousSessionSecrets = [];
    const [row] = await ctx.db.select().from(schema.backupDestinations).where(eq(schema.backupDestinations.id, destination.id));
    expect(row.secretAccessKey).not.toBe(destination.secretAccessKey);
    expect(reencryptSecret(row.secretAccessKey)).toBeNull();
    expect(reencryptSecret(row.passphrase)).toBeNull();
    expect(decryptSecret(row.secretAccessKey)).toBe('s3-secret');
    expect(decryptSecret(row.passphrase)).toBe('export passphrase');
  });
});
