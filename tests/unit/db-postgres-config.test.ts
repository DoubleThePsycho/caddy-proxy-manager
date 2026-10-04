/**
 * PostgreSQL configuration and the parts of its start-up that need no
 * server (src/lib/db/postgres.ts, src/lib/db/pg-startup.ts): the pool
 * settings read from the environment (TLS modes, pool size, per-session
 * settings), the type parsers that make rows look as on SQLite, the version
 * and collation checks, and the refusal of HA_ENABLED with PostgreSQL (D15).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_NAME,
  DEFAULT_POOL_MAX,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  LOCK_TIMEOUT_MS,
  parseTimestamp,
  PG_TYPES,
  PostgresConfigError,
  readPostgresConfig,
  STATEMENT_TIMEOUT_MS,
} from '../../src/lib/db/postgres';
import {
  newestMigrationWhen,
  postgresCompatibilityProblems,
  type PostgresDatabaseFacts,
} from '../../src/lib/db/pg-startup';
import { HA_WITH_POSTGRES_MESSAGE, HaConfigError, parseHaConfig } from '../../ee/high-availability/cluster/config';
import { runDatabaseStartup } from '../../src/lib/db/startup';
import journal from '../../drizzle-pg/meta/_journal.json';

const URL_WITH_SECRET = 'postgres://ingressi:s3cret-password@db.example.com:5432/ingressi';
const dir = mkdtempSync(join(tmpdir(), 'ingressi-pg-config-'));
const caFile = join(dir, 'ca.pem');
writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----\n');

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
});

function config(url: string, env: Record<string, string> = {}) {
  return readPostgresConfig({ DATABASE_URL: url, ...env });
}

/** The TLS options of a configuration, as a plain record. */
function tls(settings: pg.PoolConfig): Record<string, unknown> {
  return settings.ssl as unknown as Record<string, unknown>;
}

function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
}

