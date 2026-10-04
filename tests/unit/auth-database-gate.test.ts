/**
 * Better Auth on the application executor (src/lib/db/auth-database.ts): its
 * queries run in an open application transaction when they are made inside
 * one (and on SQLite wait for it otherwise); its own transactions are
 * application transactions, which application code run from them joins;
 * sign-up, password sign-in and sessions work through it. (Two-factor and
 * passkeys: auth-mfa.test.ts and auth-passkeys.test.ts, which boot the same
 * stack.)
 *
 * Like auth-mfa.test.ts, this boots the real db module and the real
 * auth-server against the application database: a SQLite file, or in the
 * postgres project the worker's PostgreSQL database (tests/helpers/app-database.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import type { Kysely } from 'kysely';
import { getAuthTables } from 'better-auth/db';
import { APP_BASE_URL, AuthBrowser } from '../helpers/mfa-browser';
import { openAppDatabase, type AppDatabase } from '../helpers/app-database';

const PASSWORD = 'Gate-Password-2026!';
const NOW = '2026-01-01T00:00:00.000Z';
const onPostgres = process.env.TEST_DB_DIALECT === 'postgres';

let database: AppDatabase;

type App = {
  appDb: Awaited<typeof import('../../src/lib/db')>['appDb'];
  schema: typeof import('../../src/lib/db/schema');
  ops: typeof import('../../src/lib/db/ops');
  authDatabase: typeof import('../../src/lib/db/auth-database');
  auth: ReturnType<Awaited<typeof import('../../src/lib/auth-server')>['getAuth']>;
  userModel: typeof import('../../src/lib/models/user');
};
let app: App;

beforeAll(async () => {
  database = await openAppDatabase('ingressi-auth-gate-');
  // Vitest leaks Vite's BASE_URL='/' into process.env, which better-auth rejects.
  process.env.BASE_URL = APP_BASE_URL;
  process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
  process.env.AUTH_ALLOW_SELF_REGISTRATION = 'true';
  vi.resetModules();

  const dbModule = await import('../../src/lib/db');
  const { getAuth } = await import('../../src/lib/auth-server');
  app = {
    appDb: dbModule.appDb,
    schema: await import('../../src/lib/db/schema'),
    ops: await import('../../src/lib/db/ops'),
    authDatabase: await import('../../src/lib/db/auth-database'),
    auth: getAuth(),
    userModel: await import('../../src/lib/models/user'),
  };
});

afterAll(async () => {
  await database.close();
  delete process.env.AUTH_RATE_LIMIT_ENABLED;
  delete process.env.AUTH_ALLOW_SELF_REGISTRATION;
  vi.resetModules();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type AuthDatabase = ReturnType<typeof import('../../src/lib/db/auth-database')['getAuthDatabase']>;

/** The database Better Auth was built with. */
function authDatabase(): AuthDatabase {
  return (app.auth as unknown as { options: { database: AuthDatabase } }).options.database;
}

/** Better Auth's Kysely instance, untyped. */
function kysely(): Kysely<any> {
  return authDatabase().db as unknown as Kysely<any>;
}

type ApiCall = (args: { body: Record<string, unknown> }) => Promise<unknown>;
const api = (name: string) => (app.auth.api as unknown as Record<string, ApiCall>)[name];

async function setting(key: string): Promise<string | null> {
  const { schema, ops } = app;
  return (await ops.first(app.appDb.select().from(schema.settings).where(eq(schema.settings.key, key))))?.value ?? null;
}

function put(key: string, value: string) {
  return app.appDb.insert(app.schema.settings).values({ key, value, updatedAt: NOW });
}

let userCounter = 0;

async function createAccount(): Promise<{ id: number; username: string }> {
  userCounter += 1;
  const username = `gate-user-${userCounter}`;
  const user = await app.userModel.createUser({
    email: `${username}@example.com`,
    username,
    role: 'user',
    provider: 'credentials',
    subject: username,
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
  });
  return { id: user.id, username };
}

function sessionCount(userId: number) {
  return app.appDb.$count(app.schema.sessions, eq(app.schema.sessions.userId, userId));
}

