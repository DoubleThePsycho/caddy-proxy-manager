/**
 * applyCaddyConfig records every attempt for the caddy_apply_failed alert:
 * a rejection, an unreachable admin API and a success.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../helpers/db';

vi.unmock('@/src/lib/caddy');

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb, loadStatus: 200, loadBody: '' }));

vi.mock('../../src/lib/db', async () => {
  const { createTestDb } = await import('../helpers/db');
  ctx.db = createTestDb();
  return (await import('../helpers/db-module')).mockDbModule(() => ctx.db);
});

import { config } from '../../src/lib/config';
import { applyCaddyConfig } from '../../src/lib/caddy';
import { getCaddyApplyStatus, resetCaddyApplyStatusForTests } from '../../src/lib/caddy-apply-status';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url === '/load') {
        response.writeHead(ctx.loadStatus, { 'Content-Type': 'application/json' });
        response.end(ctx.loadBody);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await resetCaddyApplyStatusForTests();
  (config as { caddyApiUrl: string }).caddyApiUrl = baseUrl;
  ctx.loadStatus = 200;
  ctx.loadBody = '';
});

describe('applyCaddyConfig apply status', () => {
  it('records a rejection with its safe message, then clears it on success', async () => {
    ctx.loadStatus = 400;
    ctx.loadBody = '{"error":"request body limit should be at most 1GiB for secret-host.example"}';
    await expect(applyCaddyConfig()).rejects.toMatchObject({ code: 'CADDY_REJECTED' });
    expect(await getCaddyApplyStatus()).toMatchObject({
      ok: false,
      code: 'CADDY_REJECTED',
      message: "Caddy rejected configuration: a WAF request body limit exceeds Coraza's maximum of 1 GiB",
      consecutiveFailures: 1,
    });
    expect(JSON.stringify(await getCaddyApplyStatus())).not.toContain('secret-host');

    ctx.loadStatus = 200;
    await applyCaddyConfig();
    expect(await getCaddyApplyStatus()).toMatchObject({ ok: true, code: null, message: null, consecutiveFailures: 0 });
  });

  it('records an unreachable admin API', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    (config as { caddyApiUrl: string }).caddyApiUrl = `http://127.0.0.1:${port}`;

    await expect(applyCaddyConfig()).rejects.toMatchObject({ code: 'CADDY_UNREACHABLE' });
    await expect(applyCaddyConfig()).rejects.toMatchObject({ code: 'CADDY_UNREACHABLE' });
    expect(await getCaddyApplyStatus()).toMatchObject({ ok: false, code: 'CADDY_UNREACHABLE', message: 'Unable to reach Caddy API', consecutiveFailures: 2 });
  });
});
