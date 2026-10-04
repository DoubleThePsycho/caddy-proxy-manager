/**
 * Benchmarks the database hot paths on a realistic installation (300 proxy
 * hosts with access lists, forward auth on a third, WAF, 50 users, groups,
 * L4 hosts, API monetization; scripts/bench/seed.ts), as production runs
 * them: under Bun, NODE_ENV=production, on a SQLite file.
 *
 * Paths: the full Caddy configuration build, the forward-auth verify route
 * (valid and invalid session cookie, one at a time and 32 at once), the API
 * monetization gate and its usage flush and reload, the proxy hosts list
 * reads (the model, the dashboard page's reads, the REST page), a host
 * update, a single-row read, a read-modify-write transaction, and the verify
 * route while a writer keeps opening transactions.
 *
 * Every path warms up first, then runs enough iterations for a stable median
 * and p95. The last line of the output is the result as JSON (BENCH_JSON).
 *
 * Usage (on the staging VM, never on a workstation):
 *   bun run bench:db [--quick|--scale=N] [--memory] [--count|--profile] [--only=name,name] [--label=text]
 *     --quick    a tenth of the iterations (a smoke run)
 *     --scale=N  N times the iterations (with --only, for a closer look at one path)
 *     --memory   the database file on tmpfs (/dev/shm): no disk I/O, so the
 *                database layer's own cost stands out (":memory:" would skip
 *                the schema migrations)
 *     --count    no timing: the SQL statements each path runs, once warm
 *     --profile  where each path's time goes: preparing statements, running
 *                them in SQLite, and everything else (query building, row
 *                mapping, the application, the database layer's machinery)
 *     --only=    only the paths whose names start with one of these prefixes
 *
 * The database API is the only thing that differs between the synchronous
 * and the asynchronous code: it lives in scripts/bench/db-adapter.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Options and environment (before any application module loads) ──

type Options = {
  quick: boolean;
  scale: number;
  memory: boolean;
  count: boolean;
  profile: boolean;
  only: string[] | null;
  label: string;
};

function parseOptions(argv: string[]): Options {
  const options: Options = { quick: false, scale: 1, memory: false, count: false, profile: false, only: null, label: "" };
  for (const arg of argv) {
    if (arg === "--quick") options.quick = true;
    else if (arg.startsWith("--scale=")) options.scale = Number(arg.slice("--scale=".length));
    else if (arg === "--memory") options.memory = true;
    else if (arg === "--count") options.count = true;
    else if (arg === "--profile") options.profile = true;
    else if (arg.startsWith("--only=")) options.only = arg.slice("--only=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!(options.scale > 0)) throw new Error("--scale must be a positive number");
  return options;
}

const options = parseOptions(process.argv.slice(2));
if (options.memory && !existsSync("/dev/shm")) throw new Error("--memory needs /dev/shm (tmpfs)");
const databaseDirectory = mkdtempSync(join(options.memory ? "/dev/shm" : tmpdir(), "ingressi-bench-"));

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "production";
env.DATABASE_URL = join(databaseDirectory, "bench.db");
// A fixed, obviously fake secret: the forward-auth proof in the Caddy
// document derives from it, so documents can be compared across runs.
env.SESSION_SECRET = "bench-only-session-secret-not-for-production-use";
env.BASE_URL = "http://localhost:3000";
// Nothing here applies a configuration; an address nothing listens on, in case.
env.CADDY_API_URL = "http://127.0.0.1:9";
for (const name of ["DATABASE_DIALECT", "HA_ROLE", "INSTANCE_MODE", "INSTANCE_SYNC_TOKEN", "FORWARD_AUTH_ALLOWED_PORTS"]) {
  delete env[name];
}

// ── Statistics ──

type Summary = {
  iterations: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  return {
    iterations: sorted.length,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    meanMs: mean,
    minMs: sorted[0] ?? Number.NaN,
    maxMs: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 100) return value.toFixed(1);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

// ── Statement counting and timing (--count, --profile) ──

type StatementCounts = {
  statements: number;
  reads: number;
  writes: number;
  transactionControl: number;
  bySql: Map<string, number>;
  /** Time in client.prepare (compiling SQL). */
  prepareMs: number;
  /** Time in statements' all/get/run/values and in exec/run on the connection. */
  executeMs: number;
};

