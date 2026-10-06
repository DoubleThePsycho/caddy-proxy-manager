/**
 * The Caddy monitor (src/lib/caddy-monitor.ts) applies again after an apply
 * that could not reach Caddy, once Caddy answers: Caddy restarted at the same
 * moment as the dashboard comes back with its saved configuration, which
 * matches the last successful apply, so there is no drift to see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaddyApplyStatus } from '@/src/lib/caddy-apply-status';

const caddy = vi.hoisted(() => ({
  applyCaddyConfig: vi.fn(async () => {}),
  getAppliedConfigHash: vi.fn(async (): Promise<string | null> => 'a'.repeat(64)),
  getCaddyLiveConfigHash: vi.fn(async (): Promise<string | null> => 'a'.repeat(64)),
}));
const status = vi.hoisted(() => ({ current: null as CaddyApplyStatus | null }));

vi.mock('@/src/lib/caddy', () => caddy);
vi.mock('@/src/lib/caddy-apply-status', () => ({ getCaddyApplyStatus: async () => status.current }));
vi.mock('@/src/lib/config', () => ({ config: { caddyMonitorEnabled: true } }));

const { checkCaddyHealth, failedApplyRetryDue } = await import('@/src/lib/caddy-monitor');

const NOW = Date.parse('2026-10-06T06:00:00Z');
const failed = (code: CaddyApplyStatus['code'], secondsAgo: number, consecutiveFailures = 1): CaddyApplyStatus => ({
  ok: false,
  at: new Date(NOW - secondsAgo * 1000).toISOString(),
  code,
  message: 'Unable to reach Caddy API',
  consecutiveFailures,
});

describe('failedApplyRetryDue', () => {
  it('retries only failures a later attempt can fix', () => {
    expect(failedApplyRetryDue(null, NOW)).toBe(false);
    expect(failedApplyRetryDue({ ok: true, at: new Date(NOW).toISOString(), code: null, message: null, consecutiveFailures: 0 }, NOW)).toBe(false);
    expect(failedApplyRetryDue(failed('CADDY_REJECTED', 600), NOW)).toBe(false);
    expect(failedApplyRetryDue(failed('CONFIG_BUILD_FAILED', 600), NOW)).toBe(false);
    expect(failedApplyRetryDue(failed('CADDY_UNREACHABLE', 600), NOW)).toBe(true);
    expect(failedApplyRetryDue(failed('CADDY_REQUEST_FAILED', 600), NOW)).toBe(true);
  });

  it('backs off: 5 s after the first failure, doubling, at most 5 minutes', () => {
    expect(failedApplyRetryDue(failed('CADDY_UNREACHABLE', 4), NOW)).toBe(false);
    expect(failedApplyRetryDue(failed('CADDY_UNREACHABLE', 5), NOW)).toBe(true);
    expect(failedApplyRetryDue(failed('CADDY_UNREACHABLE', 19, 3), NOW)).toBe(false);
    expect(failedApplyRetryDue(failed('CADDY_UNREACHABLE', 20, 3), NOW)).toBe(true);
    expect(failedApplyRetryDue(failed('CADDY_UNREACHABLE', 299, 20), NOW)).toBe(false);
    expect(failedApplyRetryDue(failed('CADDY_UNREACHABLE', 300, 20), NOW)).toBe(true);
  });
});

describe('checkCaddyHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    caddy.applyCaddyConfig.mockClear();
    caddy.getCaddyLiveConfigHash.mockResolvedValue('a'.repeat(64));
    caddy.getAppliedConfigHash.mockResolvedValue('a'.repeat(64));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function checkAndWait() {
    await checkCaddyHealth();
    await vi.advanceTimersByTimeAsync(6000);
  }

  it('applies again once Caddy answers after an apply could not reach it', async () => {
    status.current = failed('CADDY_UNREACHABLE', 60);
    await checkAndWait();
    expect(caddy.applyCaddyConfig).toHaveBeenCalledTimes(1);
  });

  it('leaves a successful apply, a rejected configuration and an unreachable Caddy alone', async () => {
    status.current = { ok: true, at: new Date(NOW).toISOString(), code: null, message: null, consecutiveFailures: 0 };
    await checkAndWait();
    status.current = failed('CADDY_REJECTED', 600);
    await checkAndWait();
    status.current = failed('CADDY_UNREACHABLE', 600);
    caddy.getCaddyLiveConfigHash.mockResolvedValue(null);
    await checkAndWait();
    expect(caddy.applyCaddyConfig).not.toHaveBeenCalled();
  });

  it('still applies again on drift', async () => {
    status.current = null;
    caddy.getCaddyLiveConfigHash.mockResolvedValue('b'.repeat(64));
    await checkAndWait();
    expect(caddy.applyCaddyConfig).toHaveBeenCalledTimes(1);
  });
});
