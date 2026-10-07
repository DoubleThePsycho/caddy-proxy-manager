/**
 * Directory health (ee/ldap/health.ts): the periodic check of enabled
 * directories against a fake directory, what it stores, auditing only
 * changes of state, the overall timeout, the LDAP REST API showing it, the
 * "Test the connection" button updating it, and getIdentityHealth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';
import { fakeLdap, person } from '../helpers/fake-ldap';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('ldapts', async (importOriginal) => {
  const { fakeLdapModule } = await import('../helpers/fake-ldap');
  return fakeLdapModule(await importOriginal<typeof import('ldapts')>());
});
vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));
vi.mock('../../src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn(),
  };
});

import { requireApiAdmin } from '../../src/lib/api-auth';
import { logAuditEvent } from '../../src/lib/audit';
import { checkDirectoryHealth, readDirectoryHealth, runDirectoryHealthChecks } from '../../ee/ldap/health';
import { getIdentityHealth } from '../../src/lib/identity-health';
import * as listRoute from '../../app/api/v1/ldap-directories/route';
import * as detailRoute from '../../app/api/v1/ldap-directories/[id]/route';
import * as testRoute from '../../app/api/v1/ldap-directories/[id]/test/route';
import { first } from '@/src/lib/db/ops';

const SERVICE_PASSWORD = fakeLdap.servicePassword;
let adminId: number;

const now = () => new Date().toISOString();

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function create(overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
  const response = await listRoute.POST(req('POST', '/api/v1/ldap-directories', {
    name: 'Corp LDAP',
    url: 'ldaps://ldap.example.com:636',
    bindDn: fakeLdap.serviceDn,
    bindPassword: SERVICE_PASSWORD,
    userSearchBase: 'ou=people,dc=example,dc=com',
    userSearchFilter: '(&(objectClass=inetOrgPerson)(uid={username}))',
    ...overrides,
  }));
  expect(response.status).toBe(201);
  return response.json();
}

function auditActions(): string[] {
  return vi.mocked(logAuditEvent).mock.calls.map(([event]) => event.action);
}

beforeEach(async () => {
  ctx.db = createTestDb();
  vi.clearAllMocks();
  fakeLdap.reset();
  fakeLdap.servicePassword = SERVICE_PASSWORD;
  fakeLdap.entries.push(person('alice'));
  adminId = (await first(ctx.db.insert(schema.users).values({
    email: 'admin@example.com', role: 'admin', status: 'active', createdAt: now(), updatedAt: now(),
  }).returning()))!.id;
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: adminId, role: 'admin', authMethod: 'bearer' } as never);
});

describe('periodic checks', () => {
  it('checks enabled directories only, stores the outcome and audits only changes of state', async () => {
    const { id } = await create();
    const disabled = await create({ name: 'Off', enabled: false });
    vi.mocked(logAuditEvent).mockClear();

    expect(await runDirectoryHealthChecks()).toEqual({ checked: 1, failing: 0 });
    expect(await readDirectoryHealth(disabled.id)).toBeNull();
    const ok = (await readDirectoryHealth(id))!;
    expect(ok).toMatchObject({ status: 'ok', consecutiveFailures: 0, failingSince: null, lastError: null });
    expect(ok.lastSuccessAt).toBe(ok.checkedAt);
    expect(auditActions()).toEqual([]);

    // The service account password changed in the directory.
    fakeLdap.servicePassword = 'rotated';
    await runDirectoryHealthChecks();
    await runDirectoryHealthChecks();
    await runDirectoryHealthChecks();
    const failing = (await readDirectoryHealth(id))!;
    expect(failing).toMatchObject({
      status: 'failing',
      consecutiveFailures: 3,
      lastError: 'Service account bind: invalid credentials (LDAP result 49)',
      lastSuccessAt: ok.lastSuccessAt,
    });
    expect(failing.failingSince).not.toBeNull();
    expect(JSON.stringify(failing)).not.toContain('rotated');
    expect(JSON.stringify(failing)).not.toContain(SERVICE_PASSWORD);
    expect(auditActions()).toEqual(['ldap_directory_unavailable']);

    fakeLdap.servicePassword = SERVICE_PASSWORD;
    await runDirectoryHealthChecks();
    expect(await readDirectoryHealth(id)).toMatchObject({ status: 'ok', consecutiveFailures: 0, failingSince: null });
    expect(auditActions()).toEqual(['ldap_directory_unavailable', 'ldap_directory_recovered']);
  });

  it('reports a directory that cannot be reached', async () => {
    const { id } = await create();
    fakeLdap.unreachable = true;
    await runDirectoryHealthChecks();
    expect(await readDirectoryHealth(id)).toMatchObject({ status: 'failing', lastError: expect.stringMatching(/: connection refused$/) });
  });

  it('gives up on a check that hangs', async () => {
    const { id } = await create({ connectTimeoutMs: 1000, operationTimeoutMs: 1000 });
    const row = (await ctx.db.select().from(schema.ldapDirectories)).find((candidate) => candidate.id === id)!;
    vi.useFakeTimers();
    try {
      const pending = checkDirectoryHealth(row, () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(8_000);
      const health = await pending;
      expect(health).toMatchObject({ status: 'failing', lastError: 'The check did not finish within 8 seconds' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('REST API and the overview', () => {
  it('returns the health with each directory and updates it from the connection test', async () => {
    const { id } = await create();
    expect((await (await detailRoute.GET(req('GET', `/api/v1/ldap-directories/${id}`), params(id))).json()).health).toBeNull();

    fakeLdap.servicePassword = 'rotated';
    await testRoute.POST(req('POST', `/api/v1/ldap-directories/${id}/test`), params(id));
    const listed = await (await listRoute.GET(req('GET', '/api/v1/ldap-directories'))).json();
    expect(listed[0].health).toMatchObject({ status: 'failing', consecutiveFailures: 1 });

    const health = await getIdentityHealth();
    expect(health.directories).toEqual([{ id, name: 'Corp LDAP', health: expect.objectContaining({ status: 'failing' }) }]);
    expect(health.issues).toEqual([expect.objectContaining({ kind: 'directory_failing', severity: 'warning', directoryId: id })]);

    await runDirectoryHealthChecks();
    await runDirectoryHealthChecks();
    expect((await getIdentityHealth()).issues[0]).toMatchObject({ severity: 'critical', consecutiveFailures: 3 });

    // New service account settings start the health over; deleting the directory deletes it.
    fakeLdap.servicePassword = SERVICE_PASSWORD;
    await detailRoute.PUT(req('PUT', `/api/v1/ldap-directories/${id}`, { bindPassword: SERVICE_PASSWORD }), params(id));
    expect(await readDirectoryHealth(id)).toBeNull();
    await runDirectoryHealthChecks();
    expect((await getIdentityHealth()).issues).toEqual([]);
    await detailRoute.DELETE(req('DELETE', `/api/v1/ldap-directories/${id}`), params(id));
    expect(await ctx.db.select().from(schema.ldapDirectoryHealth)).toEqual([]);
  });

  it('reports accounts the MFA policy has locked out of the dashboard', async () => {
    await ctx.db.insert(schema.settings).values({
      key: 'mfa_policy',
      value: JSON.stringify({ scope: 'admins', graceDays: 0, since: new Date(0).toISOString() }),
      updatedAt: now(),
    });
    await ctx.db.insert(schema.accounts).values({
      userId: adminId, issuer: 'credential', accountId: String(adminId), providerId: 'credential', password: 'hash',
      createdAt: now(), updatedAt: now(),
    });
    expect((await getIdentityHealth()).issues).toEqual([expect.objectContaining({ kind: 'mfa_overdue', accounts: 1 })]);
  });
});
