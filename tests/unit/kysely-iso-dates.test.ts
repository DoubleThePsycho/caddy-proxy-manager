/**
 * The IsoDatesPlugin (src/lib/db/kysely-iso-dates.ts) that Better Auth's
 * Kysely instance uses on PostgreSQL (D5): Date parameters are sent as the
 * ISO 8601 text the schema stores, and the date columns of the table a
 * query reads, writes or joins come back as Dates, while every other value
 * is left alone. Runs without a database: a recording driver answers with
 * canned rows.
 */
import { describe, expect, it } from 'vitest';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import { getAuthTables } from 'better-auth/db';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { IsoDatesPlugin } from '../../src/lib/db/kysely-iso-dates';
import { authDateColumns } from '../../src/lib/db/auth-database';

const DATE = new Date('2026-03-04T05:06:07.089Z');
const ISO = '2026-03-04T05:06:07.089Z';

/** A dialect whose driver records the compiled queries and answers with `rows`. */
function recordingDatabase(dateColumns: Map<string, Set<string>>, rows: Record<string, unknown>[] = []) {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return { rows: rows.map((row) => ({ ...row })) as R[], numAffectedRows: BigInt(rows.length) };
    },
    streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const dialect: Dialect = {
    createDriver: () => driver,
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
  };
  const db = new Kysely<any>({ dialect, plugins: [new IsoDatesPlugin(dateColumns)] });
  return { db, queries };
}

const COLUMNS = new Map([
  ['sessions', new Set(['expiresAt', 'createdAt', 'updatedAt'])],
  ['users', new Set(['createdAt', 'updatedAt'])],
]);

describe('Date parameters', () => {
  it('are sent as ISO 8601 text in inserts, updates, comparisons, lists and raw SQL', async () => {
    const { db, queries } = recordingDatabase(COLUMNS);
    await db.insertInto('sessions').values({ token: 't', expiresAt: DATE, userId: 1, active: true }).execute();
    await db.insertInto('sessions').values([{ token: 'a', expiresAt: DATE }, { token: 'b', expiresAt: undefined }]).execute();
    await db.updateTable('sessions').set({ expiresAt: DATE, updatedAt: DATE }).where('id', '=', 7).execute();
    await db.selectFrom('sessions').selectAll().where('expiresAt', '<', DATE).execute();
    await db.selectFrom('sessions').selectAll().where('expiresAt', 'in', [DATE, 'x']).execute();
    await sql`select ${DATE} as at`.execute(db);

    expect(queries.map((query) => query.parameters)).toEqual([
      ['t', ISO, 1, true],
      ['a', ISO, 'b'],
      [ISO, ISO, 7],
      [ISO],
      [ISO, 'x'],
      [ISO],
    ]);
    expect(queries.flatMap((query) => query.parameters).some((value) => value instanceof Date)).toBe(false);
  });

  it('are converted on every table, listed or not', async () => {
    const { db, queries } = recordingDatabase(new Map());
    await db.insertInto('audit_events').values({ createdAt: DATE }).execute();
    expect(queries[0].parameters).toEqual([ISO]);
  });

  it('refuses an invalid Date rather than writing it', async () => {
    const { db } = recordingDatabase(COLUMNS);
    await expect(db.insertInto('sessions').values({ expiresAt: new Date(Number.NaN) }).execute()).rejects.toThrow(RangeError);
  });
});

describe('date columns in results', () => {
  const row = { id: 3, token: 'secret', expiresAt: ISO, createdAt: ISO, updatedAt: null, ipAddress: '192.0.2.1' };

  it('come back as Dates for the table a select reads; other columns are untouched', async () => {
    const { db } = recordingDatabase(COLUMNS, [row]);
    const [result] = await db.selectFrom('sessions').selectAll().execute();
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect((result.expiresAt as Date).toISOString()).toBe(ISO);
    expect(result.createdAt).toEqual(DATE);
    expect(result).toMatchObject({ id: 3, token: 'secret', updatedAt: null, ipAddress: '192.0.2.1' });
  });

  it('follow Better Auth\'s derived table and joined columns', async () => {
    const joined = { ...row, _joined_users_createdAt: ISO, _joined_users_email: 'user@example.com' };
    const { db } = recordingDatabase(COLUMNS, [joined]);
    const [result] = await db
      .selectFrom((eb) => eb.selectFrom('sessions').selectAll().as('primary'))
      .selectAll('primary')
      .leftJoin('users as join_users', 'join_users.id', 'primary.userId')
      .select(sql`join_users."createdAt"`.as('_joined_users_createdAt'))
      .execute();
    expect(result.expiresAt).toEqual(DATE);
    expect(result._joined_users_createdAt).toEqual(DATE);
    expect(result._joined_users_email).toBe('user@example.com');
  });

  it('come back as Dates from inserts, updates and deletes that return rows', async () => {
    const { db } = recordingDatabase(COLUMNS, [row]);
    const inserted = await db.insertInto('sessions').values({ token: 't' }).returningAll().executeTakeFirst();
    const updated = await db.updateTable('sessions').set({ token: 'u' }).where('id', '=', 3).returningAll().executeTakeFirst();
    const deleted = await db.deleteFrom('sessions').where('id', '=', 3).returningAll().executeTakeFirst();
    for (const result of [inserted, updated, deleted]) expect(result?.expiresAt).toEqual(DATE);
  });

  it('leave tables without date columns, and raw queries, alone', async () => {
    const { db } = recordingDatabase(COLUMNS, [row]);
    const [other] = await db.selectFrom('settings').selectAll().execute();
    expect(other.expiresAt).toBe(ISO);
    const { rows } = await sql`select * from sessions`.execute(db);
    expect((rows[0] as Record<string, unknown>).expiresAt).toBe(ISO);
  });
});

describe('authDateColumns', () => {
  it('lists the date fields of Better Auth\'s tables under their table and column names', () => {
    const tables = getAuthTables({
      user: { modelName: 'users', fields: { image: 'avatarUrl' } },
      session: { modelName: 'sessions' },
      account: { modelName: 'accounts' },
      verification: { modelName: 'verifications' },
      plugins: [twoFactor({ schema: { twoFactor: { modelName: 'two_factors' } } })],
    });
    const columns = authDateColumns(tables);
    expect(Object.fromEntries([...columns].map(([table, set]) => [table, [...set].sort()]))).toEqual({
      users: ['createdAt', 'updatedAt'],
      sessions: ['createdAt', 'expiresAt', 'updatedAt'],
      accounts: ['accessTokenExpiresAt', 'createdAt', 'refreshTokenExpiresAt', 'updatedAt'],
      verifications: ['createdAt', 'expiresAt', 'updatedAt'],
      two_factors: ['lockedUntil'],
    });
  });
});
