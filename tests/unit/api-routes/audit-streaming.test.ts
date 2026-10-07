/**
 * REST endpoints of audit streaming, export, verification and retention:
 * the write paths, read access, validation, secret redaction and audit
 * records of admin changes.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => {
  const { createTestDb } = await import('../../helpers/db');
  ctx.db = createTestDb();
  return (await import('../../helpers/db-module')).mockDbModule(() => ctx.db);
});

vi.mock('@/src/lib/api-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/api-auth')>();
  return {
    ...actual,
    requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
    requireApiAdmin: vi.fn().mockResolvedValue({ userId: 7, role: 'admin', authMethod: 'bearer' }),
  };
});

import * as schema from '@/src/lib/db/schema';
import { requireApiAdmin, ApiAuthError } from '@/src/lib/api-auth';
import { logAuditEvent } from '@/src/lib/audit';
import { insertAuditEvent } from '@/src/lib/audit-chain';
import { GET as listSinks, POST as createSink } from '@/app/api/v1/audit-sinks/route';
import { GET as getSink, PUT as updateSink, DELETE as deleteSink } from '@/app/api/v1/audit-sinks/[id]/route';
import { POST as testSink } from '@/app/api/v1/audit-sinks/[id]/test/route';
import { GET as getRetention, PUT as putRetention } from '@/app/api/v1/audit-log/retention/route';
import { GET as exportLog } from '@/app/api/v1/audit-log/export/route';
import { GET as verifyLog } from '@/app/api/v1/audit-log/verify/route';
import { GET as getOpenApi } from '@/app/api/v1/openapi.json/route';

const SECRET = 'whsec-route-test-0123456789';

let receiver: Server;
let receiverUrl: string;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(requireApiAdmin).mockResolvedValue({ userId: 7, role: 'admin', authMethod: 'bearer' });
  await ctx.db.delete(schema.auditSinks);
  await ctx.db.delete(schema.auditEvents);
  await ctx.db.delete(schema.settings);
});

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function webhookBody(extra: Record<string, unknown> = {}) {
  return { name: 'SIEM', type: 'webhook', config: { url: receiverUrl }, secret: SECRET, ...extra };
}

async function seedSink(): Promise<number> {
  const response = await createSink(req('POST', '/api/v1/audit-sinks', webhookBody()));
  expect(response.status).toBe(201);
  const { id } = await response.json();
  return id;
}

async function sinkCount() {
  return (await ctx.db.select().from(schema.auditSinks)).length;
}

describe('administrator changes', () => {
  it('POST /audit-sinks: 201', async () => {
    const created = await createSink(req('POST', '/api/v1/audit-sinks', webhookBody()));
    expect(created.status).toBe(201);
    expect(await sinkCount()).toBe(1);
  });

  it('PUT /audit-sinks/{id}: 200', async () => {
    const id = await seedSink();
    const updated = await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { name: 'Changed' }), params(id));
    expect(updated.status).toBe(200);
    expect((await updated.json()).name).toBe('Changed');
  });

  it('DELETE /audit-sinks/{id}: 204', async () => {
    const id = await seedSink();
    expect((await deleteSink(req('DELETE', `/api/v1/audit-sinks/${id}`), params(id))).status).toBe(204);
    expect(await sinkCount()).toBe(0);
    expect(logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'audit_sink_deleted', userId: 7 }));
  });

  it('PUT /audit-sinks/{id}: disables and enables a sink', async () => {
    const id = await seedSink();
    const disabled = await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { enabled: false }), params(id));
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).enabled).toBe(false);
    expect(logAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'audit_sink_updated', userId: 7 }));

    const enabled = await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { enabled: true }), params(id));
    expect(enabled.status).toBe(200);
    expect((await (await getSink(req('GET', `/api/v1/audit-sinks/${id}`), params(id))).json()).enabled).toBe(true);
  });

  it('POST /audit-sinks/{id}/test: 200', async () => {
    const id = await seedSink();
    const response = await testSink(req('POST', `/api/v1/audit-sinks/${id}/test`), params(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, error: null });
  });

  it('PUT /audit-log/retention: sets the retention, 0 keeps events forever', async () => {
    const saved = await putRetention(req('PUT', '/api/v1/audit-log/retention', { days: 90 }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).days).toBe(90);
    expect((await (await getRetention(req('GET', '/api/v1/audit-log/retention'))).json()).days).toBe(90);

    expect((await putRetention(req('PUT', '/api/v1/audit-log/retention', { days: '0' }))).status).toBe(400);
    const off = await putRetention(req('PUT', '/api/v1/audit-log/retention', { days: 0 }));
    expect(off.status).toBe(200);
    expect((await off.json()).days).toBe(0);
    expect((await (await getRetention(req('GET', '/api/v1/audit-log/retention'))).json()).days).toBe(0);
  });

  it('GET /audit-log/export: a download', async () => {
    await insertAuditEvent({ action: 'proxy_host_created', entityType: 'proxy_host', summary: '=1+1' });
    const response = await exportLog(req('GET', '/api/v1/audit-log/export?format=csv'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-log-[0-9TZ-]+\.csv"$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body.split('\r\n')[1]).toContain(",'=1+1,");

    const json = await exportLog(req('GET', '/api/v1/audit-log/export?format=json&from=2000-01-01'));
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect((await json.json()).events).toHaveLength(1);
  });

  it('GET /audit-log/verify: the result', async () => {
    await insertAuditEvent({ action: 'a', entityType: 'b' });
    const response = await verifyLog(req('GET', '/api/v1/audit-log/verify'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, checked: 1, firstMismatchId: null, anchoredAt: expect.any(String) });
  });
});

describe('read access', () => {
  it('lists and shows existing sinks and the retention', async () => {
    const id = await seedSink();
    const list = await listSinks(req('GET', '/api/v1/audit-sinks'));
    expect(list.status).toBe(200);
    expect((await list.json()).map((sink: { id: number }) => sink.id)).toEqual([id]);
    expect((await getSink(req('GET', `/api/v1/audit-sinks/${id}`), params(id))).status).toBe(200);
    expect((await getRetention(req('GET', '/api/v1/audit-log/retention'))).status).toBe(200);
  });

  it('still requires an administrator', async () => {
    vi.mocked(requireApiAdmin).mockRejectedValue(new ApiAuthError('Administrator privileges required', 403));
    for (const response of [
      await listSinks(req('GET', '/api/v1/audit-sinks')),
      await getRetention(req('GET', '/api/v1/audit-log/retention')),
      await getSink(req('GET', '/api/v1/audit-sinks/1'), params(1)),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe('Administrator privileges required');
    }
  });
});

describe('secret redaction', () => {
  it('never returns the secret and reports hasSecret', async () => {
    const created = await createSink(req('POST', '/api/v1/audit-sinks', webhookBody()));
    const text = await created.text();
    expect(text).not.toContain(SECRET);
    const sink = JSON.parse(text);
    expect(sink).toMatchObject({ hasSecret: true, config: { url: receiverUrl }, type: 'webhook', enabled: true });
    expect(sink).not.toHaveProperty('secret');

    const shown = await (await getSink(req('GET', `/api/v1/audit-sinks/${sink.id}`), params(sink.id))).text();
    const listed = await (await listSinks(req('GET', '/api/v1/audit-sinks'))).text();
    const updated = await (await updateSink(req('PUT', `/api/v1/audit-sinks/${sink.id}`, { enabled: false }), params(sink.id))).text();
    for (const body of [shown, listed, updated]) {
      expect(body).not.toContain(SECRET);
      expect(body).toContain('"hasSecret":true');
    }
  });

  it('keeps secrets out of the audit log', async () => {
    await createSink(req('POST', '/api/v1/audit-sinks', webhookBody()));
    expect(JSON.stringify(vi.mocked(logAuditEvent).mock.calls)).not.toContain(SECRET);
  });
});

describe('audit records', () => {
  it('records every administrator change', async () => {
    const { id } = await (await createSink(req('POST', '/api/v1/audit-sinks', webhookBody()))).json();
    await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { name: 'New name' }), params(id));
    await testSink(req('POST', `/api/v1/audit-sinks/${id}/test`), params(id));
    await deleteSink(req('DELETE', `/api/v1/audit-sinks/${id}`), params(id));
    await putRetention(req('PUT', '/api/v1/audit-log/retention', { days: 30 }));
    await (await exportLog(req('GET', '/api/v1/audit-log/export?format=json'))).text();
    await verifyLog(req('GET', '/api/v1/audit-log/verify'));
    const actions = vi.mocked(logAuditEvent).mock.calls.map(([event]) => [event.action, event.userId]);
    expect(actions).toEqual([
      ['audit_sink_created', 7],
      ['audit_sink_updated', 7],
      ['audit_sink_tested', 7],
      ['audit_sink_deleted', 7],
      ['audit_retention_updated', 7],
      ['audit_log_exported', 7],
      ['audit_log_verified', 7],
    ]);
  });
});

describe('validation', () => {
  beforeEach(async () => {
  });

  it.each([
    ['a body that is not JSON', '{"name":'],
    ['an array body', []],
    ['an unknown type', webhookBody({ type: 'email' })],
    ['a missing name', webhookBody({ name: '  ' })],
    ['an unknown field', webhookBody({ owner: 1 })],
    ['a non-http URL', webhookBody({ config: { url: 'ftp://siem.example.com/' } })],
    ['a URL with credentials', webhookBody({ config: { url: 'https://user:pass@siem.example.com/' } })],
    ['an invalid URL', webhookBody({ config: { url: 'not a url' } })],
    ['an unknown config field', webhookBody({ config: { url: receiverUrl, headers: {} } })],
    ['a short webhook secret', webhookBody({ secret: 'short' })],
    ['a webhook without a secret', webhookBody({ secret: undefined })],
    ['a secret with a newline', webhookBody({ secret: 'abcdefghijklmnop\r\nX-Evil: 1' })],
    ['a HEC sink without a token', { name: 'S', type: 'splunk_hec', config: { url: receiverUrl } }],
    ['a bad Splunk index', { name: 'S', type: 'splunk_hec', config: { url: receiverUrl, index: 'a b' }, secret: 'token' }],
    ['a syslog sink with a secret', { name: 'L', type: 'syslog', config: { host: 'logs.example.com' }, secret: 'x' }],
    ['a syslog host with a space', { name: 'L', type: 'syslog', config: { host: 'logs example.com' } }],
    ['a syslog host with a scheme', { name: 'L', type: 'syslog', config: { host: 'udp://logs.example.com' } }],
    ['port 0', { name: 'L', type: 'syslog', config: { host: 'logs.example.com', port: 0 } }],
    ['port 70000', { name: 'L', type: 'syslog', config: { host: 'logs.example.com', port: 70000 } }],
    ['an unknown protocol', { name: 'L', type: 'syslog', config: { host: 'logs.example.com', protocol: 'quic' } }],
    ['facility 24', { name: 'L', type: 'syslog', config: { host: 'logs.example.com', facility: 24 } }],
    ['a CA for UDP', { name: 'L', type: 'syslog', config: { host: 'logs.example.com', caPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' } }],
    ['a CA that is not a certificate', { name: 'L', type: 'syslog', config: { host: 'logs.example.com', protocol: 'tls', caPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' } }],
    ['a non-boolean backfill', webhookBody({ backfill: 'yes' })],
  ])('rejects %s with 400', async (_name, body) => {
    const response = await createSink(req('POST', '/api/v1/audit-sinks', body));
    expect(response.status).toBe(400);
    expect(typeof (await response.json()).error).toBe('string');
    expect(await sinkCount()).toBe(0);
  });

  it('accepts syslog defaults and IPv6 hosts', async () => {
    const response = await createSink(req('POST', '/api/v1/audit-sinks', { name: 'L', type: 'syslog', config: { host: '[2001:db8::1]', protocol: 'tls' } }));
    expect(response.status).toBe(201);
    expect((await response.json()).config).toEqual({ host: '2001:db8::1', port: 6514, protocol: 'tls', facility: 13, caPem: null });
  });

  it('starts new sinks after the newest event unless asked to backfill', async () => {
    await insertAuditEvent({ action: 'a', entityType: 'b' });
    await insertAuditEvent({ action: 'c', entityType: 'd' });
    const plain = await (await createSink(req('POST', '/api/v1/audit-sinks', webhookBody()))).json();
    const backfilled = await (await createSink(req('POST', '/api/v1/audit-sinks', webhookBody({ backfill: true })))).json();
    expect(plain).toMatchObject({ pendingEvents: 0 });
    expect(plain.lastDeliveredId).toBeGreaterThan(0);
    expect(backfilled).toMatchObject({ lastDeliveredId: 0, pendingEvents: 2 });
  });

  it('rejects changing the type, removing a required secret and unknown ids', async () => {
    const { id } = await (await createSink(req('POST', '/api/v1/audit-sinks', webhookBody()))).json();
    expect((await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { type: 'syslog' }), params(id))).status).toBe(400);
    expect((await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { secret: null }), params(id))).status).toBe(400);
    expect((await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { config: { url: 'javascript:alert(1)' } }), params(id))).status).toBe(400);
    expect((await updateSink(req('PUT', '/api/v1/audit-sinks/999', { name: 'x' }), params(999))).status).toBe(404);
    expect((await getSink(req('GET', '/api/v1/audit-sinks/abc'), params('abc'))).status).toBe(404);
    expect((await deleteSink(req('DELETE', '/api/v1/audit-sinks/0'), params(0))).status).toBe(404);
    expect((await testSink(req('POST', '/api/v1/audit-sinks/999/test'), params(999))).status).toBe(404);
  });

  it('merges config on update', async () => {
    const { id } = await (await createSink(req('POST', '/api/v1/audit-sinks', { name: 'L', type: 'syslog', config: { host: 'logs.example.com', port: 1514, protocol: 'tcp' } }))).json();
    const response = await updateSink(req('PUT', `/api/v1/audit-sinks/${id}`, { config: { facility: 4 } }), params(id));
    expect(response.status).toBe(200);
    expect((await response.json()).config).toEqual({ host: 'logs.example.com', port: 1514, protocol: 'tcp', facility: 4, caPem: null });
  });

  it.each([
    [{ days: -1 }], [{ days: 1.5 }], [{ days: '7' }], [{ days: 36501 }], [{}], ['not json'],
  ])('rejects retention %j with 400', async (body) => {
    const response = await putRetention(req('PUT', '/api/v1/audit-log/retention', typeof body === 'string' ? '{' : body));
    expect(response.status).toBe(400);
  });

  it.each([
    ['format=xml'], ['from=yesterday'], ['from=2026-10-02&to=2026-10-01'],
  ])('rejects export query %s with 400', async (query) => {
    expect((await exportLog(req('GET', `/api/v1/audit-log/export?${query}`))).status).toBe(400);
  });
});

describe('OpenAPI', () => {
  it('documents every endpoint and resolves every reference', async () => {
    const spec = await (await getOpenApi(req('GET', '/api/v1/openapi.json'))).json();
    expect(spec.tags.map((tag: { name: string }) => tag.name)).toContain('Audit Streaming');
    const expected: Record<string, string[]> = {
      '/api/v1/audit-log/export': ['get'],
      '/api/v1/audit-log/verify': ['get'],
      '/api/v1/audit-log/retention': ['get', 'put'],
      '/api/v1/audit-sinks': ['get', 'post'],
      '/api/v1/audit-sinks/{id}': ['get', 'put', 'delete'],
      '/api/v1/audit-sinks/{id}/test': ['post'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(spec.paths[path]).sort()).toEqual([...methods].sort());
      for (const method of methods) expect(spec.paths[path][method].tags).toEqual(['Audit Streaming']);
    }
    const docs = JSON.stringify({
      paths: Object.fromEntries(Object.keys(expected).map((path) => [path, spec.paths[path]])),
      schemas: ['AuditSink', 'AuditSinkInput', 'AuditSinkUpdate', 'AuditVerification', 'AuditLogExport', 'AuditRetention']
        .map((name) => spec.components.schemas[name]),
    });
    const refs = docs.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], spec), ref).toBeDefined();
    }
  });
});
