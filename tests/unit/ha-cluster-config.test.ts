/**
 * The dashboard cluster's environment configuration
 * (ee/high-availability/cluster/config.ts): off unless HA_ENABLED is set,
 * refusing to start on anything incomplete or unsafe, and shown without
 * secrets.
 */
import { describe, expect, it } from 'vitest';
import { HaConfigError, isHaEnabled, parseHaConfig, resolveDatabasePath, toClusterConfigView } from '@/ee/high-availability/cluster/config';

const BASE = {
  HA_ENABLED: 'true',
  HA_NODE_ID: 'web-1',
  HA_REDIS_ADDRESSES: 'valkey.example.com:6379',
  HA_REDIS_PASSWORD: 'redis-password-sentinel-1',
  HA_S3_BUCKET: 'ingressi-ha',
  HA_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  HA_S3_SECRET_ACCESS_KEY: 's3-secret-sentinel-2',
  DATABASE_PATH: '/app/data/ingressi.db',
};

function parse(overrides: Record<string, string | undefined> = {}) {
  return parseHaConfig({ ...BASE, ...overrides });
}

describe('parseHaConfig', () => {
  it('is off without HA_ENABLED, whatever else is set', () => {
    expect(parseHaConfig({ ...BASE, HA_ENABLED: undefined })).toBeNull();
    expect(parseHaConfig({ ...BASE, HA_ENABLED: 'false' })).toBeNull();
    expect(isHaEnabled({})).toBe(false);
    expect(isHaEnabled({ HA_ENABLED: 'yes' })).toBe(true);
    expect(isHaEnabled({ HA_ENABLED: 'maybe' })).toBe(false);
  });

  it('reads a complete configuration with its defaults', () => {
    const config = parse()!;
    expect(config).toMatchObject({
      nodeId: 'web-1',
      leaseTtlMs: 15_000,
      syncIntervalSeconds: 1,
      followIntervalSeconds: 5,
      databasePath: '/app/data/ingressi.db',
      haDir: '/app/data/ha',
      recoverFromLocal: false,
      litestreamBin: 'litestream',
    });
    expect(config.redis).toMatchObject({ mode: 'standalone', addresses: ['valkey.example.com:6379'], db: 0, keyPrefix: 'ingressi-ha' });
    // AWS S3 without an endpoint: the regional endpoint for the dashboard's own requests, virtual-hosted style.
    expect(config.storage).toMatchObject({
      endpoint: null,
      apiEndpoint: 'https://s3.us-east-1.amazonaws.com',
      region: 'us-east-1',
      path: 'ingressi',
      forcePathStyle: false,
    });
  });

  it('uses path-style addressing with an endpoint (MinIO, R2) unless told otherwise', () => {
    expect(parse({ HA_S3_ENDPOINT: 'http://minio:9000' })!.storage).toMatchObject({
      endpoint: 'http://minio:9000',
      apiEndpoint: 'http://minio:9000',
      forcePathStyle: true,
    });
    const r2 = parse({ HA_S3_ENDPOINT: 'https://r2.example.com', HA_S3_REGION: 'auto', HA_S3_FORCE_PATH_STYLE: 'false' })!;
    expect(r2.storage).toMatchObject({ region: 'auto', forcePathStyle: false });
  });

  it('refuses to start when HA is on but something is missing or not valid', () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ HA_REDIS_ADDRESSES: undefined }, /HA_REDIS_ADDRESSES is required/],
      [{ HA_S3_BUCKET: undefined }, /HA_S3_BUCKET is required/],
      [{ HA_S3_SECRET_ACCESS_KEY: '' }, /HA_S3_SECRET_ACCESS_KEY is required/],
      [{ HA_REDIS_ADDRESSES: 'a.example.com:6379,b.example.com:6379' }, /exactly one server/],
      [{ HA_REDIS_MODE: 'sentinel', HA_REDIS_ADDRESSES: 'a.example.com:26379' }, /HA_REDIS_MASTER_NAME is required/],
      [{ HA_REDIS_MODE: 'cluster', HA_REDIS_DB: '2' }, /must be 0 in the cluster mode/],
      [{ HA_REDIS_ADDRESSES: 'valkey.example.com' }, /host:port/],
      [{ HA_LEASE_TTL_SECONDS: '2' }, /from 5 to 300/],
      [{ HA_S3_BUCKET: 'Not_A_Bucket' }, /bucket name/],
      [{ HA_S3_PATH: 'a/../b' }, /HA_S3_PATH/],
      [{ HA_S3_ENDPOINT: 'https://user:pass@s3.example.com' }, /origin only/],
      [{ HA_S3_ENDPOINT: 'ftp://s3.example.com' }, /https or http/],
      [{ HA_NODE_ID: 'node one' }, /HA_NODE_ID/],
      [{ HA_ENABLED: 'true', DATABASE_PATH: undefined, DATABASE_URL: ':memory:' }, /must not be :memory:/],
      [{ INSTANCE_MODE: 'slave' }, /sync slave/],
      [{ HA_REDIS_KEY_PREFIX: 'a/{b}' }, /HA_REDIS_KEY_PREFIX/],
    ];
    for (const [overrides, message] of cases) {
      expect(() => parse(overrides), JSON.stringify(overrides)).toThrow(HaConfigError);
      expect(() => parse(overrides), JSON.stringify(overrides)).toThrow(message);
    }
  });

  it('never puts a secret in an error message', () => {
    try {
      parse({ HA_REDIS_PASSWORD: 'line\nbreak-secret' });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('break-secret');
    }
  });

  it('resolves the database file like the dashboard does', () => {
    expect(resolveDatabasePath({ DATABASE_URL: 'file:/srv/ingressi/db.sqlite' })).toBe('/srv/ingressi/db.sqlite');
    expect(resolveDatabasePath({ DATABASE_URL: 'file:///srv/ingressi/db.sqlite' })).toBe('/srv/ingressi/db.sqlite');
    expect(resolveDatabasePath({})).toBe('/app/data/ingressi.db');
  });
});

describe('toClusterConfigView', () => {
  it('shows the configuration without any secret', () => {
    const view = toClusterConfigView(parse({ HA_S3_ENDPOINT: 'http://minio:9000', HA_REDIS_KEY_PREFIX: 'ha/eu-west' })!);
    expect(view).toEqual({
      redis: { mode: 'standalone', addresses: ['valkey.example.com:6379'], keyPrefix: 'ha/eu-west', tls: false, hasPassword: true },
      storage: { endpoint: 'http://minio:9000', region: 'us-east-1', bucket: 'ingressi-ha', path: 'ingressi' },
      leaseTtlSeconds: 15,
      syncIntervalSeconds: 1,
      followIntervalSeconds: 5,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain('redis-password-sentinel-1');
    expect(text).not.toContain('s3-secret-sentinel-2');
    expect(text).not.toContain('AKIAEXAMPLE');
  });
});
