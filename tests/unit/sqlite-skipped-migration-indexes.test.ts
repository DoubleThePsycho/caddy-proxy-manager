/**
 * Migrations 0007 and 0008 carry timestamps older than 0006, so databases
 * that had passed 0006 when they were added never ran them; 0021 recreates
 * linking_tokens without 0007's expiry index. Opening the database repairs
 * the index (src/lib/db/sqlite.ts), as found on a long-running install.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'ingressi-skipped-migrations-'));
const dbPath = join(workDir, 'app.db');

const globalForDb = globalThis as {
  __SQLITE_CLIENT__?: { close: () => void };
  __DRIZZLE_DB__?: unknown;
  __MIGRATIONS_RAN__?: boolean;
};

function closeClient() {
  globalForDb.__SQLITE_CLIENT__?.close();
  delete globalForDb.__SQLITE_CLIENT__;
  delete globalForDb.__DRIZZLE_DB__;
  delete globalForDb.__MIGRATIONS_RAN__;
}

/** Opens the database the way the application does (migrations, then repairs), then closes it. */
async function openDatabase() {
  closeClient();
  process.env.DATABASE_URL = `file:${dbPath}`;
  vi.resetModules();
  await import('@/src/lib/db/sqlite');
  closeClient();
}

function expiryIndex(): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'linking_tokens_expires_at_idx'").get() as
      | { sql: string }
      | undefined;
    return row?.sql;
  } finally {
    db.close();
  }
}

afterAll(() => {
  closeClient();
  process.env.DATABASE_URL = ':memory:';
  vi.resetModules();
  rmSync(workDir, { recursive: true, force: true });
});

describe('indexes of skipped migrations', () => {
  it('restores the linking_tokens expiry index on a database that lacks it', async () => {
    await openDatabase();
    expect(expiryIndex()).toContain('"expiresAt"');

    const db = new Database(dbPath);
    db.prepare('DROP INDEX "linking_tokens_expires_at_idx"').run();
    db.close();
    expect(expiryIndex()).toBeUndefined();

    await openDatabase();
    expect(expiryIndex()).toContain('"expiresAt"');
  });
});
