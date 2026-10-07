/**
 * Audit streaming delivery (ee/audit): webhook, Splunk HEC and syslog over
 * UDP, TCP and TLS against real local receivers, the worker's cursor and
 * backoff, and secret storage.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { eq } from 'drizzle-orm';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

vi.mock('@/src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import * as schema from '@/src/lib/db/schema';
import { insertAuditEvent } from '@/src/lib/audit-chain';
import { isEncryptedSecret, decryptSecret } from '@/src/lib/secret';
import { createAuditSink, getAuditSink, listAuditSinks, testAuditSink, updateAuditSink } from '@/ee/audit/sinks';
import { backoffDelayMs, runAuditStreamingTick } from '@/ee/audit/worker';
import {
  buildSplunkPayload,
  formatSyslogMessage,
  frameOctetCounting,
  splunkEventEndpoint,
  SYSLOG_SD_ID,
  testStreamEvent,
} from '@/ee/audit/delivery';
import { createSelfSignedServerCertificate } from '../helpers/certs';

const WEBHOOK_SECRET = 'whsec-0123456789abcdef';

type Received = { path: string; headers: IncomingMessage['headers']; body: string };

let http: Server;
let httpUrl: string;
let received: Received[] = [];
let respondWith = 200;

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.statusCode = respondWith;
      res.end(respondWith === 200 ? '{"text":"Success","code":0}' : 'secret upstream detail');
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

beforeEach(async () => {
  received = [];
  respondWith = 200;
  await ctx.db.delete(schema.auditSinks);
  await ctx.db.delete(schema.auditEvents);
  await ctx.db.delete(schema.settings);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seed(count: number, prefix = 'event') {
  for (let i = 0; i < count; i++) await insertAuditEvent({ action: `${prefix}_${i}`, entityType: 'proxy_host', entityId: i, summary: `${prefix} ${i}` });
}

async function sinkRow(id: number) {
  const [row] = await ctx.db.select().from(schema.auditSinks).where(eq(schema.auditSinks.id, id));
  return row;
}

async function webhookSink(extra: Record<string, unknown> = {}) {
  return createAuditSink({ name: 'SIEM', type: 'webhook', config: { url: `${httpUrl}/ingest` }, secret: WEBHOOK_SECRET, ...extra }, 1);
}

describe('webhook delivery', () => {
  it('starts after the newest event, then delivers new events signed with the secret', async () => {
    await seed(3, 'before');
    const sink = await webhookSink();
    expect(sink.lastDeliveredId).toBeGreaterThan(0);
    await seed(2, 'after');

    const result = await runAuditStreamingTick();
    expect(result).toMatchObject({ delivered: 2, failed: 0 });
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request.path).toBe('/ingest');
    expect(request.headers['content-type']).toBe('application/json');
    const timestamp = request.headers['x-ingressi-timestamp'] as string;
    expect(timestamp).toMatch(/^\d+$/);
    const expected = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${request.body}`).digest('hex')}`;
    expect(request.headers['x-ingressi-signature']).toBe(expected);
    const { events } = JSON.parse(request.body);
    expect(events.map((event: { action: string }) => event.action)).toEqual(['after_0', 'after_1']);
    expect(events[0]).toMatchObject({ entityType: 'proxy_host', source: 'ingressi' });
    expect(events[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[1].prevHash).toBe(events[0].hash);

    const row = await sinkRow(sink.id);
    expect(row.lastDeliveredId).toBe(events[1].id);
    expect(row.lastDeliveryAt).not.toBeNull();
    expect((await getAuditSink(sink.id)).pendingEvents).toBe(0);

    // Nothing new: nothing sent.
    await runAuditStreamingTick();
    expect(received).toHaveLength(1);
  });

  it('backfills on request, in batches of at most 100', async () => {
    await seed(250);
    await webhookSink({ backfill: true });
    const result = await runAuditStreamingTick();
    expect(result?.delivered).toBe(250);
    expect(received.map((request) => JSON.parse(request.body).events.length)).toEqual([100, 100, 50]);
  });

  it('keeps the cursor on failure, backs off, and redelivers once the receiver recovers', async () => {
    const sink = await webhookSink();
    await seed(2);
    respondWith = 500;
    const start = new Date();
    const failed = await runAuditStreamingTick(() => start);
    expect(failed).toMatchObject({ delivered: 0, failed: 1 });
    let row = await sinkRow(sink.id);
    expect(row.lastDeliveredId).toBe(sink.lastDeliveredId);
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastError).toBe('HTTP 500 from the receiver');
    expect(row.lastError).not.toContain('secret upstream detail');
    expect(Date.parse(row.nextAttemptAt!)).toBe(start.getTime() + backoffDelayMs(1));

    // Within the backoff window the sink is skipped.
    respondWith = 200;
    received = [];
    await runAuditStreamingTick(() => new Date(start.getTime() + 1000));
    expect(received).toHaveLength(0);

    // After it, the same events are delivered (at least once).
    const later = await runAuditStreamingTick(() => new Date(start.getTime() + backoffDelayMs(1) + 1));
    expect(later).toMatchObject({ delivered: 2, failed: 0 });
    row = await sinkRow(sink.id);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastDeliveredId).toBeGreaterThan(sink.lastDeliveredId);
  });

  it('backs off exponentially up to 30 minutes', () => {
    expect([1, 2, 3, 4].map(backoffDelayMs)).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(backoffDelayMs(50)).toBe(30 * 60_000);
    expect(backoffDelayMs(0)).toBe(0);
  });

  it('reports a refused connection without details from the peer', async () => {
    const closed = createTcpServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const sink = await createAuditSink({ name: 'Down', type: 'webhook', config: { url: `http://127.0.0.1:${port}/` }, secret: WEBHOOK_SECRET }, 1);
    const result = await testAuditSink(sink.id, 1);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Connection failed (ECONNREFUSED)');
  });

  it('skips disabled sinks', async () => {
    await webhookSink({ enabled: false });
    await seed(1);
    expect(await runAuditStreamingTick()).toMatchObject({ sinks: 0, delivered: 0 });
    expect(received).toHaveLength(0);
  });

  it('sends a test event without moving the cursor', async () => {
    const sink = await webhookSink();
    const result = await testAuditSink(sink.id, 1);
    expect(result).toMatchObject({ ok: true, error: null });
    const { events } = JSON.parse(received[0].body);
    expect(events[0]).toMatchObject({ id: 0, test: true, action: 'audit_sink_test', entityId: sink.id });
    expect((await sinkRow(sink.id)).lastDeliveredId).toBe(sink.lastDeliveredId);
  });
});

describe('secrets', () => {
  it('stores the secret encrypted and never returns it', async () => {
    const sink = await webhookSink();
    const row = await sinkRow(sink.id);
    expect(isEncryptedSecret(row.secret!)).toBe(true);
    expect(decryptSecret(row.secret!)).toBe(WEBHOOK_SECRET);
    for (const view of [sink, await getAuditSink(sink.id), ...(await listAuditSinks())]) {
      expect(view.hasSecret).toBe(true);
      expect(JSON.stringify(view)).not.toContain(WEBHOOK_SECRET);
      expect(view).not.toHaveProperty('secret');
    }
  });

  it('keeps the secret when an update leaves it out and replaces it when given', async () => {
    const sink = await webhookSink();
    const before = (await sinkRow(sink.id)).secret;
    await updateAuditSink(sink.id, { name: 'Renamed' }, 1);
    expect((await sinkRow(sink.id)).secret).toBe(before);
    await updateAuditSink(sink.id, { secret: 'another-secret-0123456789' }, 1);
    expect(decryptSecret((await sinkRow(sink.id)).secret!)).toBe('another-secret-0123456789');
  });
});

describe('Splunk HEC', () => {
  it('posts newline-delimited events to the collector with the token', async () => {
    const sink = await createAuditSink({
      name: 'Splunk', type: 'splunk_hec', config: { url: httpUrl, index: 'audit' }, secret: 'hec-token-123',
    }, 1);
    await seed(2);
    await runAuditStreamingTick();
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/services/collector/event');
    expect(received[0].headers.authorization).toBe('Splunk hec-token-123');
    const lines = received[0].body.split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ sourcetype: 'ingressi:audit', index: 'audit', source: 'ingressi', event: { action: 'event_0' } });
    expect(typeof lines[0].time).toBe('number');
    expect((await sinkRow(sink.id)).consecutiveFailures).toBe(0);
  });

  it('builds the collector endpoint from a base URL or a full one', () => {
    expect(splunkEventEndpoint('https://splunk.example.com:8088')).toBe('https://splunk.example.com:8088/services/collector/event');
    expect(splunkEventEndpoint('https://splunk.example.com:8088/services/collector/')).toBe('https://splunk.example.com:8088/services/collector/event');
    expect(splunkEventEndpoint('https://splunk.example.com/services/collector/event')).toBe('https://splunk.example.com/services/collector/event');
    expect(buildSplunkPayload([testStreamEvent(1)], { url: 'https://x.example.com', index: null })).not.toContain('"index"');
  });
});

describe('syslog', () => {
  it('formats RFC 5424 with structured data and an ASCII JSON message', () => {
    const event = { ...testStreamEvent(4, new Date('2026-10-02T10:00:00.000Z'), 'node-1'), action: 'a"b]c', summary: 'Café ✓' };
    const message = formatSyslogMessage(event, { facility: 13 });
    expect(message.startsWith(`<109>1 2026-10-02T10:00:00.000Z node-1 ingressi ${process.pid} audit [${SYSLOG_SD_ID} id="0" action="a\\"b\\]c" entityType="audit_sink" entityId="4"] {`)).toBe(true);
    expect(/^[\x20-\x7e]*$/.test(message)).toBe(true);
    const json = JSON.parse(message.slice(message.indexOf('] {') + 2));
    expect(json.summary).toBe('Café ✓');
    expect(frameOctetCounting('héllo')).toBe('6 héllo');
  });

  it('sends one datagram per event over UDP', async () => {
    const socket: UdpSocket = createSocket('udp4');
    const messages: string[] = [];
    socket.on('message', (msg) => messages.push(msg.toString('utf8')));
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    try {
      await createAuditSink({ name: 'UDP', type: 'syslog', config: { host: '127.0.0.1', port: socket.address().port, protocol: 'udp' } }, 1);
      await seed(2);
      expect(await runAuditStreamingTick()).toMatchObject({ delivered: 2, failed: 0 });
      await vi.waitFor(() => expect(messages).toHaveLength(2));
      expect(messages[0]).toMatch(/^<109>1 \S+ \S+ ingressi \d+ audit \[ingressi@32473 id="\d+" action="event_0"/);
    } finally {
      socket.close();
    }
  });

  async function streamReceiver(server: TcpServer, event: 'connection' | 'secureConnection' = 'connection'): Promise<{ port: number; data: () => string }> {
    let data = '';
    server.on(event, (socket) => socket.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, data: () => data };
  }

  function parseOctetFrames(stream: string): string[] {
    const frames: string[] = [];
    let rest = Buffer.from(stream, 'utf8');
    while (rest.length > 0) {
      const space = rest.indexOf(0x20);
      const length = Number(rest.subarray(0, space).toString());
      frames.push(rest.subarray(space + 1, space + 1 + length).toString('utf8'));
      rest = rest.subarray(space + 1 + length);
    }
    return frames;
  }

  it('frames messages with octet counting over TCP', async () => {
    const server = createTcpServer();
    const receiver = await streamReceiver(server);
    try {
      await createAuditSink({ name: 'TCP', type: 'syslog', config: { host: '127.0.0.1', port: receiver.port, protocol: 'tcp' } }, 1);
      await seed(3);
      expect(await runAuditStreamingTick()).toMatchObject({ delivered: 3, failed: 0 });
      await vi.waitFor(() => expect(parseOctetFrames(receiver.data())).toHaveLength(3));
      expect(parseOctetFrames(receiver.data()).every((frame) => frame.startsWith('<109>1 '))).toBe(true);
    } finally {
      server.close();
    }
  });

  it('verifies the receiver certificate over TLS against the configured CA', { timeout: 20_000 }, async () => {
    const { certificatePem, privateKeyPem } = createSelfSignedServerCertificate('localhost', ['localhost']);
    const server = createTlsServer({ cert: certificatePem, key: privateKeyPem });
    const receiver = await streamReceiver(server, 'secureConnection');
    try {
      const untrusted = await createAuditSink({ name: 'TLS untrusted', type: 'syslog', config: { host: 'localhost', port: receiver.port, protocol: 'tls' } }, 1);
      const refused = await testAuditSink(untrusted.id, 1);
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/^Connection failed \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)$/);

      const trusted = await createAuditSink({
        name: 'TLS', type: 'syslog', config: { host: 'localhost', port: receiver.port, protocol: 'tls', caPem: certificatePem },
      }, 1);
      expect(await testAuditSink(trusted.id, 1)).toMatchObject({ ok: true, error: null });
      await vi.waitFor(() => expect(parseOctetFrames(receiver.data())[0]).toContain('action="audit_sink_test"'));
    } finally {
      server.close();
    }
  });
});