describe('Better Auth on the application executor', () => {
  it('gets the application database through the application executor', () => {
    const database = authDatabase();
    expect(database).toMatchObject({ type: onPostgres ? 'postgres' : 'sqlite', transaction: true });
    expect(database.db).toBeInstanceOf(app.authDatabase.GatedKysely);
    // The same tables give the same database.
    expect(app.authDatabase.getAuthDatabase(getAuthTables(app.auth.options))).toBe(database);
  });

  it.skipIf(onPostgres)('makes Better Auth queries wait for an open application transaction', async () => {
    const hold = deferred();
    const transaction = app.appDb.transaction(async () => {
      await put('gate-wait', 'written in the transaction');
      await hold.promise;
    });
    await tick();
    let seen: unknown;
    const read = kysely().selectFrom('settings').select('value').where('key', '=', 'gate-wait').execute()
      .then((rows) => { seen = rows; });
    await tick();
    await tick();
    expect(seen).toBeUndefined();
    hold.resolve();
    await transaction;
    await read;
    expect(seen).toEqual([{ value: 'written in the transaction' }]);
  });

  it.runIf(onPostgres)('runs Better Auth queries outside an application transaction on their own, without its uncommitted writes', async () => {
    const hold = deferred();
    const written = deferred();
    const transaction = app.appDb.transaction(async () => {
      await put('gate-wait', 'written in the transaction');
      written.resolve();
      await hold.promise;
    });
    await written.promise;
    const read = () => kysely().selectFrom('settings').select('value').where('key', '=', 'gate-wait').execute();
    expect(await read()).toEqual([]);
    hold.resolve();
    await transaction;
    expect(await read()).toEqual([{ value: 'written in the transaction' }]);
  });

  it('runs a Better Auth sign-in made inside an application transaction in it', async () => {
    const user = await createAccount();
    const before = await sessionCount(user.id);
    await expect(app.appDb.transaction(async () => {
      const result = (await api('signInUsername')({ body: { username: user.username, password: PASSWORD } })) as {
        user?: { id?: string | number };
      };
      expect(String(result.user?.id)).toBe(String(user.id));
      expect(await sessionCount(user.id)).toBe(before + 1);
      throw new Error('undo the sign-in');
    })).rejects.toThrow('undo the sign-in');
    expect(await sessionCount(user.id)).toBe(before);
  });

  it('runs Better Auth transactions as application transactions: application code run from them joins, and a failure undoes both', async () => {
    const hold = deferred();
    const written = deferred();
    const events: string[] = [];
    const authTransaction = kysely().transaction().execute(async (trx) => {
      await trx.insertInto('settings').values({ key: 'kysely-tx', value: 'k', updatedAt: NOW }).execute();
      // What a Better Auth hook does with the application database: it joins.
      await put('hook', 'h');
      expect(await setting('kysely-tx')).toBe('k');
      events.push('auth transaction wrote');
      written.resolve();
      await hold.promise;
      throw new Error('the auth transaction fails');
    });
    await written.promise;
    // On SQLite the transaction holds the gate: a query from outside waits
    // for it. On PostgreSQL it runs at once and does not see the
    // uncommitted rows.
    const outside = setting('kysely-tx').then((value) => { events.push(`outside sees ${value}`); });
    if (onPostgres) await outside;
    await tick();
    await tick();
    expect(events).toEqual(onPostgres ? ['auth transaction wrote', 'outside sees null'] : ['auth transaction wrote']);
    hold.resolve();
    await expect(authTransaction).rejects.toThrow('the auth transaction fails');
    await outside;
    expect(events).toEqual(['auth transaction wrote', 'outside sees null']);
    expect(await setting('hook')).toBeNull();
    expect(await setting('kysely-tx')).toBeNull();
  });

  it('opens a savepoint for a Better Auth transaction inside an application transaction', async () => {
    await app.appDb.transaction(async () => {
      await put('outer-app', '1');
      await expect(kysely().transaction().execute(async (trx) => {
        await trx.insertInto('settings').values({ key: 'inner-auth', value: '1', updatedAt: NOW }).execute();
        throw new Error('inner fails');
      })).rejects.toThrow('inner fails');
      await kysely().transaction().execute(async (trx) => {
        await trx.insertInto('settings').values({ key: 'inner-auth-kept', value: '1', updatedAt: NOW }).execute();
      });
    });
    expect([await setting('outer-app'), await setting('inner-auth'), await setting('inner-auth-kept')]).toEqual(['1', null, '1']);
  });

  it('signs up through its own transaction, signs in with a password and keeps the session', async () => {
    const { schema, ops } = app;
    const transaction = vi.spyOn(app.authDatabase.GatedKysely.prototype, 'transaction');
    try {
      await api('signUpEmail')({ body: { email: 'gate-signup@example.com', password: PASSWORD, name: 'Gate Sign-up' } });
      expect(transaction).toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
    const user = await ops.first(app.appDb.select().from(schema.users).where(eq(schema.users.email, 'gate-signup@example.com')));
    expect(user).toBeDefined();
    expect(await app.appDb.$count(schema.accounts, and(
      eq(schema.accounts.userId, user!.id),
      eq(schema.accounts.providerId, 'credential')
    ))).toBe(1);

    const account = await createAccount();
    const browser = new AuthBrowser(() => app.auth.handler);
    const signIn = await browser.post('/sign-in/username', { username: account.username, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(browser.has('session_token')).toBe(true);
    const session = await browser.get('/get-session');
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body ?? 'null')).toMatchObject({ user: { email: `${account.username}@example.com` } });
    expect(await sessionCount(account.id)).toBe(1);

    const stranger = new AuthBrowser(() => app.auth.handler);
    const wrong = await stranger.post('/sign-in/username', { username: account.username, password: 'Wrong-Password-1!' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(stranger.has('session_token')).toBe(false);
    expect(await sessionCount(account.id)).toBe(1);
  });
});
