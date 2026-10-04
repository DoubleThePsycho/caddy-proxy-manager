import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyDatabaseFile } from '@/src/lib/db-file';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('adoptLegacyDatabaseFile', () => {
  it('moves the pre-rename database and its journal files to ingressi.db', () => {
    writeFileSync(join(dir, 'caddy-proxy-manager.db'), 'main');
    writeFileSync(join(dir, 'caddy-proxy-manager.db-wal'), 'wal');
    writeFileSync(join(dir, 'caddy-proxy-manager.db-shm'), 'shm');

    expect(adoptLegacyDatabaseFile(join(dir, 'ingressi.db'))).toBe(true);

    expect(readFileSync(join(dir, 'ingressi.db'), 'utf8')).toBe('main');
    expect(readFileSync(join(dir, 'ingressi.db-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(dir, 'ingressi.db-shm'), 'utf8')).toBe('shm');
    expect(existsSync(join(dir, 'caddy-proxy-manager.db'))).toBe(false);
    expect(existsSync(join(dir, 'caddy-proxy-manager.db-wal'))).toBe(false);
  });

  it('leaves both files alone when ingressi.db already exists', () => {
    writeFileSync(join(dir, 'caddy-proxy-manager.db'), 'old');
    writeFileSync(join(dir, 'ingressi.db'), 'new');

    expect(adoptLegacyDatabaseFile(join(dir, 'ingressi.db'))).toBe(false);

    expect(readFileSync(join(dir, 'ingressi.db'), 'utf8')).toBe('new');
    expect(readFileSync(join(dir, 'caddy-proxy-manager.db'), 'utf8')).toBe('old');
  });

  it('finishes a move interrupted after the journal files', () => {
    writeFileSync(join(dir, 'caddy-proxy-manager.db'), 'main');
    writeFileSync(join(dir, 'ingressi.db-wal'), 'wal');

    expect(adoptLegacyDatabaseFile(join(dir, 'ingressi.db'))).toBe(true);

    expect(readFileSync(join(dir, 'ingressi.db'), 'utf8')).toBe('main');
    expect(readFileSync(join(dir, 'ingressi.db-wal'), 'utf8')).toBe('wal');
  });

  it('does nothing for a fresh install, another file name or an in-memory database', () => {
    expect(adoptLegacyDatabaseFile(join(dir, 'ingressi.db'))).toBe(false);

    writeFileSync(join(dir, 'caddy-proxy-manager.db'), 'main');
    expect(adoptLegacyDatabaseFile(join(dir, 'custom.db'))).toBe(false);
    expect(adoptLegacyDatabaseFile(':memory:')).toBe(false);
    expect(existsSync(join(dir, 'caddy-proxy-manager.db'))).toBe(true);
  });
});
