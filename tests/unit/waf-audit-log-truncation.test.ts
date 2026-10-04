/**
 * Regression: Coraza's SecAuditLog writes waf-audit.log directly with no
 * rotation of its own (unlike access.log/waf-rules.log, which go through
 * Caddy's file writer and roll automatically) — it grew to ~2GB in
 * production and was never cleaned up. parseNewWafLogEntries now truncates
 * the file in place once it has been fully ingested and crosses a size
 * threshold. These tests pin that behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// Matches AUDIT_LOG_TRUNCATE_THRESHOLD in src/lib/waf-log-parser.ts
const TRUNCATE_THRESHOLD = 100 * 1024 * 1024;
const AUDIT_LOG_PATH = '/logs/waf-audit.log';

const state = { inserted: [] as { key: string; value: string }[] };
const fsState = { auditSize: 0, rulesExists: false, auditInode: 42 };
// Backing store for the parser's persisted offsets. Reads have to round-trip
// through this, otherwise a test that spans two passes silently starts each one
// from a blank slate and proves nothing.
const store = new Map<string, string>();

// Reduce `eq(column, value)` to the key itself so the db mock's `where()` can
// look it up without interpreting drizzle's SQL objects.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: (_column: unknown, value: string) => ({ __key: value }),
}));

vi.mock('@/src/lib/db', async () => {
  // Queries are awaited: the chain ends in promises.
  const fake = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: { __key: string }) => ({
          limit: vi.fn(async () => (store.has(cond.__key) ? [{ value: store.get(cond.__key) }] : [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: { key: string; value: string }) => {
        state.inserted.push(v);
        store.set(v.key, v.value);
        return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
  return (await import('../helpers/db-module')).mockDbModule(() => fake);
});

vi.mock('maxmind', () => ({
  default: { open: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/src/lib/clickhouse/client', () => ({
  insertWafEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => (p.includes('waf-audit') ? true : fsState.rulesExists)),
  statSync: vi.fn((p: string) => ({
    size: p.includes('waf-audit') ? fsState.auditSize : 0,
    ino: p.includes('waf-audit') ? fsState.auditInode : 1,
  })),
  // Produces exactly `size - start` bytes so the parser always reads through
  // to the simulated current end-of-file in one pass, regardless of start offset.
  // Chunks are Buffers because that is what createReadStream yields when no
  // encoding is set, and the offset accounting counts bytes, not characters.
  createReadStream: vi.fn((p: string, opts: { start?: number }) => {
    const start = opts?.start ?? 0;
    const size = p.includes('waf-audit') ? fsState.auditSize : 0;
    const remaining = Math.max(0, size - start);
    const content = remaining > 0 ? 'x'.repeat(remaining - 1) + '\n' : '';
    return Readable.from([Buffer.from(content, 'utf8')]);
  }),
  truncateSync: vi.fn(),
}));

import * as fs from 'node:fs';
import { parseNewWafLogEntries } from '@/src/lib/waf-log-parser';

beforeEach(() => {
  state.inserted = [];
  store.clear();
  fsState.auditSize = 0;
  fsState.rulesExists = false;
  fsState.auditInode = 42;
  vi.mocked(fs.truncateSync).mockReset();
});

function stateValue(key: string): string | undefined {
  return [...state.inserted].reverse().find((s) => s.key === key)?.value;
}

describe('waf-audit.log truncation', () => {
  it('does not truncate when below the size threshold', async () => {
    fsState.auditSize = 50 * 1024 * 1024; // 50MB < 100MB threshold
    await parseNewWafLogEntries();

    expect(fs.truncateSync).not.toHaveBeenCalled();
    expect(stateValue('waf_audit_log_size')).toBe(String(fsState.auditSize));
  });

  it('does not truncate exactly at the threshold (strictly greater-than)', async () => {
    fsState.auditSize = TRUNCATE_THRESHOLD;
    await parseNewWafLogEntries();

    expect(fs.truncateSync).not.toHaveBeenCalled();
    expect(stateValue('waf_audit_log_size')).toBe(String(TRUNCATE_THRESHOLD));
  });

  it('truncates in place once past the threshold and resets stored offset/size to 0', async () => {
    fsState.auditSize = TRUNCATE_THRESHOLD + 1;
    await parseNewWafLogEntries();

    expect(fs.truncateSync).toHaveBeenCalledWith(AUDIT_LOG_PATH, 0);
    expect(stateValue('waf_audit_log_offset')).toBe('0');
    expect(stateValue('waf_audit_log_size')).toBe('0');
  });

  // Regression (issue #233): Coraza creates waf-audit.log owned by the caddy
  // user with mode 0644, so the web container — a different UID — gets EACCES
  // here. The truncate used to run *before* the offsets were persisted, so the
  // throw aborted the pass and froze them, making every later pass re-read and
  // re-insert the same tail forever. Progress must survive a failed truncate.
  it('keeps advancing the stored offset when truncation fails with EACCES', async () => {
    fsState.auditSize = TRUNCATE_THRESHOLD + 1;
    vi.mocked(fs.truncateSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied, truncate '/logs/waf-audit.log'") as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    await parseNewWafLogEntries();

    expect(fs.truncateSync).toHaveBeenCalled();
    expect(stateValue('waf_audit_log_offset')).toBe(String(fsState.auditSize));
    expect(stateValue('waf_audit_log_size')).toBe(String(fsState.auditSize));
  });

  it('re-reads from the start when the audit log is replaced by a new inode', async () => {
    // First pass consumes the whole file and records its inode.
    fsState.auditSize = 5_000;
    await parseNewWafLogEntries();
    expect(stateValue('waf_audit_log_offset')).toBe('5000');

    // File is deleted and recreated, then grows past the previously stored
    // size — so the shrink check alone would never notice the replacement.
    state.inserted = [];
    fsState.auditInode = 43;
    fsState.auditSize = 9_000;
    await parseNewWafLogEntries();

    // Read restarted at 0, so the offset reflects the full new file.
    expect(stateValue('waf_audit_log_offset')).toBe('9000');
    expect(stateValue('waf_audit_log_inode')).toBe('43');
  });
});
