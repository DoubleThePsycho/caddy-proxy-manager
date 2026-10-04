/**
 * Per-host WAF body limits must be rejected at write time when Coraza would
 * refuse them (#252).
 *
 * coraza-caddy builds its WAF while Caddy loads the config, so an out-of-range
 * limit doesn't fail just this host — Caddy rejects the entire config document
 * and every host stops being reconfigured. Failing the write keeps a bad value
 * from ever reaching the config builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('../../src/lib/caddy', () => ({
  applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import {
  createProxyHost,
  updateProxyHost,
  getProxyHost,
  type ProxyHostInput,
  type WafHostConfig,
} from '../../src/lib/models/proxy-hosts';
import * as schema from '../../src/lib/db/schema';

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin',
    provider: 'credentials',
    subject: 'test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

function hostInput(waf: WafHostConfig, name = 'waf-host'): ProxyHostInput {
  return {
    name,
    domains: [`${name}.example.com`],
    upstreams: ['10.0.0.5:8080'],
    waf,
  };
}

const validWaf: WafHostConfig = { enabled: true, waf_mode: 'merge' };

describe('per-host WAF body limits', () => {
  it('persists limits inside Coraza’s range', async () => {
    const host = await createProxyHost(
      hostInput({ ...validWaf, request_body_limit: 536870912, request_body_limit_action: 'ProcessPartial' }),
      1
    );

    const fetched = await getProxyHost(host.id);
    expect(fetched?.waf?.request_body_limit).toBe(536870912);
    expect(fetched?.waf?.request_body_limit_action).toBe('ProcessPartial');
  });

  it('rejects a limit above the 1 GiB Coraza accepts', async () => {
    await expect(
      createProxyHost(hostInput({ ...validWaf, request_body_limit: 10737418240 }, 'too-big'), 1)
    ).rejects.toThrow(/waf\.request_body_limit must be an integer between/);
  });

  it('rejects an in-memory limit larger than the request limit', async () => {
    await expect(
      createProxyHost(
        hostInput({ ...validWaf, request_body_limit: 1048576, request_body_in_memory_limit: 2097152 }, 'inverted'),
        1
      )
    ).rejects.toThrow(/must not exceed/);
  });

  it('rejects an out-of-range limit smuggled through custom directives', async () => {
    await expect(
      createProxyHost(
        hostInput({ ...validWaf, custom_directives: 'SecRequestBodyLimit 10737418240' }, 'smuggled'),
        1
      )
    ).rejects.toThrow(/out-of-range body limit/);
  });

  it('rejects an unknown over-limit action', async () => {
    await expect(
      createProxyHost(
        hostInput({ ...validWaf, request_body_limit_action: 'Drop' as never }, 'bad-action'),
        1
      )
    ).rejects.toThrow(/Reject or ProcessPartial/);
  });

  it('rejects a bad limit on update and leaves the stored value intact', async () => {
    const host = await createProxyHost(
      hostInput({ ...validWaf, request_body_limit: 536870912 }, 'updated'),
      1
    );

    await expect(
      updateProxyHost(host.id, { waf: { ...validWaf, request_body_limit: 10737418240 } }, 1)
    ).rejects.toThrow(/waf\.request_body_limit must be an integer between/);

    const fetched = await getProxyHost(host.id);
    expect(fetched?.waf?.request_body_limit).toBe(536870912);
  });
});
