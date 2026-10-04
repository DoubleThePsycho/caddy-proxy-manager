import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reset the module between tests so the in-memory Map is cleared
let registerFailedAttempt: typeof import('@/src/lib/rate-limit').registerFailedAttempt;
let isRateLimited: typeof import('@/src/lib/rate-limit').isRateLimited;
let resetAttempts: typeof import('@/src/lib/rate-limit').resetAttempts;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('@/src/lib/rate-limit');
  registerFailedAttempt = mod.registerFailedAttempt;
  isRateLimited = mod.isRateLimited;
  resetAttempts = mod.resetAttempts;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rate-limit', () => {
  const KEY = 'test-ip-1';

  it('first attempt is not blocked', async () => {
    const result = await registerFailedAttempt(KEY);
    expect(result.blocked).toBe(false);
  });

  it('4 failed attempts are not blocked (below threshold of 5)', async () => {
    for (let i = 0; i < 4; i++) {
      const result = await registerFailedAttempt(KEY);
      expect(result.blocked).toBe(false);
    }
  });

  it('5th failed attempt triggers block', async () => {
    for (let i = 0; i < 4; i++) {
      await registerFailedAttempt(KEY);
    }
    const result = await registerFailedAttempt(KEY);
    expect(result.blocked).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('isRateLimited returns blocked after 5 failures', async () => {
    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY);
    }
    const result = await isRateLimited(KEY);
    expect(result.blocked).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('isRateLimited returns not blocked for unknown key', async () => {
    const result = await isRateLimited('unknown-key-xyz');
    expect(result.blocked).toBe(false);
  });

  it('blocked entry unblocks after blockedUntil passes', async () => {
    // Trigger block
    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY);
    }

    // Mock Date.now to be far in the future (past block window)
    const future = Date.now() + 16 * 60 * 1000; // 16 minutes
    vi.spyOn(Date, 'now').mockReturnValue(future);

    const result = await isRateLimited(KEY);
    expect(result.blocked).toBe(false);
  });

  it('window expires without max attempts resets attempts', async () => {
    // Make a few attempts
    for (let i = 0; i < 3; i++) {
      await registerFailedAttempt(KEY);
    }

    // Jump past the window (default 5 minutes)
    const future = Date.now() + 6 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(future);

    // Now should be treated as first attempt
    const result = await registerFailedAttempt(KEY);
    expect(result.blocked).toBe(false);
  });

  it('resetAttempts immediately unblocks a key', async () => {
    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY);
    }
    expect((await isRateLimited(KEY)).blocked).toBe(true);

    await resetAttempts(KEY);
    expect((await isRateLimited(KEY)).blocked).toBe(false);
  });

  it('different keys do not interfere', async () => {
    const KEY_A = 'ip-a';
    const KEY_B = 'ip-b';

    for (let i = 0; i < 5; i++) {
      await registerFailedAttempt(KEY_A);
    }

    expect((await isRateLimited(KEY_A)).blocked).toBe(true);
    expect((await isRateLimited(KEY_B)).blocked).toBe(false);
  });
});

describe('rate-limit table bound', () => {
  it('stays bounded when flooded with unique keys and keeps active blocks', async () => {
    const { MAX_TRACKED_KEYS } = await import('@/src/lib/rate-limit');
    for (let i = 0; i < 5; i++) await registerFailedAttempt('account:admin');
    expect((await isRateLimited('account:admin')).blocked).toBe(true);

    for (let i = 0; i < MAX_TRACKED_KEYS + 500; i++) await registerFailedAttempt(`ip:flood-${i}`);

    // The blocked key survives the flood; the oldest unblocked keys were evicted.
    expect((await isRateLimited('account:admin')).blocked).toBe(true);
    await registerFailedAttempt('ip:flood-0');
    await registerFailedAttempt('ip:flood-0');
    await registerFailedAttempt('ip:flood-0');
    await registerFailedAttempt('ip:flood-0');
    // flood-0 was evicted earlier, so it restarted its count: 4 fresh attempts, not blocked.
    expect((await isRateLimited('ip:flood-0')).blocked).toBe(false);
  });
});

