/**
 * What the server does when it is stopped (SIGTERM from `docker compose
 * stop` or a rolling restart, SIGINT).
 *
 * Some of it is asynchronous and must finish before the process ends: a
 * PostgreSQL replica stops its jobs, hands the lead over and records that it
 * stopped (src/lib/background-jobs.ts), and API monetization writes the usage
 * it counted (ee/monetization/engine.ts). Next.js's own handler exits the
 * process as soon as its server has closed, a fraction of a second after the
 * signal, which cuts that work off. So the image starts the server with
 * NEXT_MANUAL_SIG_HANDLE set (docker/web/Dockerfile): Next.js leaves the
 * signals alone, and the handler here runs every task registered with
 * onShutdown, waits for them (at most SHUTDOWN_GRACE_MS, within Docker's
 * default 10 seconds before it kills the container), then exits with
 * 128 + the signal number.
 *
 * Without NEXT_MANUAL_SIG_HANDLE (next start, next dev) the tasks still start
 * on the signal, and Next.js exits the process as before.
 *
 * Kept on globalThis: Next.js can load this module more than once in one
 * process (instrumentation and route bundles).
 */

/** How long the tasks get before the process exits anyway. */
export const SHUTDOWN_GRACE_MS = 8_000;

export const MANUAL_SIGNAL_HANDLING_ENV = "NEXT_MANUAL_SIG_HANDLE";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type ShutdownSignal = (typeof SIGNALS)[number];
const EXIT_CODES: Record<ShutdownSignal, number> = { SIGTERM: 143, SIGINT: 130 };

type Task = { name: string; work: () => unknown };

type ShutdownState = {
  tasks: Task[];
  installed: boolean;
  running: Promise<void> | null;
};

type GlobalShutdownState = typeof globalThis & { __ingressiShutdown?: ShutdownState };
const store = globalThis as GlobalShutdownState;

function state(): ShutdownState {
  return (store.__ingressiShutdown ??= { tasks: [], installed: false, running: null });
}

/** What the handler needs of the process (tests pass their own). */
export type ShutdownProcess = Pick<NodeJS.Process, "once" | "exit" | "env">;

let target: ShutdownProcess = process;

/**
 * Runs `run` when the process is stopped, and waits for it (see the module
 * comment). A task registered again under the same name replaces the
 * earlier one. A task that fails is logged.
 */
export function onShutdown(name: string, run: () => unknown): void {
  const s = state();
  s.tasks = [...s.tasks.filter((task) => task.name !== name), { name, work: run }];
  installShutdownHandler();
}

/** Listens for SIGTERM and SIGINT (once per process); called at start-up so the server exits even with no task. */
export function installShutdownHandler(): void {
  const s = state();
  if (s.installed) return;
  s.installed = true;
  for (const signal of SIGNALS) target.once(signal, () => void shutdown(signal));
}

function manualSignalHandling(): boolean {
  const value = target.env[MANUAL_SIGNAL_HANDLING_ENV]?.trim().toLowerCase();
  return Boolean(value) && value !== "0" && value !== "false";
}

/** Runs the registered tasks once, waits for them (at most SHUTDOWN_GRACE_MS), then exits if Next.js leaves that to us. */
export async function shutdown(signal: ShutdownSignal): Promise<void> {
  const s = state();
  s.running ??= (async () => {
    const work = Promise.allSettled(
      s.tasks.map(async (task) => {
        try {
          await task.work();
        } catch (error) {
          console.error(`Shutdown: ${task.name} failed:`, error instanceof Error ? error.message : error);
        }
      })
    );
    let graceOver!: () => void;
    const grace = new Promise<void>((resolve) => {
      graceOver = resolve;
    });
    const timer = setTimeout(() => {
      console.warn(`Shutdown: still stopping after ${SHUTDOWN_GRACE_MS / 1000} s; exiting anyway`);
      graceOver();
    }, SHUTDOWN_GRACE_MS);
    await Promise.race([work, grace]);
    clearTimeout(timer);
  })();
  await s.running;
  if (manualSignalHandling()) target.exit(EXIT_CODES[signal]);
}

/** Tests: forget the tasks and the handler, and use `fake` as the process (null: the real one). */
export function resetShutdownForTests(fake: ShutdownProcess | null = null): void {
  store.__ingressiShutdown = undefined;
  target = fake ?? process;
}