const TRANSACTION_CONTROL = /^\s*(begin|commit|end|rollback|savepoint|release|pragma\s+query_only)\b/i;
const READ_STATEMENT = /^\s*(select|with|pragma)\b/i;

function newCounts(): StatementCounts {
  return { statements: 0, reads: 0, writes: 0, transactionControl: 0, bySql: new Map(), prepareMs: 0, executeMs: 0 };
}

type LooseFunction = (...args: unknown[]) => unknown;
type LooseClient = Record<string, unknown> & { prepare: LooseFunction; exec?: LooseFunction; run?: LooseFunction };

/**
 * Counts every statement the connection executes, whichever API runs it:
 * statements are wrapped where they are prepared (both the synchronous
 * driver, which prepares on every query, and the asynchronous runner, which
 * caches what it prepared), and exec/run cover BEGIN, COMMIT and PRAGMA.
 * Installed before the seed, so the driver's cached BEGIN/COMMIT statements
 * are wrapped as well.
 */
function installStatementCounter(client: LooseClient): { counts: () => StatementCounts; reset: () => void } {
  let counts = newCounts();
  const record = (sql: string) => {
    const text = sql.trim().replace(/\s+/g, " ");
    if (TRANSACTION_CONTROL.test(text)) {
      counts.transactionControl += 1;
    } else {
      counts.statements += 1;
      if (READ_STATEMENT.test(text)) counts.reads += 1;
      else counts.writes += 1;
    }
    const key = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    counts.bySql.set(key, (counts.bySql.get(key) ?? 0) + 1);
  };
  const executing = new Set(["all", "get", "run", "values", "iterate"]);
  const prepare = client.prepare.bind(client);
  client.prepare = (...args: unknown[]) => {
    const t0 = performance.now();
    const statement = prepare(...args) as object;
    counts.prepareMs += performance.now() - t0;
    const sql = String(args[0]);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (typeof property === "string" && executing.has(property)) {
          return (...params: unknown[]) => {
            record(sql);
            const t0 = performance.now();
            try {
              return (value as LooseFunction).apply(target, params);
            } finally {
              counts.executeMs += performance.now() - t0;
            }
          };
        }
        return (value as LooseFunction).bind(target);
      },
    });
  };
  for (const method of ["exec", "run"] as const) {
    const original = client[method];
    if (typeof original !== "function") continue;
    const bound = original.bind(client);
    client[method] = (...args: unknown[]) => {
      record(String(args[0]));
      const t0 = performance.now();
      try {
        return bound(...args);
      } finally {
        counts.executeMs += performance.now() - t0;
      }
    };
  }
  return { counts: () => counts, reset: () => { counts = newCounts(); } };
}

// ── Benchmark cases ──

type BenchCase = {
  name: string;
  description: string;
  iterations: number;
  warmup: number;
  /** Untimed work before each iteration. */
  setup?: () => Promise<void>;
  run: () => Promise<unknown>;
  /** Throws when the path did not do what it should (checked on the first run). */
  check?: (result: unknown) => void | Promise<void>;
  /** Requests per iteration, for cases that run several at once. */
  perIteration?: number;
  /** Measures itself (concurrent load); returns the latencies. */
  custom?: (iterations: number) => Promise<{ samples: number[]; extra: Record<string, number> }>;
};

