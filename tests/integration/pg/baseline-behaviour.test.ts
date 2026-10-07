/**
 * A database built by the PostgreSQL migrations (drizzle-pg/) behaves like a
 * SQLite install: the same statements, run on both, are accepted or refused
 * alike and leave the same values. Covered: the users.disabledAt triggers
 * (drizzle/0047), the forward_auth_access CHECK (drizzle/0017), the groups
 * name index and column defaults. Then what only
 * PostgreSQL does: SQLSTATEs, identity keys given explicit ids, int8 columns
 * and booleans through Drizzle. Runs against a real server; skipped without
 * TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { DatabaseError } from 'pg';
import * as sqliteSchema from '../../../src/lib/db/schema.sqlite';
import * as pgSchema from '../../../src/lib/db/schema.pg';
import { TEST_DATABASE_URL, createPgTestDatabase, migratePgDatabase, type PgTestDatabase } from '../../helpers/pg-database';
import { first } from '@/src/lib/db/ops';

const NOW = '2026-01-01T00:00:00.000Z';
const GIVEN = '2025-12-24T08:00:00.000Z';
const LATER = '2026-02-02T09:30:00.000Z';
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Outcome = 'ok' | `rejected: ${string}`;
type Row = Record<string, unknown>;

/**
 * A migrated in-memory SQLite database as the application runs it: bun:sqlite
 * leaves foreign keys off, better-sqlite3 turns them on unless told otherwise.
 */
