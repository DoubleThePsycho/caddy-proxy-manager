/**
 * Audit sink secrets follow a SESSION_SECRET rotation like every other stored
 * secret (src/lib/secret-rotation.ts).
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

describe('audit sink secret rotation', () => {
  it('re-encrypts a sink secret stored under SESSION_SECRET_PREVIOUS', async () => {
    const now = new Date().toISOString();
    const [sink] = await ctx.db.insert(schema.auditSinks).values({
      name: 'SIEM', type: 'splunk_hec', config: '{"url":"https://splunk.example.com","index":null}',
      secret: encryptSecret('hec-token'), createdAt: now, updatedAt: now,
    }).returning();

    ctx.config.sessionSecret = NEW_SECRET;
    ctx.config.previousSessionSecrets = [OLD_SECRET];
    expect(await reencryptStoredSecrets()).toMatchObject({ reencrypted: 1, failed: 0 });

    ctx.config.previousSessionSecrets = [];
    const [row] = await ctx.db.select().from(schema.auditSinks).where(eq(schema.auditSinks.id, sink.id));
    expect(row.secret).not.toBe(sink.secret);
    expect(reencryptSecret(row.secret!)).toBeNull();
    expect(decryptSecret(row.secret!)).toBe('hec-token');
  });
});