type CaseResult = Summary & {
  name: string;
  description: string;
  perIteration: number;
  extra?: Record<string, number>;
  counts?: { statements: number; reads: number; writes: number; transactionControl: number; topSql: Array<[string, number]> };
  /** --profile: per iteration, in milliseconds. */
  profile?: { totalMs: number; prepareMs: number; executeMs: number; otherMs: number; statements: number };
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const scale = options.quick ? 0.1 : options.scale;
  const n = (count: number) => Math.max(5, Math.round(count * scale));

  const { sqlite } = await import("@/src/lib/db");
  const counter = options.count || options.profile ? installStatementCounter(sqlite as unknown as LooseClient) : null;

  const { seedBenchDatabase, SEED_SIZE } = await import("./seed");
  const adapter = await import("./db-adapter");
  const { buildCaddyDocument } = await import("@/src/lib/caddy");
  const { GET: verifyRoute } = await import("@/app/api/forward-auth/verify/route");
  const { NextRequest } = await import("next/server");
  const {
    FORWARD_AUTH_COOKIE_NAME,
    FORWARD_AUTH_PROXY_HOST_ID_HEADER,
    FORWARD_AUTH_PROXY_PROOF_HEADER,
    getForwardAuthProxyProof,
  } = await import("@/src/lib/forward-auth-trust");
  const { handleGateRequest } = await import("@/ee/monetization/gate-response");
  const { flushUsage, reloadMonetization } = await import("@/ee/monetization/engine");
  const { GATE_HOST_ID_HEADER, GATE_TOKEN_HEADER } = await import("@/ee/monetization/types");
  const { countProxyHosts, listProxyHosts, listProxyHostsPaginated, updateProxyHost } = await import("@/src/lib/models/proxy-hosts");
  const { listCertificates } = await import("@/src/lib/models/certificates");
  const { listCaCertificates } = await import("@/src/lib/models/ca-certificates");
  const { listAccessLists } = await import("@/src/lib/models/access-lists");
  const { getAuthentikSettings, getForwardAuthSettings } = await import("@/src/lib/settings");
  const { listMtlsRoles } = await import("@/src/lib/models/mtls-roles");
  const { listIssuedClientCertificates } = await import("@/src/lib/models/issued-client-certificates");
  const { listUsers } = await import("@/src/lib/models/user");
  const { listGroups } = await import("@/src/lib/models/groups");
  const { getForwardAuthAccessForHost } = await import("@/src/lib/models/forward-auth");
  const { runAsChangeBatch } = await import("@/src/lib/change-batch");
  const { logAuditEvent } = await import("@/src/lib/audit");

  const seedStartedAt = performance.now();
  const seeded = seedBenchDatabase();
  const seedMs = performance.now() - seedStartedAt;

  // ── Forward auth ──
  const proof = getForwardAuthProxyProof();
  const audienceHost = new URL(seeded.forwardAuthOrigin).host;
  const verifyHeaders = (token: string) => ({
    [FORWARD_AUTH_PROXY_PROOF_HEADER]: proof,
    [FORWARD_AUTH_PROXY_HOST_ID_HEADER]: String(seeded.forwardAuthHostId),
    "x-forwarded-proto": "https",
    "x-forwarded-host": audienceHost,
    "x-forwarded-uri": "/dashboard?tab=overview",
    cookie: `${FORWARD_AUTH_COOKIE_NAME}=${token}`,
  });
  const validHeaders = verifyHeaders(seeded.forwardAuthToken);
  // Well-formed, but no session has it.
  const invalidHeaders = verifyHeaders(createHash("sha256").update("bench-unknown-session").digest("hex"));
  const verify = (headers: Record<string, string>) =>
    verifyRoute(new NextRequest("http://web:3000/api/forward-auth/verify", { headers }));
  const expectStatus = (status: number) => (result: unknown) => {
    const response = result as Response;
    if (response.status !== status) throw new Error(`Expected HTTP ${status}, got ${response.status}`);
  };

  // ── Monetization gate ──
  const gateHeaders = seeded.consumerKeys.map(
    (key, index) =>
      new Headers({
        [GATE_TOKEN_HEADER]: seeded.gateToken,
        [GATE_HOST_ID_HEADER]: String(seeded.monetizedHostIds[index % seeded.monetizedHostIds.length]),
        authorization: `Bearer ${key}`,
      })
  );
  let gateCall = 0;
  const gate = () => handleGateRequest(gateHeaders[gateCall++ % gateHeaders.length]);
  const chargeEveryConsumer = async () => {
    for (const headers of gateHeaders) {
      const response = await handleGateRequest(headers);
      if (response.status !== 200) throw new Error(`Gate refused a seeded consumer: HTTP ${response.status}`);
    }
  };

  // ── Dashboard reads (what app/(dashboard)/proxy-hosts/page.tsx loads, without auth and analytics) ──
  const PER_PAGE = 25;
  const proxyHostsPageData = async () => {
    const [allHosts, certificates, caCertificates, accessLists, authentik, forwardAuth] = await Promise.all([
      listProxyHosts(),
      listCertificates(),
      listCaCertificates(),
      listAccessLists(),
      getAuthentikSettings(),
      getForwardAuthSettings(),
    ]);
    const [roles, issued, allUsers, allGroups] = await Promise.all([
      listMtlsRoles(),
      listIssuedClientCertificates(),
      listUsers(),
      listGroups(),
    ]);
    const page = allHosts.slice(0, PER_PAGE);
    const grants = await Promise.all(
      page.filter((host) => host.ingressiForwardAuth?.enabled).map((host) => getForwardAuthAccessForHost(host.id))
    );
    return { allHosts, certificates, caCertificates, accessLists, authentik, forwardAuth, roles, issued, allUsers, allGroups, grants };
  };

  // ── Writes ──
  let writeCount = 0;
  const stamp = () => new Date(Date.parse("2026-10-01T00:00:00.000Z") + ++writeCount * 1000).toISOString();
  const updateHost = async () => {
    const name = `App write ${++writeCount}`;
    const { result } = await runAsChangeBatch(() => updateProxyHost(seeded.writeHostId, { name }, seeded.adminUserId));
    await logAuditEvent({
      userId: seeded.adminUserId,
      action: "update",
      entityType: "proxy_host",
      entityId: seeded.writeHostId,
      summary: `Updated proxy host ${name}`,
      data: { name },
    });
    return { result, name };
  };

  // ── Mixed load: verify latency while a writer opens transactions back to back ──
  const verifyDuringWrites = async (iterations: number) => {
    let stop = false;
    let writes = 0;
    const writer = (async () => {
      while (!stop) {
        await adapter.readModifyWrite(seeded.writeHostId, stamp());
        writes += 1;
        // Requests arrive as I/O events: yield between them, as a server does.
        await yieldToEventLoop();
      }
    })();
    const samples: number[] = [];
    const began = performance.now();
    for (let i = 0; i < iterations; i++) {
      await yieldToEventLoop();
      const t0 = performance.now();
      const response = await verify(validHeaders);
      samples.push(performance.now() - t0);
      if (response.status !== 200) throw new Error(`Verify under load: HTTP ${response.status}`);
    }
    const elapsed = performance.now() - began;
    stop = true;
    await writer;
    return { samples, extra: { writesDuring: writes, writesPerSecond: (writes / elapsed) * 1000 } };
  };

  let documentHash = "";
  let documentBytes = 0;
  const cases: BenchCase[] = [
    {
      name: "caddy.buildDocument",
      description: "buildCaddyDocument(): the full Caddy configuration from the database",
      iterations: n(80),
      warmup: 10,
      run: () => buildCaddyDocument(),
      check: (result) => {
        const json = JSON.stringify(result);
        documentBytes = json.length;
        documentHash = createHash("sha256").update(json).digest("hex");
        const apps = (result as { apps?: { http?: unknown } }).apps;
        if (!apps?.http) throw new Error("The Caddy document has no HTTP app");
      },
    },
    {
      name: "forwardAuth.verify.valid",
      description: "GET /api/forward-auth/verify, valid session cookie, access through a group",
      iterations: n(3000),
      warmup: 300,
      run: () => verify(validHeaders),
      check: (result) => {
        expectStatus(200)(result);
        const user = (result as Response).headers.get("X-Ingressi-User");
        if (user !== "user9") throw new Error(`Verify returned user ${user}`);
      },
    },
    {
      name: "forwardAuth.verify.invalid",
      description: "GET /api/forward-auth/verify, unknown session cookie (401)",
      iterations: n(3000),
      warmup: 300,
      run: () => verify(invalidHeaders),
      check: expectStatus(401),
    },
    {
      name: "forwardAuth.verify.concurrent32",
      description: "32 valid verify requests at once (time for the batch)",
      iterations: n(200),
      warmup: 20,
      perIteration: 32,
      run: () => Promise.all(Array.from({ length: 32 }, () => verify(validHeaders))),
      check: (result) => {
        for (const response of result as Response[]) expectStatus(200)(response);
      },
    },
    {
      name: "monetization.gate",
      description: "API monetization gate decision (in memory after the first load)",
      iterations: n(20000),
      warmup: 2000,
      run: gate,
      check: expectStatus(200),
    },
    {
      name: "monetization.flush",
      description: "flushUsage() with all 40 consumers charged since the last flush (one write transaction)",
      iterations: n(300),
      warmup: 20,
      setup: chargeEveryConsumer,
      run: () => flushUsage(),
      check: (result) => {
        const flushed = result as { consumers: number };
        if (flushed.consumers !== SEED_SIZE.monetizationConsumers) throw new Error(`Flushed ${flushed.consumers} consumers`);
      },
    },
    {
      name: "monetization.reload",
      description: "reloadMonetization(): re-read plans, consumers, keys and hosts",
      iterations: n(500),
      warmup: 50,
      run: () => reloadMonetization({ quiet: true }),
    },
    {
      name: "proxyHosts.list",
      description: "listProxyHosts(): all 300 hosts, parsed",
      iterations: n(300),
      warmup: 30,
      run: () => listProxyHosts(),
      check: (result) => {
        if ((result as unknown[]).length !== SEED_SIZE.proxyHosts) throw new Error("Wrong host count");
      },
    },
    {
      name: "proxyHosts.pageData",
      description: "The proxy hosts page's database reads (hosts, certificates, lists, users, groups, grants)",
      iterations: n(200),
      warmup: 20,
      run: proxyHostsPageData,
    },
    {
      name: "proxyHosts.apiPage",
      description: "REST list page: listProxyHostsPaginated(25) and countProxyHosts()",
      iterations: n(2000),
      warmup: 200,
      run: () => Promise.all([listProxyHostsPaginated(PER_PAGE, 0, undefined, "name", "asc"), countProxyHosts()]),
    },
    {
      name: "proxyHosts.update",
      description: "updateProxyHost() (validation, update; Caddy apply deferred) and its audit event",
      iterations: n(300),
      warmup: 20,
      run: updateHost,
      check: (result) => {
        const { result: host, name } = result as { result: { name: string }; name: string };
        if (host.name !== name) throw new Error("The update did not change the name");
      },
    },
    {
      name: "db.pointQuery",
      description: "One indexed single-row SELECT",
      iterations: n(20000),
      warmup: 2000,
      run: () => adapter.pointQuery(seeded.forwardAuthUserId),
    },
    {
      name: "db.readModifyWrite",
      description: "One transaction: SELECT, UPDATE, upsert",
      iterations: n(1000),
      warmup: 100,
      run: () => adapter.readModifyWrite(seeded.writeHostId, stamp()),
    },
    {
      name: "mixed.verifyDuringWrites",
      description: "Verify latency while a writer runs read-modify-write transactions back to back",
      iterations: n(2000),
      warmup: 0,
      run: () => verify(validHeaders),
      custom: verifyDuringWrites,
    },
  ];

  const selected = options.only ? cases.filter((c) => options.only!.some((prefix) => c.name.startsWith(prefix))) : cases;
  const results: CaseResult[] = [];

  for (const bench of selected) {
    // First run: correctness, and lazy loads (the gate's index, statement caches).
    await bench.setup?.();
    const firstResult = await bench.run();
    await bench.check?.(firstResult);

    if (counter && options.profile) {
      // Warm, then split the time of a run of iterations (one after the other).
      for (let i = 0; i < bench.warmup; i++) {
        await bench.setup?.();
        await bench.run();
      }
      Bun.gc(true);
      const iterations = Math.max(5, Math.round(bench.iterations / 4));
      let totalMs = 0;
      let setupPrepareMs = 0;
      let setupExecuteMs = 0;
      let setupStatements = 0;
      counter.reset();
      for (let i = 0; i < iterations; i++) {
        const before = counter.counts();
        const [p0, e0, s0] = [before.prepareMs, before.executeMs, before.statements + before.transactionControl];
        await bench.setup?.();
        const after = counter.counts();
        setupPrepareMs += after.prepareMs - p0;
        setupExecuteMs += after.executeMs - e0;
        setupStatements += after.statements + after.transactionControl - s0;
        const t0 = performance.now();
        await bench.run();
        totalMs += performance.now() - t0;
      }
      const counts = counter.counts();
      const prepareMs = (counts.prepareMs - setupPrepareMs) / iterations;
      const executeMs = (counts.executeMs - setupExecuteMs) / iterations;
      const perIteration = totalMs / iterations;
      results.push({
        ...summarize([]),
        name: bench.name,
        description: bench.description,
        perIteration: bench.perIteration ?? 1,
        profile: {
          totalMs: perIteration,
          prepareMs,
          executeMs,
          otherMs: perIteration - prepareMs - executeMs,
          statements: (counts.statements + counts.transactionControl - setupStatements) / iterations,
        },
      });
      continue;
    }

    if (counter) {
      // Warm, then count exactly one run.
      await bench.setup?.();
      await bench.run();
      await bench.setup?.();
      counter.reset();
      await bench.run();
      const counts = counter.counts();
      results.push({
        ...summarize([]),
        name: bench.name,
        description: bench.description,
        perIteration: bench.perIteration ?? 1,
        counts: {
          statements: counts.statements,
          reads: counts.reads,
          writes: counts.writes,
          transactionControl: counts.transactionControl,
          topSql: [...counts.bySql.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
        },
      });
      continue;
    }

    for (let i = 0; i < bench.warmup; i++) {
      await bench.setup?.();
      await bench.run();
    }
    Bun.gc(true);

    let samples: number[];
    let extra: Record<string, number> | undefined;
    if (bench.custom) {
      ({ samples, extra } = await bench.custom(bench.iterations));
    } else {
      samples = [];
      for (let i = 0; i < bench.iterations; i++) {
        await bench.setup?.();
        const t0 = performance.now();
        await bench.run();
        samples.push(performance.now() - t0);
      }
    }
    results.push({ ...summarize(samples), name: bench.name, description: bench.description, perIteration: bench.perIteration ?? 1, extra });
    Bun.gc(true);
  }

  // ── Report ──
  const meta = {
    label: options.label,
    dbApi: adapter.DB_API,
    database: options.memory ? "tmpfs file" : "file",
    mode: options.count ? "count" : options.profile ? "profile" : options.quick ? "quick" : "full",
    bun: Bun.version,
    seed: SEED_SIZE,
    seedMs: Math.round(seedMs),
    documentHash,
    documentBytes,
    totalSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
  console.log(`\n${meta.label || "benchmark"} | ${meta.dbApi} | bun ${meta.bun} | ${meta.database} database | ${meta.mode}`);
  console.log(`Caddy document: ${documentBytes} bytes, sha256 ${documentHash.slice(0, 16)}`);
  if (counter && options.profile) {
    console.log("path                              total ms   prepare ms   SQLite ms    other ms  statements");
    for (const r of results) {
      const p = r.profile!;
      console.log(
        `${r.name.padEnd(32)} ${formatMs(p.totalMs).padStart(9)} ${formatMs(p.prepareMs).padStart(12)} ${formatMs(p.executeMs).padStart(11)} ${formatMs(p.otherMs).padStart(11)} ${p.statements.toFixed(1).padStart(11)}`
      );
    }
  } else if (counter) {
    for (const result of results) {
      const counts = result.counts!;
      console.log(
        `\n${result.name}: ${counts.statements} statements (${counts.reads} reads, ${counts.writes} writes), ${counts.transactionControl} transaction control`
      );
      for (const [sql, times] of counts.topSql) console.log(`  ${String(times).padStart(4)}  ${sql}`);
    }
  } else {
    const header = ["path", "iterations", "median ms", "p95 ms", "p99 ms", "mean ms", "min ms"];
    const rows = results.map((r) => [
      r.name,
      String(r.iterations),
      formatMs(r.medianMs),
      formatMs(r.p95Ms),
      formatMs(r.p99Ms),
      formatMs(r.meanMs),
      formatMs(r.minMs),
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    const line = (cells: string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  ");
    console.log(line(header));
    for (const row of rows) console.log(line(row));
    for (const r of results) {
      if (r.extra) console.log(`${r.name}: ${Object.entries(r.extra).map(([k, v]) => `${k}=${Math.round(v * 10) / 10}`).join(" ")}`);
    }
  }
  console.log(`BENCH_JSON ${JSON.stringify({ meta, results })}`);
}

try {
  await main();
} finally {
  rmSync(databaseDirectory, { recursive: true, force: true });
}
process.exit(0);
