/**
 * The break-glass tool (src/lib/db/break-glass.ts, scripts/db/break-glass.ts,
 * db-tools/break-glass.js in the image) on the database DATABASE_URL names:
 * a SQLite file, or on PostgreSQL the worker's database. It removes the MFA
 * policy, turns enforced SSO off keeping the break-glass list, removes an
 * enforced SSO setting it cannot read, changes nothing when there is nothing
 * to change, and runs from the command line under Bun.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, testDbIsPostgres, type TestDb } from '../helpers/db';
import * as schema from '../../src/lib/db/schema';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
vi.mock('../../src/lib/db', async () => (await import('../helpers/db-module')).mockDbModule(() => ctx.db));

import {
  MFA_POLICY_KEY,
  postgresSettingsRows,
  runBreakGlass,
  sqliteSettingsRows,
  SSO_ENFORCEMENT_KEY,
  type SettingsRows,
} from '../../src/lib/db/break-glass';
import { MFA_POLICY_SETTING_KEY, parseMfaPolicy } from '../../src/lib/mfa';
import { parseSsoEnforcement, SSO_ENFORCEMENT_SETTING_KEY } from '../../ee/sso/enforcement-store';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

/** The database as the tool sees it, and the helpers the test checks it with. */
type Target = {
  url: string;
  rows: () => Promise<SettingsRows>;
  seed: (key: string, value: string) => Promise<void>;
  stored: (key: string) => Promise<string | null>;
  close: () => void;
};

function sqliteTarget(): Target {
  const dir = mkdtempSync(join(tmpdir(), 'break-glass-'));
  const path = join(dir, 'ingressi.db');
  const client = new Database(path);
  migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return {
    url: `file:${path}`,
    rows: async () => sqliteSettingsRows(path),
    seed: async (key, value) => {
      client.prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)').run(key, value, NOW.toISOString());
    },
    stored: async (key) => (client.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null,
    close: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function postgresTarget(): Target {
  ctx.db = createTestDb();
  const url = process.env.DATABASE_URL!;
  return {
    url,
    rows: () => postgresSettingsRows({ connectionString: url }),
    seed: async (key, value) => {
      await ctx.db.insert(schema.settings).values({ key, value, updatedAt: NOW.toISOString() });
    },
    stored: async (key) => (await ctx.db.select().from(schema.settings).where(eq(schema.settings.key, key)))[0]?.value ?? null,
    close: () => undefined,
  };
}

let target: Target;

beforeEach(() => {
  target = testDbIsPostgres() ? postgresTarget() : sqliteTarget();
});

afterEach(() => {
  target.close();
});

async function run(action: 'remove-mfa-policy' | 'turn-off-sso-enforcement'): Promise<string> {
  const rows = await target.rows();
  try {
    return await runBreakGlass(action, rows, NOW);
  } finally {
    await rows.close();
  }
}

describe('the break-glass tool', () => {
  it('uses the application\'s setting keys', () => {
    expect(MFA_POLICY_KEY).toBe(MFA_POLICY_SETTING_KEY);
    expect(SSO_ENFORCEMENT_KEY).toBe(SSO_ENFORCEMENT_SETTING_KEY);
  });

  it('removes the MFA policy, a corrupted one too', async () => {
    await target.seed(MFA_POLICY_KEY, '{not json');
    // Unreadable: MFA for every account with a password (fail closed).
    expect(parseMfaPolicy(await target.stored(MFA_POLICY_KEY)).scope).toBe('password_users');
    expect(await run('remove-mfa-policy')).toMatch(/^MFA policy removed/);
    expect(await target.stored(MFA_POLICY_KEY)).toBeNull();
    expect(parseMfaPolicy(null).scope).toBe('off');
    expect(await run('remove-mfa-policy')).toMatch(/^There was no MFA policy/);
  });

  it('turns enforced SSO off and keeps the break-glass list', async () => {
    await target.seed(SSO_ENFORCEMENT_KEY, JSON.stringify({ enabled: true, breakGlassUserIds: [3, 5] }));
    expect(await run('turn-off-sso-enforcement')).toBe('Enforced SSO is off. The break-glass list is kept.');
    expect(parseSsoEnforcement(await target.stored(SSO_ENFORCEMENT_KEY))).toEqual({ enabled: false, breakGlassUserIds: [3, 5] });
    expect(await run('turn-off-sso-enforcement')).toBe('Enforced SSO is off already.');
  });

  it('removes an enforced SSO setting it cannot read, which counts as enforced', async () => {
    await target.seed(SSO_ENFORCEMENT_KEY, '["enabled"]');
    expect(parseSsoEnforcement(await target.stored(SSO_ENFORCEMENT_KEY)).enabled).toBe(true);
    expect(await run('turn-off-sso-enforcement')).toMatch(/could not be read.*removed/);
    expect(await target.stored(SSO_ENFORCEMENT_KEY)).toBeNull();
    expect(await run('turn-off-sso-enforcement')).toBe('Enforced SSO is off already: there is no setting.');
  });

  it.skipIf(!hasBun)('runs from the command line on the database DATABASE_URL names', async () => {
    await target.seed(SSO_ENFORCEMENT_KEY, JSON.stringify({ enabled: true, breakGlassUserIds: [7] }));
    const cli = (...args: string[]) =>
      spawnSync('bun', ['scripts/db/break-glass.ts', ...args], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: target.url, DATABASE_DIALECT: '' },
        timeout: 60_000,
      });
    const done = cli('turn-off-sso-enforcement');
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout.trim()).toBe('Enforced SSO is off. The break-glass list is kept.');
    expect(parseSsoEnforcement(await target.stored(SSO_ENFORCEMENT_KEY))).toEqual({ enabled: false, breakGlassUserIds: [7] });

    const wrong = cli('turn-off-everything');
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('remove-mfa-policy or turn-off-sso-enforcement');
  });

  it.skipIf(!hasBun || testDbIsPostgres())('refuses a SQLite file that does not exist, and creates none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'break-glass-missing-'));
    try {
      const missing = join(dir, 'ingressi.db');
      const result = spawnSync('bun', ['scripts/db/break-glass.ts', 'remove-mfa-policy'], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: `file:${missing}`, DATABASE_DIALECT: '' },
        timeout: 60_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`There is no SQLite database at ${missing}`);
      expect(spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
