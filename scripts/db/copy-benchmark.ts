/**
 * Measures the SQLite → PostgreSQL copy (src/lib/db/copy/) on a generated
 * database: rows in every table (tests/helpers/copy-fixture.ts) plus many
 * audit events and monetization ledger entries, the tables that grow.
 * It creates its own PostgreSQL database on the server TEST_DATABASE_URL
 * names (a user that may create databases), copies into it, compares again
 * with --verify-only, and drops it.
 *
 * Usage (on the staging VM, under Bun):
 *   TEST_DATABASE_URL=postgres://… bun scripts/db/copy-benchmark.ts [--audit=N] [--ledger=N] [--batch-size=N] [--keep=<file>]
 *     --audit=N       audit events (default 100000)
 *     --ledger=N      monetization ledger entries (default 50000)
 *     --batch-size=N  rows per statement (default: the copy's)
 *     --keep=<file>   also write the generated SQLite database to <file> and
 *                     create an empty PostgreSQL database for it, printing its
 *                     URL, instead of copying (to try the CLI on it)
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { copySqliteToPostgres } from "../../src/lib/db/copy/copy";
import { copyTables } from "../../src/lib/db/copy/tables";
import { formatVerifyReport, verifySqliteAgainstPostgres } from "../../src/lib/db/copy/verify";
import { readPostgresConfig } from "../../src/lib/db/postgres";
import { appendRows, populateEveryTable } from "../../tests/helpers/copy-fixture";

process.env.SESSION_SECRET ??= "copy-benchmark-session-secret-0123456789";

function option(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number`);
  return value;
}

const serverUrl = process.env.TEST_DATABASE_URL;
if (!serverUrl) throw new Error("TEST_DATABASE_URL must name a PostgreSQL server whose user may create databases");
const auditRows = option("audit", 100_000);
const ledgerRows = option("ledger", 50_000);
const batchSize = process.argv.some((arg) => arg.startsWith("--batch-size=")) ? option("batch-size", 0) : undefined;
const keep = process.argv.find((arg) => arg.startsWith("--keep="))?.slice("--keep=".length);

const seconds = (start: number) => ((performance.now() - start) / 1000).toFixed(2);

const workDir = mkdtempSync(join(tmpdir(), "ingressi-copy-bench-"));
const sourcePath = keep ? resolve(keep) : join(workDir, "source.db");
const databaseName = `ingressi_copy_bench_${Date.now().toString(36)}`;
const server = new pg.Client({ connectionString: serverUrl });
await server.connect();
try {
  let start = performance.now();
  const sqlite = new Database(sourcePath);
  migrate(drizzle(sqlite), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const { encryptSecret } = await import("../../src/lib/secret");
  populateEveryTable(sqlite, { encryptedSecret: encryptSecret("benchmark-client-secret") });
  const table = (name: string) => copyTables().find((candidate) => candidate.name === name)!;
  appendRows(sqlite, table("audit_events"), auditRows, 3);
  appendRows(sqlite, table("monetization_ledger"), ledgerRows, 3);
  sqlite.close();
  console.log(`Generated ${sourcePath}: ${auditRows} audit events, ${ledgerRows} ledger entries, 3 rows in every other table (${seconds(start)} s)`);

  await server.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  const url = new URL(serverUrl);
  url.pathname = `/${databaseName}`;
  if (keep) {
    console.log(`Created an empty PostgreSQL database for it: ${url.toString()}`);
  } else {
    const target = readPostgresConfig({ DATABASE_URL: url.toString() });
    start = performance.now();
    const result = await copySqliteToPostgres({ sourcePath, target, batchSize });
    const copySeconds = seconds(start);
    for (const line of formatVerifyReport(result.verify).filter((line) => /audit_events|monetization_ledger|tables/.test(line))) {
      console.log(line);
    }
    console.log(`Copy (migrations, copy, identities, verification): ${result.rows} rows in ${copySeconds} s`);
    start = performance.now();
    const report = await verifySqliteAgainstPostgres({ sourcePath, target, batchSize });
    const verifySeconds = seconds(start);
    console.log(`--verify-only: ${report.ok ? "same" : "DIFFERENT"} in ${verifySeconds} s`);
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`BENCH_JSON ${JSON.stringify({ auditRows, ledgerRows, rows: result.rows, copySeconds: Number(copySeconds), verifySeconds: Number(verifySeconds), rssMb })}`);
    await server.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  }
} finally {
  await server.end();
  if (!keep) rmSync(workDir, { recursive: true, force: true });
}
