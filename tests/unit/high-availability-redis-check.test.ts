/**
 * The certificate storage connection test (ee/high-availability/redis-check.ts)
 * against a fake RESP server: the steps it runs in each mode, what it
 * reports, and that nothing a server sends is ever shown.
 */
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { startFakeRedis, type FakeRedis } from '../helpers/fake-redis';
import { encryptUnderOtherSecret } from '../helpers/encrypt-under-other-secret';
import { encryptSecret } from '@/src/lib/secret';
import { testRedisStorage } from '@/ee/high-availability/redis-check';
import type { StoredRedisStorage } from '@/ee/high-availability/types';

const servers: FakeRedis[] = [];
async function server(options: Parameters<typeof startFakeRedis>[0] = {}) {
  const started = await startFakeRedis(options);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((started) => started.close()));
});

function redis(overrides: Partial<StoredRedisStorage>): StoredRedisStorage {
  return {
    mode: 'standalone',
    addresses: ['127.0.0.1:1'],
    db: 0,
    keyPrefix: 'caddy/test',
    tls: { enabled: false, insecureSkipVerify: false },
    ...overrides,
  };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('testRedisStorage', () => {
  it('signs in, selects the database, writes, reads back and deletes a key under the prefix', async () => {
    const fake = await server({ password: 'secret-pass', username: 'caddy' });
    const result = await testRedisStorage(
      redis({ addresses: [fake.address], username: 'caddy', password: encryptSecret('secret-pass'), db: 4 })
    );
    expect(result).toMatchObject({ ok: true, complete: true, server: fake.address });
    expect(result.steps.map((step) => step.step)).toEqual(['connect', 'auth', 'select', 'write', 'read', 'delete']);
    const set = fake.commands.find((command) => command[0] === 'SET')!;
    expect(set[1]).toMatch(/^caddy\/test\/\.storage-test\/[0-9a-f-]{36}$/);
    expect(set.slice(3)).toEqual(['PX', '60000', 'NX']);
    expect(fake.commands.find((command) => command[0] === 'AUTH')).toEqual(['AUTH', 'caddy', 'secret-pass']);
    expect(fake.commands.find((command) => command[0] === 'SELECT')).toEqual(['SELECT', '4']);
    expect(fake.store.size).toBe(0);
  });

  it('reports a wrong password and a missing one', async () => {
    const fake = await server({ password: 'secret-pass' });
    const wrong = await testRedisStorage(redis({ addresses: [fake.address], password: encryptSecret('nope') }));
    expect(wrong.ok).toBe(false);
    expect(wrong.steps.at(-1)).toEqual({ step: 'auth', ok: false, detail: 'the user name or password was not accepted' });

    const missing = await testRedisStorage(redis({ addresses: [fake.address] }));
    expect(missing.ok).toBe(false);
    expect(missing.steps.at(-1)).toMatchObject({ step: 'write', ok: false, detail: 'the server needs a password' });
  });

  it('cannot use a password read from the Caddy nodes\' environment, and says so', async () => {
    const fake = await server({ password: 'secret-pass' });
    process.env.CADDY_STORAGE_PASSWORD = 'secret-pass';
    try {
      const result = await testRedisStorage(redis({ addresses: [fake.address], passwordEnv: 'CADDY_STORAGE_PASSWORD' }));
      expect(result).toMatchObject({ ok: true, complete: false });
      expect(result.steps[1].detail).toMatch(/CADDY_STORAGE_PASSWORD on the Caddy nodes/);
      // The web container's own environment is never used for it.
      expect(fake.commands.some((command) => command[0] === 'AUTH')).toBe(false);
    } finally {
      delete process.env.CADDY_STORAGE_PASSWORD;
    }
  });

  it('reports a stored password this instance cannot decrypt', async () => {
    const fake = await server({ password: 'secret-pass' });
    const result = await testRedisStorage(redis({ addresses: [fake.address], password: encryptUnderOtherSecret('secret-pass') }));
    expect(result.steps.at(-1)).toMatchObject({ step: 'auth', ok: false, detail: expect.stringMatching(/cannot be decrypted/) });
  });

  it('asks the Sentinels for the master, signing in to them, then tests the master', async () => {
    const master = await server({ password: 'master-pass' });
    const sentinel = await server({ password: 'sentinel-pass', sentinel: { masterName: 'certs', master: ['127.0.0.1', String(master.port)] } });
    const down = await closedPort();
    const result = await testRedisStorage(
      redis({
        mode: 'sentinel',
        addresses: [`127.0.0.1:${down}`, sentinel.address],
        masterName: 'certs',
        password: encryptSecret('master-pass'),
        sentinelPassword: encryptSecret('sentinel-pass'),
      })
    );
    expect(result).toMatchObject({ ok: true, server: master.address });
    expect(result.steps[0]).toEqual({ step: 'sentinel', ok: true, detail: `Sentinel ${sentinel.address} named the master ${master.address}` });
    expect(sentinel.commands).toEqual([['AUTH', 'sentinel-pass'], ['SENTINEL', 'get-master-addr-by-name', 'certs']]);
  });

  it('reports a master name the Sentinels do not know', async () => {
    const sentinel = await server({ sentinel: { masterName: 'certs', master: ['127.0.0.1', '6379'] } });
    const result = await testRedisStorage(redis({ mode: 'sentinel', addresses: [sentinel.address], masterName: 'other' }));
    expect(result.steps).toEqual([
      { step: 'sentinel', ok: false, detail: `Sentinel ${sentinel.address} does not know a master named other` },
    ]);
  });

  it('follows a cluster redirect and refuses a server without cluster support in cluster mode', async () => {
    const target = await server({ cluster: true });
    const seed = await server({ cluster: true, movedTo: target.address });
    const result = await testRedisStorage(redis({ mode: 'cluster', addresses: [seed.address] }));
    expect(result).toMatchObject({ ok: true, server: target.address });
    expect(target.commands.map((command) => command[0])).toEqual(['SET', 'GET', 'DEL']);

    const plain = await server();
    const refused = await testRedisStorage(redis({ mode: 'cluster', addresses: [plain.address] }));
    expect(refused.steps.at(-1)).toMatchObject({ step: 'connect', ok: false, detail: expect.stringMatching(/cluster support disabled/) });
  });

  it('tells a standalone setup that it reached a cluster node', async () => {
    const node = await server({ cluster: true, movedTo: '127.0.0.1:7001' });
    const result = await testRedisStorage(redis({ addresses: [node.address] }));
    expect(result.steps.at(-1)).toEqual({ step: 'write', ok: false, detail: 'the server is a cluster node: choose the cluster mode' });
  });

  it('never shows what a server sends', async () => {
    const leaky = await server({ errors: { SET: 'ERR internal-banner-with-secret-token-0042' } });
    const result = await testRedisStorage(redis({ addresses: [leaky.address] }));
    expect(result.steps.at(-1)).toEqual({ step: 'write', ok: false, detail: 'the server answered with an error' });

    const http = await server({ raw: 'HTTP/1.1 400 Bad Request\r\nServer: internal-banner-with-secret-token-0042\r\n\r\n' });
    const notRedis = await testRedisStorage(redis({ addresses: [http.address], db: 1 }));
    expect(notRedis.ok).toBe(false);
    expect(notRedis.steps.at(-1)?.detail).toBe('the server did not answer like Redis or Valkey');
    expect(JSON.stringify([result, notRedis])).not.toContain('internal-banner');
  });

  it('reports a server that cannot be reached', async () => {
    const port = await closedPort();
    const result = await testRedisStorage(redis({ addresses: [`127.0.0.1:${port}`] }));
    expect(result).toMatchObject({ ok: false, server: null });
    expect(result.steps).toEqual([{ step: 'connect', ok: false, detail: `127.0.0.1:${port}: connection refused` }]);
  });
});