describe('the pool configuration', () => {
  it('sets the pool size and the settings of every session', () => {
    const settings = config(URL_WITH_SECRET);
    expect(settings).toMatchObject({
      max: DEFAULT_POOL_MAX,
      application_name: APPLICATION_NAME,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
      ssl: false,
      types: PG_TYPES,
    });
    expect(settings.options).toBe('-c TimeZone=UTC -c DateStyle=ISO');
    expect(settings.connectionString).toBe(URL_WITH_SECRET);
    expect(config(URL_WITH_SECRET, { DATABASE_POOL_MAX: '25' }).max).toBe(25);
    for (const bad of ['1', '0', '-3', '2.5', 'many', '5000']) {
      expect(failure(() => config(URL_WITH_SECRET, { DATABASE_POOL_MAX: bad }))).toBeInstanceOf(PostgresConfigError);
    }
  });

  it('keeps options from the URL next to its own', () => {
    const settings = config(`${URL_WITH_SECRET}?options=-c%20search_path%3Dapp&application_name=custom`);
    expect(settings.options).toBe('-c search_path=app -c TimeZone=UTC -c DateStyle=ISO');
    expect(settings.connectionString).toBe(`${URL_WITH_SECRET}?application_name=custom`);
  });

  it('refuses a missing or unusable URL without repeating it', () => {
    expect(failure(() => readPostgresConfig({}))).toBeInstanceOf(PostgresConfigError);
    const notUrl = failure(() => config('postgres://ingressi:s3cret-password@[bad'));
    expect(notUrl).toBeInstanceOf(PostgresConfigError);
    expect(notUrl.message).not.toContain('s3cret');
    expect(failure(() => config('mysql://db.example.com/x')).message).toMatch(/postgres:\/\//);
  });

  it('reads sslmode as libpq does and takes TLS settings out of the URL', () => {
    expect(config(`${URL_WITH_SECRET}?sslmode=disable`).ssl).toBe(false);

    const require = config(`${URL_WITH_SECRET}?sslmode=require`);
    expect(require.ssl).toEqual({ rejectUnauthorized: false });
    expect(require.connectionString).toBe(URL_WITH_SECRET);

    // require with a root certificate verifies the chain (as verify-ca).
    const requireWithCa = config(`${URL_WITH_SECRET}?sslmode=require`, { DATABASE_SSL_CA_FILE: caFile });
    expect(requireWithCa.ssl).toMatchObject({ rejectUnauthorized: true, ca: expect.stringContaining('BEGIN CERTIFICATE') });
    expect(typeof tls(requireWithCa).checkServerIdentity).toBe('function');

    const verifyCa = config(`${URL_WITH_SECRET}?sslmode=verify-ca&sslrootcert=${encodeURIComponent(caFile)}`);
    expect(verifyCa.ssl).toMatchObject({ rejectUnauthorized: true, ca: expect.any(String) });
    expect((tls(verifyCa).checkServerIdentity as () => unknown)()).toBeUndefined();
    expect(verifyCa.connectionString).toBe(URL_WITH_SECRET);

    const verifyFull = config(`${URL_WITH_SECRET}?sslmode=verify-full`);
    expect(verifyFull.ssl).toEqual({ rejectUnauthorized: true });

    // A CA file alone means verify-full.
    const caOnly = config(URL_WITH_SECRET, { DATABASE_SSL_CA_FILE: caFile });
    expect(caOnly.ssl).toMatchObject({ rejectUnauthorized: true, ca: expect.any(String) });
    expect(tls(caOnly).checkServerIdentity).toBeUndefined();

    const clientCert = config(`${URL_WITH_SECRET}?sslmode=verify-full&sslcert=${encodeURIComponent(caFile)}&sslkey=${encodeURIComponent(caFile)}`);
    expect(clientCert.ssl).toMatchObject({ cert: expect.any(String), key: expect.any(String) });
  });

  it('refuses TLS settings that would not do what they say', () => {
    for (const mode of ['prefer', 'allow']) {
      expect(failure(() => config(`${URL_WITH_SECRET}?sslmode=${mode}`)).message).toMatch(/not supported/);
    }
    expect(failure(() => config(`${URL_WITH_SECRET}?sslmode=sideways`))).toBeInstanceOf(PostgresConfigError);
    expect(failure(() => config(`${URL_WITH_SECRET}?sslmode=disable`, { DATABASE_SSL_CA_FILE: caFile })).message).toMatch(/sslmode=disable/);
    expect(failure(() => config(`${URL_WITH_SECRET}?sslmode=verify-full&sslcert=${encodeURIComponent(caFile)}`)).message).toMatch(/together/);
    const missing = failure(() => config(URL_WITH_SECRET, { DATABASE_SSL_CA_FILE: join(dir, 'missing.pem') }));
    expect(missing.message).toMatch(/^Cannot read the database CA certificate .*\(ENOENT\)$/);
    expect(missing.message).not.toContain(dir);
  });
});

describe('type parsers', () => {
  const parse = (oid: number, text: string) => (PG_TYPES.getTypeParser as (oid: number) => (value: string) => unknown)(oid)(text);
  const { builtins } = pg.types;

  it('read 64-bit integers and numerics as numbers, booleans as booleans', () => {
    expect(parse(builtins.INT8, '9007199254740991')).toBe(9007199254740991);
    expect(parse(builtins.INT8, '-42')).toBe(-42);
    expect(parse(builtins.NUMERIC, '2.50')).toBe(2.5);
    expect(parse(builtins.BOOL, 't')).toBe(true);
    expect(parse(builtins.BOOL, 'f')).toBe(false);
    expect(parse(builtins.INT4, '7')).toBe(7);
    expect(parse(builtins.TEXT, 'text')).toBe('text');
    expect(parse(builtins.DATE, '2026-01-02')).toBe('2026-01-02');
  });

  it('read timestamps as ISO 8601 text in UTC', () => {
    expect(parse(builtins.TIMESTAMPTZ, '2026-01-02 03:04:05.678+02')).toBe('2026-01-02T01:04:05.678Z');
    expect(parseTimestamp('2026-01-02 03:04:05.123456+00')).toBe('2026-01-02T03:04:05.123Z');
    expect(parseTimestamp('2026-01-02 03:04:05+05:30')).toBe('2026-01-01T21:34:05.000Z');
    expect(parseTimestamp('2026-01-02 03:04:05-08')).toBe('2026-01-02T11:04:05.000Z');
    expect(parse(builtins.TIMESTAMP, '2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05.000Z');
    expect(parseTimestamp('0050-06-01 00:00:00+00')).toBe('0050-06-01T00:00:00.000Z');
    expect(parseTimestamp('infinity')).toBe('infinity');
    expect(parseTimestamp('2000-01-01 00:00:00+00 BC')).toBe('2000-01-01 00:00:00+00 BC');
  });
});

describe('start-up checks', () => {
  const good: PostgresDatabaseFacts = {
    databaseName: 'ingressi',
    serverVersionNum: 170002,
    serverVersion: '17.2',
    encoding: 'UTF8',
    collate: 'C',
    ctype: 'C',
    provider: 'c',
    locale: null,
  };

  it('accept PostgreSQL 16 or later with UTF8 and the C collation and classification', () => {
    expect(postgresCompatibilityProblems(good)).toEqual([]);
    expect(postgresCompatibilityProblems({ ...good, serverVersionNum: 160000, serverVersion: '16.0' })).toEqual([]);
    expect(postgresCompatibilityProblems({ ...good, collate: 'POSIX', ctype: 'POSIX' })).toEqual([]);
    expect(postgresCompatibilityProblems({ ...good, provider: 'b', locale: 'C' })).toEqual([]);
  });

  it('refuse an older server, another collation, classification, encoding or provider', () => {
    expect(postgresCompatibilityProblems({ ...good, serverVersionNum: 150008, serverVersion: '15.8' })).toEqual([
      expect.stringMatching(/PostgreSQL 15\.8 is too old: Ingressi needs PostgreSQL 16 or later/),
    ]);
    for (const facts of [
      { collate: 'en_US.UTF-8' },
      { ctype: 'C.UTF-8' },
      { encoding: 'SQL_ASCII' },
      { provider: 'i', locale: 'en-US' },
      { provider: 'b', locale: 'C.UTF-8' },
    ]) {
      const problems = postgresCompatibilityProblems({ ...good, ...facts });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/C collation and character classification/);
      expect(problems[0]).toContain(`CREATE DATABASE "ingressi" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'`);
    }
  });

  it('know the newest PostgreSQL migration', () => {
    expect(newestMigrationWhen()).toBe(Math.max(...journal.entries.map((entry) => entry.when)));
  });
});

describe('high availability with PostgreSQL (D15)', () => {
  it('is refused by the cluster configuration', () => {
    for (const env of [
      { HA_ENABLED: 'true', DATABASE_URL: 'postgres://db.example.com/ingressi' },
      { HA_ENABLED: 'true', DATABASE_DIALECT: 'postgres' },
    ]) {
      const error = failure(() => parseHaConfig(env));
      expect(error).toBeInstanceOf(HaConfigError);
      expect(error.message).toBe(HA_WITH_POSTGRES_MESSAGE);
    }
    expect(parseHaConfig({ DATABASE_URL: 'postgres://db.example.com/ingressi' })).toBeNull();
  });

  it('stops the dashboard at start-up before it connects', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://ingressi@db.example.invalid/ingressi');
    vi.stubEnv('HA_ENABLED', 'true');
    await expect(runDatabaseStartup()).rejects.toThrow(HA_WITH_POSTGRES_MESSAGE);
  });
});
