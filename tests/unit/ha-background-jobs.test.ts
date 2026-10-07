/**
 * Leader-only gating of every start-up task, scheduler, sync and background
 * job (src/lib/background-jobs.ts, src/instrumentation.ts): a standalone
 * dashboard and a cluster leader with a valid lease start them all; a standby,
 * and a leader whose lease can no longer be vouched for, start none. Nothing
 * in instrumentation.ts starts work outside the job list, and no job is
 * started from anywhere else. The request-path workers of shared state run
 * on every node, standbys included, and write nothing to the database. A
 * PostgreSQL replica that leads again and again registers its shutdown work
 * once (src/lib/shutdown.ts), not one SIGTERM listener per term, and nothing
 * in the server listens for SIGTERM or SIGINT outside src/lib/shutdown.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const starters = vi.hoisted(() => ({
  ensureAdminUser: vi.fn(async () => {}),
  migrateLegacyCertificateStorage: vi.fn(async () => 0),
  migrateLegacyCaPrivateKeys: vi.fn(async () => 0),
  reencryptStoredSecrets: vi.fn(async () => ({ reencrypted: 0, encryptedPlaintext: 0, failed: 0, clearedOAuthTokens: 0 })),
  purgeDeletedDatabaseContent: vi.fn(() => false),
  importLegacyWafExclusionsNow: vi.fn(() => 0),
  applyCaddyConfig: vi.fn(async () => {}),
  startMonetizationEngine: vi.fn(),
  startMonetizationJobs: vi.fn(() => () => {}),
  startCaddyMonitoring: vi.fn(),
  initClickHouse: vi.fn(async () => {}),
  initLogParser: vi.fn(async () => {}),
  initWafLogParser: vi.fn(async () => {}),
  startAuditBackgroundJobs: vi.fn(() => () => {}),
  getInstanceMode: vi.fn(async () => 'master'),
  startPullAgent: vi.fn(() => false),
  startAlertEvaluator: vi.fn(),
  startBackupScheduler: vi.fn(),
  startApprovalScheduler: vi.fn(),
  startAccessListExpiry: vi.fn(),
  startAccessReviewScheduler: vi.fn(),
  startFleetScheduler: vi.fn(),
  startDirectoryHealthChecks: vi.fn(),
  startReportScheduler: vi.fn(),
  startDigestScheduler: vi.fn(),
  startSharedStateDrain: vi.fn(),
  setSharedStateLeaderCheck: vi.fn(),
  startSharedStateNodeWorker: vi.fn(),
}));
/** The database start-up runs on every node, before the jobs (src/lib/db/startup.ts). */
const runDatabaseStartup = vi.hoisted(() => vi.fn(async () => {}));
/** What stopping the server stops. */
const stoppers = vi.hoisted(() => ({ stopLogParser: vi.fn(), stopWafLogParser: vi.fn(), closeClickHouse: vi.fn(async () => {}) }));

