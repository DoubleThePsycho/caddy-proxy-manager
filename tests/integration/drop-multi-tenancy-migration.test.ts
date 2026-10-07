/**
 * Migration 0059_drop_multi_tenancy, on SQLite and (with TEST_DATABASE_URL)
 * on PostgreSQL: a database at 0058 that holds organisations is migrated.
 * Organisation users end up disabled viewers without a custom role and
 * without sessions; group names that would clash get the organisation's
 * slug, then the id; the organizations table, the organizationId columns
 * and the users triggers are gone; every other row stays.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { TEST_DATABASE_URL, createPgTestDatabase, migratePgDatabase, type PgTestDatabase } from '../helpers/pg-database';

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const TAG = '0059_drop_multi_tenancy';

const workDir = mkdtempSync(join(tmpdir(), 'ingressi-0059-'));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** A copy of `folder` whose journal stops before 0059. */
function migrationsBefore0059(folder: string, name: string): string {
  const copy = join(workDir, name);
  cpSync(resolve(process.cwd(), folder), copy, { recursive: true });
  const journalPath = join(copy, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(journalPath, JSON.stringify(journal));
  return copy;
}

/** Rows written at 0058, the same statements on both databases. */
const FIXTURE = [
  `INSERT INTO "organizations" ("id", "name", "slug", "createdAt", "updatedAt") VALUES (1, 'Acme', 'acme', '${NOW}', '${NOW}'), (2, 'Beta', 'beta', '${NOW}', '${NOW}')`,
  `INSERT INTO "custom_roles" ("id", "name", "createdAt", "updatedAt") VALUES (5, 'Operators', '${NOW}', '${NOW}')`,
  `INSERT INTO "users" ("id", "email", "role", "customRoleId", "organizationId", "status", "createdAt", "updatedAt") VALUES
    (1, 'admin@example.com', 'admin', NULL, NULL, 'active', '${NOW}', '${NOW}'),
    (2, 'owner@example.com', 'org_admin', NULL, 1, 'active', '${NOW}', '${NOW}'),
    (3, 'member@example.com', 'viewer', 5, 2, 'active', '${NOW}', '${NOW}'),
    (4, 'staff@example.com', 'user', NULL, NULL, 'active', '${NOW}', '${NOW}')`,
  `INSERT INTO "sessions" ("id", "userId", "token", "expiresAt", "createdAt", "updatedAt") VALUES
    (1, 2, 'token-owner', '${LATER}', '${NOW}', '${NOW}'),
    (2, 4, 'token-staff', '${LATER}', '${NOW}', '${NOW}')`,
  `INSERT INTO "proxy_hosts" ("id", "name", "domains", "upstreams", "organizationId", "createdAt", "updatedAt") VALUES
    (1, 'Acme app', '["app.acme.example.com"]', '["10.0.0.1:80"]', 1, '${NOW}', '${NOW}'),
    (2, 'Own app', '["app.example.com"]', '["10.0.0.2:80"]', NULL, '${NOW}', '${NOW}')`,
  `INSERT INTO "forward_auth_sessions" ("id", "userId", "proxyHostId", "audienceOrigin", "tokenHash", "expiresAt", "createdAt") VALUES
    (1, 3, 1, 'https://app.acme.example.com', 'hash-member', '${LATER}', '${NOW}'),
    (2, 4, 2, 'https://app.example.com', 'hash-staff', '${LATER}', '${NOW}')`,
  `INSERT INTO "groups" ("id", "name", "organizationId", "createdAt", "updatedAt") VALUES
    (1, 'Admins', NULL, '${NOW}', '${NOW}'),
    (2, 'Admins', 1, '${NOW}', '${NOW}'),
    (3, 'Admins', 2, '${NOW}', '${NOW}'),
    (4, 'Ops', 1, '${NOW}', '${NOW}'),
    (5, 'Admins (acme)', 2, '${NOW}', '${NOW}')`,
  `INSERT INTO "audit_events" ("id", "action", "entityType", "summary", "organizationId", "createdAt") VALUES (1, 'update', 'proxy_host', 'Changed Acme app', 1, '${NOW}')`,
];

type Row = Record<string, unknown>;

/** What the migrated database holds, read the same way on both. */
async function outcome(query: (sql: string) => Promise<Row[]>) {
  const users = await query(`SELECT "id", "role", "customRoleId", "status", "disabledAt" FROM "users" ORDER BY "id"`);
  return {
    users: users.map((row) => ({
      id: Number(row.id),
      role: row.role,
      customRoleId: row.customRoleId === null ? null : Number(row.customRoleId),
      status: row.status,
      disabled: row.disabledAt !== null,
    })),
    sessions: (await query(`SELECT "userId" FROM "sessions" ORDER BY "id"`)).map((row) => Number(row.userId)),
    forwardAuthSessions: (await query(`SELECT "userId" FROM "forward_auth_sessions" ORDER BY "id"`)).map((row) => Number(row.userId)),
    groups: (await query(`SELECT "id", "name" FROM "groups" ORDER BY "id"`)).map((row) => [Number(row.id), row.name]),
    hosts: (await query(`SELECT "name" FROM "proxy_hosts" ORDER BY "id"`)).map((row) => row.name),
    audit: (await query(`SELECT "summary" FROM "audit_events" ORDER BY "id"`)).map((row) => row.summary),
  };
}

const EXPECTED = {
  users: [
    { id: 1, role: 'admin', customRoleId: null, status: 'active', disabled: false },
    { id: 2, role: 'viewer', customRoleId: null, status: 'disabled', disabled: true },
    { id: 3, role: 'viewer', customRoleId: null, status: 'disabled', disabled: true },
    { id: 4, role: 'user', customRoleId: null, status: 'active', disabled: false },
  ],
  sessions: [4],
  forwardAuthSessions: [4],
  groups: [
    [1, 'Admins'],
    [2, 'Admins (acme) #2'],
    [3, 'Admins (beta)'],
    [4, 'Ops'],
    [5, 'Admins (acme) #5'],
  ],
  hosts: ['Acme app', 'Own app'],
  audit: ['Changed Acme app'],
};

const TENANCY_TABLES = ['users', 'proxy_hosts', 'certificates', 'access_lists', 'groups', 'audit_events', 'analytics_saved_views', 'analytics_questions'];

describe('0059_drop_multi_tenancy on SQLite', () => {
  it('disables organisation users, renames clashing groups and drops organisations', async () => {
    const client = new Database(':memory:');
    // As the application runs it: foreign keys off.
    client.pragma('foreign_keys = OFF');
    try {
      migrate(drizzle(client), { migrationsFolder: migrationsBefore0059('drizzle', 'sqlite') });
      for (const statement of FIXTURE) client.prepare(statement).run();
      migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });

      expect(await outcome(async (sql) => client.prepare(sql).all() as Row[])).toEqual(EXPECTED);
      const objects = client.prepare(`SELECT "type", "name" FROM sqlite_master WHERE "name" LIKE '%organization%'`).all();
      expect(objects).toEqual([]);
      for (const table of TENANCY_TABLES) {
        const columns = (client.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name);
        expect(columns, table).not.toContain('organizationId');
      }
      const groupIndex = client.prepare(`SELECT "sql" FROM sqlite_master WHERE "name" = 'groups_name_unique'`).get() as { sql: string };
      expect(groupIndex.sql).toContain('UNIQUE INDEX');
    } finally {
      client.close();
    }
  });

  it('runs on a database that never had an organisation', () => {
    const client = new Database(':memory:');
    client.pragma('foreign_keys = OFF');
    try {
      migrate(drizzle(client), { migrationsFolder: migrationsBefore0059('drizzle', 'sqlite-empty') });
      client.prepare(`INSERT INTO "groups" ("name", "createdAt", "updatedAt") VALUES ('Admins', '${NOW}', '${NOW}')`).run();
      migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      expect(client.prepare(`SELECT "name" FROM "groups"`).all()).toEqual([{ name: 'Admins' }]);
    } finally {
      client.close();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)('0059_drop_multi_tenancy on PostgreSQL', () => {
  let database: PgTestDatabase | undefined;

  afterAll(async () => {
    await database?.drop();
  });

  it('disables organisation users, renames clashing groups and drops organisations', async () => {
    database = await createPgTestDatabase('drop_tenancy');
    const { client } = database;
    await migratePgDatabase(client, migrationsBefore0059('drizzle-pg', 'pg'));
    for (const statement of FIXTURE) await client.query(statement);
    await migratePgDatabase(client);

    expect(await outcome(async (sql) => (await client.query<Row>(sql)).rows)).toEqual(EXPECTED);
    const objects = await client.query(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE '%organization%'
       UNION ALL SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%organization%'
       UNION ALL SELECT t.tgname FROM pg_trigger t WHERE t.tgname LIKE '%organization%'`
    );
    expect(objects.rows).toEqual([]);
    const columns = await client.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organizationId'`
    );
    expect(columns.rows).toEqual([]);
  });
});
