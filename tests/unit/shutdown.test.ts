/**
 * The shutdown handler (src/lib/shutdown.ts): on SIGTERM or SIGINT it runs
 * the registered tasks and, when Next.js leaves the signals to the
 * application (NEXT_MANUAL_SIG_HANDLE, set by the image), exits only once
 * they finished, or after the grace period.
 *
 * Regression: Next.js's own handler exited a fraction of a second after
 * SIGTERM, before a PostgreSQL replica recorded that it stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installShutdownHandler,
  onShutdown,
  resetShutdownForTests,
  SHUTDOWN_GRACE_MS,
  type ShutdownProcess,
} from '@/src/lib/shutdown';

type FakeProcess = ShutdownProcess & { handlers: Map<string, () => void>; exit: ReturnType<typeof vi.fn> };

function fakeProcess(env: Record<string, string> = {}): FakeProcess {
  const handlers = new Map<string, () => void>();
  const fake = {
    handlers,
    env,
    exit: vi.fn(),
    once(event: string, listener: () => void) {
      handlers.set(event, listener);
      return fake;
    },
  };
  return fake as unknown as FakeProcess;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

let proc: FakeProcess;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetShutdownForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the shutdown handler', () => {
  it('exits with 128 + the signal only after the tasks finished, when the signals are left to it', async () => {
    proc = fakeProcess({ NEXT_MANUAL_SIG_HANDLE: 'true' });
    resetShutdownForTests(proc);
    const task = deferred();
    const finished: string[] = [];
    onShutdown('recording the stop', async () => {
      await task.promise;
      finished.push('recorded');
    });
    proc.handlers.get('SIGTERM')!();
    await flush();
    expect(proc.exit).not.toHaveBeenCalled();
    proc.exit.mockImplementation(() => finished.push('exit'));
    task.resolve();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(143));
    expect(finished).toEqual(['recorded', 'exit']);
  });

  it('exits with 130 on SIGINT, and at once without tasks', async () => {
    proc = fakeProcess({ NEXT_MANUAL_SIG_HANDLE: '1' });
    resetShutdownForTests(proc);
    installShutdownHandler();
    proc.handlers.get('SIGINT')!();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(130));
  });

  it('runs the tasks but leaves the exit to Next.js without NEXT_MANUAL_SIG_HANDLE', async () => {
    proc = fakeProcess();
    resetShutdownForTests(proc);
    const run = vi.fn();
    onShutdown('flush', run);
    proc.handlers.get('SIGTERM')!();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await flush();
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('exits after the grace period when a task does not finish', async () => {
    vi.useFakeTimers();
    proc = fakeProcess({ NEXT_MANUAL_SIG_HANDLE: 'true' });
    resetShutdownForTests(proc);
    onShutdown('stuck', () => new Promise(() => undefined));
    proc.handlers.get('SIGTERM')!();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
    expect(proc.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(143));
  });

  it('logs a task that fails and still waits for the others', async () => {
    proc = fakeProcess({ NEXT_MANUAL_SIG_HANDLE: 'true' });
    resetShutdownForTests(proc);
    const slow = deferred();
    const done = vi.fn();
    onShutdown('failing', () => Promise.reject(new Error('cannot write')));
    onShutdown('slow', async () => {
      await slow.promise;
      done();
    });
    proc.handlers.get('SIGTERM')!();
    await flush();
    expect(proc.exit).not.toHaveBeenCalled();
    slow.resolve();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(143));
    expect(done).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Shutdown: failing failed:', 'cannot write');
  });

  it('keeps one task per name, and runs the tasks once whatever the signals', async () => {
    proc = fakeProcess({ NEXT_MANUAL_SIG_HANDLE: 'true' });
    resetShutdownForTests(proc);
    const first = vi.fn();
    const second = vi.fn();
    onShutdown('replica', first);
    onShutdown('replica', second);
    proc.handlers.get('SIGTERM')!();
    proc.handlers.get('SIGINT')!();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledTimes(2));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