vi.mock('../../src/lib/config', () => ({ validateProductionConfig: () => {} }));
// The values requests read from memory (src/lib/db/cached-value.ts) are not loaded here.
vi.mock('../../src/lib/startup-caches', () => ({ loadStartupCaches: async () => {} }));
vi.mock('../../src/lib/init-db', () => ({ ensureAdminUser: starters.ensureAdminUser }));
vi.mock('../../src/lib/models/user', () => ({ findSignInUsernamesToReview: async () => [] }));
vi.mock('../../src/lib/models/certificates', () => ({ migrateLegacyCertificateStorage: starters.migrateLegacyCertificateStorage }));
vi.mock('../../src/lib/models/ca-certificates', () => ({ migrateLegacyCaPrivateKeys: starters.migrateLegacyCaPrivateKeys }));
vi.mock('../../src/lib/secret-rotation', () => ({ reencryptStoredSecrets: starters.reencryptStoredSecrets }));
vi.mock('../../src/lib/db', () => ({ purgeDeletedDatabaseContent: starters.purgeDeletedDatabaseContent }));
vi.mock('../../src/lib/db/startup', () => ({ runDatabaseStartup }));
vi.mock('../../src/lib/models/waf-exclusion-mirror', () => ({ importLegacyWafExclusionsNow: starters.importLegacyWafExclusionsNow }));
vi.mock('../../src/lib/caddy', () => ({ applyCaddyConfig: starters.applyCaddyConfig }));
vi.mock('../../ee/monetization/engine', () => ({ startMonetizationEngine: starters.startMonetizationEngine }));
vi.mock('../../ee/monetization/jobs', () => ({ startMonetizationJobs: starters.startMonetizationJobs }));
vi.mock('../../src/lib/caddy-monitor', () => ({ startCaddyMonitoring: starters.startCaddyMonitoring }));
vi.mock('../../src/lib/clickhouse/client', () => ({ initClickHouse: starters.initClickHouse, closeClickHouse: stoppers.closeClickHouse }));
vi.mock('../../src/lib/log-parser', () => ({
  initLogParser: starters.initLogParser,
  parseNewLogEntries: async () => {},
  stopLogParser: stoppers.stopLogParser,
}));
vi.mock('../../src/lib/waf-log-parser', () => ({
  initWafLogParser: starters.initWafLogParser,
  parseNewWafLogEntries: async () => {},
  stopWafLogParser: stoppers.stopWafLogParser,
}));
// A PostgreSQL replica's membership, admitted at once (src/lib/cluster-nodes.ts has its own tests).
vi.mock('../../src/lib/cluster-nodes', () => ({
  currentReplicaIdentity: () => null,
  resolveNodeIdentity: () => ({ nodeId: 'web-1' }),
  ReplicaMembership: class {
    async join() {
      return 'admitted';
    }
    retryUntilAdmitted() {}
    startHeartbeat() {}
    async leadershipChanged() {}
    async stop() {}
  },
}));
vi.mock('../../ee/audit/worker', () => ({ startAuditBackgroundJobs: starters.startAuditBackgroundJobs }));
vi.mock('../../src/lib/instance-sync', () => ({
  getInstanceMode: starters.getInstanceMode,
  getSyncIntervalMs: () => 60_000,
  runPeriodicInstanceSync: async () => null,
}));
vi.mock('../../ee/fleet/pull-agent', () => ({ startPullAgent: starters.startPullAgent }));
vi.mock('../../ee/alerting/scheduler', () => ({ startAlertEvaluator: starters.startAlertEvaluator }));
vi.mock('../../ee/backups/scheduler', () => ({ startBackupScheduler: starters.startBackupScheduler }));
vi.mock('../../ee/approvals/scheduler', () => ({ startApprovalScheduler: starters.startApprovalScheduler }));
vi.mock('../../src/lib/access-list-expiry', () => ({ startAccessListExpiry: starters.startAccessListExpiry }));
vi.mock('../../ee/access-reviews/scheduler', () => ({ startAccessReviewScheduler: starters.startAccessReviewScheduler }));
vi.mock('../../ee/fleet/scheduler', () => ({ startFleetScheduler: starters.startFleetScheduler }));
vi.mock('../../ee/ldap/health', () => ({ startDirectoryHealthChecks: starters.startDirectoryHealthChecks }));
vi.mock('../../ee/compliance/scheduler', () => ({ startReportScheduler: starters.startReportScheduler }));
vi.mock('../../ee/ai/digest-scheduler', () => ({ startDigestScheduler: starters.startDigestScheduler }));
vi.mock('../../ee/high-availability/shared-state/workers', () => ({
  startSharedStateDrain: starters.startSharedStateDrain,
  startSharedStateNodeWorker: starters.startSharedStateNodeWorker,
}));
vi.mock('../../ee/high-availability/shared-state/leader', () => ({ setSharedStateLeaderCheck: starters.setSharedStateLeaderCheck }));