function sqliteDatabase(): Database.Database {
  const client = new Database(':memory:');
  client.pragma('foreign_keys = OFF');
  migrateSqlite(drizzleSqlite(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return client;
}

/** One database, SQLite or PostgreSQL, behind the same few calls. */
interface Engine {
  run(statement: string): Promise<Outcome>;
  row(statement: string): Promise<Row | undefined>;
}

function sqliteEngine(client: Database.Database): Engine {
  return {
    async run(statement) {
      try {
        client.prepare(statement).run();
        return 'ok';
      } catch (error) {
        const message = (error as Error).message;
        if (/^CHECK constraint failed/.test(message)) return 'rejected: check';
        if (/^UNIQUE constraint failed/.test(message)) return 'rejected: unique';
        return `rejected: ${message}`;
      }
    },
    async row(statement) {
      return client.prepare(statement).get() as Row | undefined;
    },
  };
}

function pgEngine(database: PgTestDatabase): Engine {
  const { client } = database;
  return {
    async run(statement) {
      try {
        await client.query(statement);
        return 'ok';
      } catch (error) {
        const { code, message } = error as DatabaseError;
        if (code === '23505') return 'rejected: unique';
        if (code === '23514' && /violates check constraint/.test(message)) return 'rejected: check';
        return `rejected: ${message}`;
      }
    },
    async row(statement) {
      return (await client.query<Row>(statement)).rows[0];
    },
  };
}

function literal(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function insert(table: string, values: Record<string, string | number | null>): string {
  const columns = Object.keys(values).map((column) => `"${column}"`).join(', ');
  return `INSERT INTO "${table}" (${columns}) VALUES (${Object.values(values).map(literal).join(', ')})`;
}

function insertUser(email: string, role: string, extra: Record<string, string | null> = {}): string {
  return insert('users', { email, role, createdAt: NOW, updatedAt: NOW, ...extra });
}

/** A disabledAt as the scenarios compare it: null, a value the test gave, or "now" for a fresh timestamp. */
function stamp(value: unknown): unknown {
  if (value === null || value === GIVEN || value === LATER) return value;
  if (typeof value === 'string' && ISO_MILLISECONDS.test(value) && Math.abs(Date.parse(value) - Date.now()) < 10 * 60_000) return 'now';
  return `unexpected ${String(value)}`;
}

async function disabledAt(engine: Engine, email: string): Promise<unknown> {
  return (await engine.row(`SELECT "disabledAt" FROM "users" WHERE "email" = ${literal(email)}`))?.disabledAt;
}

async function disabledAtHistory(engine: Engine) {
  const email = 'carol@example.org';
  const update = async (set: string) => {
    expect(await engine.run(`UPDATE "users" SET ${set} WHERE "email" = ${literal(email)}`)).toBe('ok');
    return stamp(await disabledAt(engine, email));
  };
  expect(await engine.run(insertUser('dave@example.org', 'user', { status: 'disabled' }))).toBe('ok');
  expect(await engine.run(insertUser('erin@example.org', 'user', { status: 'disabled', disabledAt: GIVEN }))).toBe('ok');
  expect(await engine.run(insertUser('frank@example.org', 'user', { status: 'active', disabledAt: GIVEN }))).toBe('ok');
  expect(await engine.run(insertUser(email, 'user'))).toBe('ok');
  const inserted = {
    active: stamp(await disabledAt(engine, email)),
    disabled: stamp(await disabledAt(engine, 'dave@example.org')),
    disabledWithTime: stamp(await disabledAt(engine, 'erin@example.org')),
    activeWithTime: stamp(await disabledAt(engine, 'frank@example.org')),
  };
  const disabled = await update(`"status" = 'disabled'`);
  const since = await disabledAt(engine, email);
  await update(`"name" = 'Carol', "status" = 'disabled'`);
  const keptWhileDisabled = (await disabledAt(engine, email)) === since;
  return {
    inserted,
    disabled,
    keptWhileDisabled,
    setDirectly: await update(`"disabledAt" = ${literal(GIVEN)}`),
    givenWhileStatusStays: await update(`"status" = 'disabled', "disabledAt" = ${literal(LATER)}`),
    enabled: await update(`"status" = 'active'`),
    disabledAgainOverridingGiven: await update(`"status" = 'disabled', "disabledAt" = ${literal(GIVEN)}`),
    enabledOverridingGiven: await update(`"status" = 'active', "disabledAt" = ${literal(GIVEN)}`),
  };
}

async function forwardAuthAccess(engine: Engine) {
  const grant = (values: Record<string, number | null>) => engine.run(insert('forward_auth_access', { ...values, createdAt: NOW }));
  return {
    user: await grant({ proxyHostId: 1, userId: 1 }),
    group: await grant({ proxyHostId: 1, groupId: 1 }),
    both: await grant({ proxyHostId: 2, userId: 1, groupId: 1 }),
    neither: await grant({ proxyHostId: 2 }),
    addGroupToUserGrant: await engine.run(`UPDATE "forward_auth_access" SET "groupId" = 5 WHERE "userId" = 1`),
    // Turns the user grant into a second grant of host 1 to group 1.
    swapUserForGrantedGroup: await engine.run(`UPDATE "forward_auth_access" SET "groupId" = 1, "userId" = NULL WHERE "userId" = 1`),
  };
}

async function groupNames(engine: Engine) {
  const group = (name: string) => engine.run(insert('groups', { name, createdAt: NOW, updatedAt: NOW }));
  return {
    first: await group('Admins'),
    again: await group('Admins'),
    otherCase: await group('admins'),
    trailingSpace: await group('Admins '),
  };
}

async function userDefaults(engine: Engine) {
  expect(await engine.run(insert('users', { email: 'grace@example.org', createdAt: NOW, updatedAt: NOW }))).toBe('ok');
  const row = await engine.row(
    `SELECT "provider", "subject", "role", "status", "emailVerified", "twoFactorEnabled", "disabledAt" FROM "users" WHERE "email" = 'grace@example.org'`
  );
  // SQLite stores booleans as 0/1.
  return { ...row, emailVerified: row?.emailVerified === true || row?.emailVerified === 1, twoFactorEnabled: row?.twoFactorEnabled === true || row?.twoFactorEnabled === 1 };
}

const EXPECTED = {
  disabledAtHistory: {
    inserted: { active: null, disabled: 'now', disabledWithTime: GIVEN, activeWithTime: GIVEN },
    disabled: 'now',
    keptWhileDisabled: true,
    setDirectly: GIVEN,
    givenWhileStatusStays: LATER,
    enabled: null,
    disabledAgainOverridingGiven: 'now',
    enabledOverridingGiven: null,
  },
  forwardAuthAccess: {
    user: 'ok',
    group: 'ok',
    both: 'rejected: check',
    neither: 'rejected: check',
    addGroupToUserGrant: 'rejected: check',
    swapUserForGrantedGroup: 'rejected: unique',
  },
  groupNames: {
    first: 'ok',
    again: 'rejected: unique',
    otherCase: 'ok',
    trailingSpace: 'ok',
  },
  userDefaults: {
    provider: '',
    subject: '',
    role: 'user',
    status: 'active',
    emailVerified: false,
    twoFactorEnabled: false,
    disabledAt: null,
  },
};

async function scenarios(engine: Engine) {
  return {
    disabledAtHistory: await disabledAtHistory(engine),
    forwardAuthAccess: await forwardAuthAccess(engine),
    groupNames: await groupNames(engine),
    userDefaults: await userDefaults(engine),
  };
}

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL baseline behaviour', () => {
  let database: PgTestDatabase;

  beforeAll(async () => {
    database = await createPgTestDatabase('behaviour');
    await migratePgDatabase(database.client);
  });

  afterAll(async () => {
    await database?.drop();
  });

  describe('like a SQLite install', () => {
    it('on SQLite (drizzle/), the reference', async () => {
      const client = sqliteDatabase();
      try {
        expect(await scenarios(sqliteEngine(client))).toEqual(EXPECTED);
      } finally {
        client.close();
      }
    });

    it('on PostgreSQL (drizzle-pg/)', async () => {
      expect(await scenarios(pgEngine(database))).toEqual(EXPECTED);
    });

    it('stores what Drizzle leaves out the same way on both', async () => {
      const client = sqliteDatabase();
      const values = { email: 'heidi@example.org', createdAt: NOW, updatedAt: NOW };
      const onSqlite = (await first(drizzleSqlite(client).insert(sqliteSchema.users).values(values).returning()))!;
      client.close();
      const [onPg] = await drizzlePg(database.client).insert(pgSchema.users).values(values).returning();
      const { id: sqliteId, ...sqliteRow } = onSqlite;
      const { id: pgId, ...pgRow } = onPg;
      expect(pgRow).toEqual(sqliteRow);
      expect(pgRow).toMatchObject({ provider: '', subject: '', role: 'user', emailVerified: false, disabledAt: null });
      expect([typeof sqliteId, typeof pgId]).toEqual(['number', 'number']);
    });
  });

  /** The SQLSTATE, constraint and message of a statement that must fail. */
  async function failure(statement: string) {
    try {
      await database.client.query(statement);
    } catch (error) {
      const { code, constraint, message } = error as DatabaseError;
      return { code, constraint, message };
    }
    throw new Error(`${statement} succeeded`);
  }

  describe('PostgreSQL errors', () => {
    it('names the CHECK and the unique index a write breaks', async () => {
      expect(await failure(insert('forward_auth_access', { proxyHostId: 9, createdAt: NOW }))).toMatchObject({
        code: '23514',
        constraint: 'forward_auth_access_user_or_group_check',
      });
      await database.client.query(insert('groups', { name: 'Operators', createdAt: NOW, updatedAt: NOW }));
      expect(await failure(insert('groups', { name: 'Operators', createdAt: NOW, updatedAt: NOW }))).toMatchObject({
        code: '23505',
        constraint: 'groups_name_unique',
      });
    });
  });

  describe('identity keys', () => {
    const token = (id: number | null, name: string) =>
      insert('api_tokens', { ...(id === null ? {} : { id }), name, tokenHash: `hash-${name}`, createdBy: 1, createdAt: NOW });

    it('accept explicit ids, which the sequence does not see until it is resynchronised', async () => {
      const { client } = database;
      await client.query(token(1, 'one'));
      await client.query(token(3, 'three'));
      // SQLite would continue after the largest id; PostgreSQL's sequence
      // still starts at 1 (src/lib/db/ops.ts resyncIdentity() after explicit ids).
      expect(await failure(token(null, 'next'))).toMatchObject({ code: '23505', constraint: 'api_tokens_pkey' });
      await client.query(`SELECT setval(pg_get_serial_sequence('"api_tokens"', 'id'), (SELECT max("id") FROM "api_tokens"))`);
      const { rows } = await client.query<{ id: number }>(`${token(null, 'after')} RETURNING "id"`);
      expect(rows).toEqual([{ id: 4 }]);
    });

    it('are int4, like the application assumes', async () => {
      expect(await failure(token(2_147_483_648, 'too-large'))).toMatchObject({ code: '22003' });
      const { rows } = await database.client.query<{ max: string }>(
        `SELECT seqmax::text AS max FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('"api_tokens"', 'id')::regclass`
      );
      expect(rows).toEqual([{ max: '2147483647' }]);
    });
  });

  describe('through Drizzle', () => {
    it('reads int8 columns beyond 2^31 as numbers', async () => {
      const db = drizzlePg(database.client);
      const [run] = await db
        .insert(pgSchema.backupRuns)
        .values({ destinationId: 1, trigger: 'manual', status: 'success', startedAt: NOW, sizeBytes: 5_000_000_000 })
        .returning();
      expect(run.sizeBytes).toBe(5_000_000_000);
      const [read] = await db.select({ sizeBytes: pgSchema.backupRuns.sizeBytes }).from(pgSchema.backupRuns).where(eq(pgSchema.backupRuns.id, run.id));
      expect(read).toEqual({ sizeBytes: 5_000_000_000 });
    });

    it('writes, reads and filters booleans', async () => {
      const db = drizzlePg(database.client);
      const [host] = await db
        .insert(pgSchema.proxyHosts)
        .values({ name: 'Booleans', domains: '["booleans.example.com"]', upstreams: '["app:80"]', enabled: false, createdAt: NOW, updatedAt: NOW })
        .returning();
      expect(host).toMatchObject({ enabled: false, sslForced: true, hstsSubdomains: false, tags: '[]' });
      const disabled = await db
        .select({ id: pgSchema.proxyHosts.id })
        .from(pgSchema.proxyHosts)
        .where(eq(pgSchema.proxyHosts.enabled, false));
      expect(disabled).toEqual([{ id: host.id }]);
    });
  });
});
