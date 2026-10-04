/**
 * Alert channel credentials follow a SESSION_SECRET rotation like every other
 * stored secret; the AI provider key is covered by the settings pass.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  config: { sessionSecret: 'current-secret-for-rotation-tests-0123456789', previousSessionSecrets: [] as string[] },
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
import { decryptSecret, reencryptSecret } from '../../src/lib/secret';
import { reencryptStoredSecrets } from '../../src/lib/secret-rotation';
import { encryptUnderOtherSecret, OTHER_SESSION_SECRET } from '../helpers/encrypt-under-other-secret';

describe('alert channel secrets', () => {
  it('are re-encrypted with the current SESSION_SECRET', async () => {
    const now = new Date().toISOString();
    const channelSecrets = JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/T/B/token' });
    await ctx.db.insert(schema.alertChannels).values({ name: 'Slack', type: 'slack', secrets: encryptUnderOtherSecret(channelSecrets), createdAt: now, updatedAt: now });
    await ctx.db.insert(schema.settings).values({
      key: 'ai_provider',
      value: JSON.stringify({ enabled: true, provider: 'anthropic', model: 'claude-opus-5', apiKey: encryptUnderOtherSecret('sk-ant-key') }),
      updatedAt: now,
    });
    ctx.config.previousSessionSecrets = [OTHER_SESSION_SECRET];

    const result = await reencryptStoredSecrets();
    expect(result.reencrypted).toBe(2);
    expect(result.failed).toBe(0);

    ctx.config.previousSessionSecrets = [];
    const [channel] = await ctx.db.select().from(schema.alertChannels);
    expect(reencryptSecret(channel.secrets!)).toBeNull();
    expect(decryptSecret(channel.secrets!)).toBe(channelSecrets);
    const [setting] = await ctx.db.select().from(schema.settings);
    expect(decryptSecret(JSON.parse(setting.value).apiKey)).toBe('sk-ant-key');
  });
});