import { register } from '../../src/instrumentation';
import { mayRunBackgroundJobs, startBackgroundJobs, stopBackgroundJobs } from '../../src/lib/background-jobs';
import { setLeaderElectorForTests, type LeaderElector, type LeadershipListener } from '../../src/lib/db/leader';
import { resetShutdownForTests, type ShutdownProcess } from '../../src/lib/shutdown';
import { resetHaStatusCache, startLeaderWatchdog } from '@/ee/high-availability/role';
import { logAuditEvent } from '../../src/lib/audit';

const ALL = Object.keys(starters) as Array<keyof typeof starters>;
/** Started on every node, standbys included: they serve request paths and never write to the database. */
const EVERY_NODE: Array<keyof typeof starters> = ['setSharedStateLeaderCheck', 'startSharedStateNodeWorker'];

let dir: string;
let sigtermListeners: unknown[];

function writeStatus(status: Record<string, unknown>) {
  const path = join(dir, 'status.json');
  writeFileSync(path, JSON.stringify({ version: 1, nodeId: 'web-1', ...status }));
  vi.stubEnv('HA_STATUS_FILE', path);
  resetHaStatusCache();
}

function called(): string[] {
  return ALL.filter((name) => starters[name].mock.calls.length > 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'ha-jobs-'));
  for (const starter of Object.values(starters)) starter.mockClear();
  runDatabaseStartup.mockClear();
  vi.mocked(logAuditEvent).mockClear();
  // Jobs marked skipInTests start too, as in production.
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  // SQLite and its high availability cluster; PostgreSQL replicas elect their own leader
  // (tests/unit/replica-background-jobs.test.ts, tests/integration/pg/replica-start.test.ts).
  vi.stubEnv('DATABASE_DIALECT', 'sqlite');
  vi.stubEnv('DATABASE_URL', ':memory:');
  sigtermListeners = process.listeners('SIGTERM');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetHaStatusCache();
});