describe('createRateLimiter', () => {
  it('keeps a separate table per limiter', async () => {
    const { createRateLimiter } = await import('@/src/lib/rate-limit');
    const limiter = createRateLimiter({ name: 'test-1', maxAttempts: 2, windowMs: 60_000, blockMs: 60_000 });
    await limiter.registerAttempt('shared-key');
    expect((await limiter.registerAttempt('shared-key')).blocked).toBe(true);
    expect((await limiter.isRateLimited('shared-key')).blocked).toBe(true);
    // The default limiter has not seen this key.
    expect((await isRateLimited('shared-key')).blocked).toBe(false);
  });

  it('blocks on the maxAttempts-th attempt, including a limit of one', async () => {
    const { createRateLimiter } = await import('@/src/lib/rate-limit');
    const once = createRateLimiter({ name: 'test-2', maxAttempts: 1, windowMs: 60_000, blockMs: 60_000 });
    expect((await once.registerAttempt('k')).blocked).toBe(true);
    expect((await once.isRateLimited('k')).blocked).toBe(true);
  });

  it('bounds its table by maxKeys and keeps active blocks', async () => {
    const { createRateLimiter } = await import('@/src/lib/rate-limit');
    const limiter = createRateLimiter({ name: 'test-3', maxAttempts: 2, windowMs: 60_000, blockMs: 60_000, maxKeys: 10 });
    await limiter.registerAttempt('blocked');
    await limiter.registerAttempt('blocked');
    for (let i = 0; i < 50; i++) await limiter.registerAttempt(`flood-${i}`);
    expect((await limiter.isRateLimited('blocked')).blocked).toBe(true);
    // flood-0 was evicted, so one more attempt starts a fresh count.
    expect((await limiter.registerAttempt('flood-0')).blocked).toBe(false);
  });
});

describe('createRateLimiter reserveAttempt', () => {
  it('counts held attempts towards the limit until they are given back', async () => {
    const { createRateLimiter } = await import('@/src/lib/rate-limit');
    const limiter = createRateLimiter({ name: 'test-4', maxAttempts: 3, windowMs: 60_000, blockMs: 60_000 });
    await limiter.registerAttempt('k');
    const first = await limiter.reserveAttempt('k');
    const second = await limiter.reserveAttempt('k');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // One failure plus two attempts in flight reach the limit of 3.
    expect(await limiter.reserveAttempt('k')).toBeNull();
    // Holding a place is not a failure.
    expect((await limiter.isRateLimited('k')).blocked).toBe(false);

    await first!();
    await first!();
    const third = await limiter.reserveAttempt('k');
    expect(third).not.toBeNull();
    expect(await limiter.reserveAttempt('k')).toBeNull();
    await second!();
    await third!();
    expect(await limiter.reserveAttempt('other')).not.toBeNull();
  });

  it('refuses a blocked key', async () => {
    const { createRateLimiter } = await import('@/src/lib/rate-limit');
    const limiter = createRateLimiter({ name: 'test-5', maxAttempts: 2, windowMs: 60_000, blockMs: 60_000 });
    await limiter.registerAttempt('k');
    await limiter.registerAttempt('k');
    expect(await limiter.reserveAttempt('k')).toBeNull();
  });
});

describe('createRateLimiter with blockMs "window"', () => {
  it('refuses only until the current window ends', async () => {
    const { createRateLimiter } = await import('@/src/lib/rate-limit');
    const limiter = createRateLimiter({ name: 'test-6', maxAttempts: 3, windowMs: 60_000, blockMs: 'window' });
    const start = 1_000_000;
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(start);
    expect((await limiter.registerAttempt('k')).blocked).toBe(false);
    now.mockReturnValue(start + 20_000);
    expect((await limiter.registerAttempt('k')).blocked).toBe(false);
    now.mockReturnValue(start + 40_000);
    expect(await limiter.registerAttempt('k')).toEqual({ blocked: true, retryAfterMs: 20_000 });

    now.mockReturnValue(start + 59_000);
    expect(await limiter.isRateLimited('k')).toEqual({ blocked: true, retryAfterMs: 1_000 });
    now.mockReturnValue(start + 60_000);
    expect((await limiter.isRateLimited('k')).blocked).toBe(false);
    expect((await limiter.registerAttempt('k')).blocked).toBe(false);
  });
});
