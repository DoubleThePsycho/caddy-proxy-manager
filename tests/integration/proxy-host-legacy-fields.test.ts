/**
 * The REST field `ingressiForwardAuth` was called `cpmForwardAuth` before the
 * rename to Ingressi. Clients written for the old name keep working, and the
 * stored meta key is unchanged so older replicas and exports still read it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('../../src/lib/caddy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/caddy')>();
  return { ...actual, applyCaddyConfig: vi.fn().mockResolvedValue({ ok: true }) };
});

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

import { eq } from 'drizzle-orm';
import { createProxyHost, getProxyHost, toApiProxyHost, updateProxyHost, type ProxyHostInput } from '../../src/lib/models/proxy-hosts';
import * as schema from '../../src/lib/db/schema';

const base = { name: 'legacy', domains: ['legacy.example.com'], upstreams: ['10.0.0.5:8080'] };

/** Input as a REST client written before the rename sends it. */
function legacyInput(fields: Record<string, unknown>): ProxyHostInput {
  return fields as unknown as ProxyHostInput;
}

async function storedMeta(id: number): Promise<Record<string, unknown>> {
  const [row] = await ctx.db.select().from(schema.proxyHosts).where(eq(schema.proxyHosts.id, id));
  return JSON.parse(row.meta ?? '{}');
}

beforeEach(async () => {
  await ctx.db.delete(schema.proxyHosts);
  await ctx.db.delete(schema.users);
  const now = new Date().toISOString();
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    provider: 'credentials',
    subject: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
});

describe('legacy cpmForwardAuth field', () => {
  it('is accepted on create and update when ingressiForwardAuth is absent', async () => {
    const created = await createProxyHost(legacyInput({ ...base, cpmForwardAuth: { enabled: true, excluded_paths: ['/health'] } }), 1);
    expect(created.ingressiForwardAuth).toEqual({ enabled: true, protected_paths: null, excluded_paths: ['/health'] });

    await updateProxyHost(created.id, legacyInput({ cpmForwardAuth: { enabled: false } }), 1);
    expect((await getProxyHost(created.id))?.ingressiForwardAuth).toBeNull();
  });

  it('may repeat the new field with the same value, as a client echoing a fetched host does', async () => {
    const value = { enabled: true, protected_paths: ['/admin/*'], excluded_paths: null };
    const created = await createProxyHost(legacyInput({ ...base, ingressiForwardAuth: value, cpmForwardAuth: value }), 1);
    expect(created.ingressiForwardAuth?.protected_paths).toEqual(['/admin/*']);
  });

  it('is refused when it disagrees with ingressiForwardAuth', async () => {
    await expect(
      createProxyHost(legacyInput({ ...base, ingressiForwardAuth: { enabled: true }, cpmForwardAuth: { enabled: false } }), 1)
    ).rejects.toThrow(/deprecated name of ingressiForwardAuth/);
  });

  it('keeps the stored meta key that older replicas and exports read', async () => {
    const created = await createProxyHost({ ...base, ingressiForwardAuth: { enabled: true } }, 1);
    expect(await storedMeta(created.id)).toMatchObject({ cpm_forward_auth: { enabled: true } });
  });

  it('is returned next to ingressiForwardAuth by the REST representation', async () => {
    const created = await createProxyHost({ ...base, ingressiForwardAuth: { enabled: true } }, 1);
    const api = toApiProxyHost(created);
    expect(api.ingressiForwardAuth).toEqual({ enabled: true, protected_paths: null, excluded_paths: null });
    expect(api.cpmForwardAuth).toEqual(api.ingressiForwardAuth);
  });
});