afterEach(() => {
  for (const listener of process.listeners('SIGTERM')) {
    if (!sigtermListeners.includes(listener)) process.off('SIGTERM', listener);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetHaStatusCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('server start-up', () => {
  it('starts every task and job on a standalone dashboard', async () => {
    await register();
    expect(called()).toEqual(ALL);
    expect(runDatabaseStartup).toHaveBeenCalledTimes(1);
    // Before any job: the first start-up task runs after it.
    expect(runDatabaseStartup.mock.invocationCallOrder[0]).toBeLessThan(starters.ensureAdminUser.mock.invocationCallOrder[0]);
    expect(vi.mocked(logAuditEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ha_leader_started' }));
  });

  it('starts every task and job on the leader of a cluster, and records the takeover', async () => {
    vi.stubEnv('HA_ROLE', 'leader');
    writeStatus({
      role: 'leader',
      fenceAt: new Date(Date.now() + 13_000).toISOString(),
      lease: { holder: 'web-1', epoch: 4, checkedAt: null, error: null },
      lastRestore: { at: new Date().toISOString(), ok: true, source: 'replica', replicaId: 'e3-aaaaaaaa', durationMs: 2100, error: null },
      replication: null,
    });
    await register();
    expect(called()).toEqual(ALL);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: 'ha_leader_started',
        entityType: 'high_availability',
        summary: 'Node web-1 became the leader of the dashboard cluster (epoch 4): restored from the newest replica (e3-aaaaaaaa)',
      })
    );
  });

  it('starts none on a standby but the request-path workers: it neither writes, pushes configuration nor runs schedulers', async () => {
    vi.stubEnv('HA_ROLE', 'standby');
    writeStatus({ role: 'standby', fenceAt: null });
    await register();
    expect(called()).toEqual(EVERY_NODE);
    // The database start-up still runs (it skips the data migrations on the read-only copy).
    expect(runDatabaseStartup).toHaveBeenCalledTimes(1);
    // The leader rule shared state is given refuses the standby.
    const check = starters.setSharedStateLeaderCheck.mock.calls[0][0] as unknown as () => Promise<boolean>;
    expect(await check()).toBe(false);
  });

  it('starts none on a leader whose lease can no longer be vouched for', async () => {
    vi.stubEnv('HA_ROLE', 'leader');
    writeStatus({ role: 'leader', fenceAt: new Date(Date.now() - 1_000).toISOString() });
    await register();
    expect(called()).toEqual(EVERY_NODE);
    writeStatus({ role: 'promoting', fenceAt: new Date(Date.now() + 13_000).toISOString() });
    expect(mayRunBackgroundJobs()).toBe(false);
  });

  it('stops a start-up that fails a critical task, as before', async () => {
    const failure = new Error('cannot harden');
    const job = vi.fn();
    await expect(
      startBackgroundJobs([
        { name: 'critical', critical: true, start: () => Promise.reject(failure) },
        { name: 'later', start: job },
      ])
    ).rejects.toBe(failure);
    expect(job).not.toHaveBeenCalled();
    expect(await startBackgroundJobs([{ name: 'broken', start: () => Promise.reject(new Error('x')) }, { name: 'later', start: job }])).toEqual(['later']);
  });
});

/** The election of a PostgreSQL replica, changed by hand. */
class FakeElector {
  leader = false;
  readonly listeners = new Set<LeadershipListener>();
  isLeader() {
    return this.leader;
  }
  onLeadershipChange(listener: LeadershipListener) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  async set(leader: boolean) {
    this.leader = leader;
    await Promise.all([...this.listeners].map(async (listener) => listener(leader)));
  }
  async start() {
    await this.set(true);
  }
  async stop() {
    if (this.leader) await this.set(false);
  }
  async stepDown() {
    await this.stop();
  }
  status() {
    return { state: this.leader ? 'leader' : 'follower', leader: this.leader, leaderSince: null, lastHeartbeatAt: null, terms: 0, lastError: null, lastErrorAt: null };
  }
}

describe('a PostgreSQL replica stopping', () => {
  afterEach(async () => {
    await stopBackgroundJobs();
    setLeaderElectorForTests(null);
    resetShutdownForTests(null);
  });

  it('registers its shutdown work once however often it leads, and runs it once on SIGTERM', async () => {
    vi.stubEnv('DATABASE_DIALECT', 'postgres');
    vi.stubEnv('DATABASE_URL', 'postgres://ingressi@db.example.com:5432/ingressi');
    const elector = new FakeElector();
    setLeaderElectorForTests(elector as unknown as LeaderElector);
    const handlers = new Map<string, Array<() => void>>();
    const fake = {
      env: {},
      exit: vi.fn(),
      once(event: string, listener: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), listener]);
        return fake;
      },
    };
    resetShutdownForTests(fake as unknown as ShutdownProcess);
    const before = { term: process.listenerCount('SIGTERM'), interrupt: process.listenerCount('SIGINT') };

    await register();
    expect(starters.initLogParser).toHaveBeenCalledTimes(1);
    // Ten more terms: the replica stops leading and leads again.
    for (let term = 0; term < 10; term += 1) {
      await elector.set(false);
      await elector.set(true);
      await vi.waitFor(() => expect(starters.initWafLogParser).toHaveBeenCalledTimes(term + 2));
    }
    expect(starters.initLogParser).toHaveBeenCalledTimes(11);
    // One listener per signal, on the shutdown handler; none on the process itself.
    expect(handlers.get('SIGTERM')).toHaveLength(1);
    expect(handlers.get('SIGINT')).toHaveLength(1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGINT')).toBe(before.interrupt);

    // Stopping runs each task once.
    handlers.get('SIGTERM')![0]();
    await vi.waitFor(() => expect(stoppers.closeClickHouse).toHaveBeenCalledTimes(1));
    expect(stoppers.stopLogParser).toHaveBeenCalledTimes(1);
    expect(stoppers.stopWafLogParser).toHaveBeenCalledTimes(1);
  });
});

describe('leader watchdog', () => {
  it('stops the dashboard once the supervisor stops vouching for the lease', () => {
    vi.stubEnv('HA_ROLE', 'leader');
    writeStatus({ role: 'leader', fenceAt: new Date(Date.now() + 3_000).toISOString() });
    const fenced = vi.fn();
    const stop = startLeaderWatchdog(fenced);
    vi.advanceTimersByTime(2_000);
    expect(fenced).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(fenced).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing outside a cluster', () => {
    const fenced = vi.fn();
    startLeaderWatchdog(fenced)();
    vi.advanceTimersByTime(10_000);
    expect(fenced).not.toHaveBeenCalled();
  });
});

const ROOT = process.cwd();

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(ROOT, path));
  }
  return out;
}

describe('stopping', () => {
  it('goes through src/lib/shutdown.ts: nothing else listens for SIGTERM or SIGINT', () => {
    const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'ee')), ...sources(join(ROOT, 'app')), 'proxy.ts'];
    // The SQLite cluster's supervisor is a program of its own (it starts the server as a child process).
    const ALLOWED = ['src/lib/shutdown.ts', 'ee/high-availability/cluster/main.ts'];
    const listening = files.filter((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return /process\.(?:on|once|addListener|prependListener|prependOnceListener)\(\s*(?:["'`]SIG(?:TERM|INT)["'`]|signal\b)/.test(text);
    });
    expect(listening.filter((file) => !ALLOWED.includes(file))).toEqual([]);
  });
});

describe('the job list', () => {
  it('is the only place instrumentation.ts starts work', () => {
    const source = readFileSync(join(ROOT, 'src/instrumentation.ts'), 'utf8');
    const registerBody = source.slice(source.indexOf('export async function register()'));
    const imports = [...registerBody.matchAll(/await import\("([^"]+)"\)/g)].map((match) => match[1]);
    // The shutdown handler first: it starts no work, it only waits for it when the server is stopped.
    expect(imports).toEqual(['./lib/shutdown', './lib/config', '../ee/high-availability/role', './lib/db/startup', './lib/startup-caches', './lib/background-jobs']);
    expect(registerBody).toContain('await runDatabaseStartup();');
    // Every node loads the values requests read from memory; it writes nothing.
    expect(registerBody).toContain('await loadStartupCaches();');
    expect(registerBody).not.toMatch(/setInterval\(|setTimeout\(|process\.on\(/);
    expect(registerBody).toContain('await startEveryNodeJobs(EVERY_NODE_JOBS);');
    expect(registerBody).toContain('await startBackgroundJobs(SERVER_JOBS);');
  });

  it('starts every scheduler from instrumentation.ts only', () => {
    const names = [
      'startMonetizationEngine', 'startCaddyMonitoring', 'initLogParser', 'initWafLogParser', 'startAuditBackgroundJobs',
      'runPeriodicInstanceSync', 'startPullAgent', 'startAlertEvaluator', 'startBackupScheduler', 'startApprovalScheduler',
      'startAccessListExpiry', 'startAccessReviewScheduler', 'startFleetScheduler', 'startDirectoryHealthChecks',
      'startReportScheduler', 'startDigestScheduler', 'startSharedStateDrain', 'startSharedStateNodeWorker',
    ];
    const files = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'ee')), ...sources(join(ROOT, 'app'))];
    for (const name of names) {
      const callers = files.filter((file) => {
        const text = readFileSync(join(ROOT, file), 'utf8');
        return new RegExp(`(?<!function |\\.)\\b${name}\\(`).test(text);
      });
      expect(callers, name).toEqual(['src/instrumentation.ts']);
    }
  });
});
