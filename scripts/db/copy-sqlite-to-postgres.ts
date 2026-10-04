/**
 * Copies an Ingressi SQLite database into an empty PostgreSQL database, or
 * compares the two (documentation/postgresql.md; src/lib/db/copy/).
 *
 * In the Docker image (one bundled file, docker/web/Dockerfile), with the
 * web container stopped:
 *   docker compose run --rm --entrypoint bun -e DATABASE_URL="$POSTGRES_URL" web \
 *     db-tools/copy-sqlite-to-postgres.js --from /app/data/ingressi.db
 * From a checkout:
 *   bun run db:copy-to-postgres --from ./data/ingressi.db --to postgres://…
 *
 * Options:
 *   --from <file>      the SQLite database (default: DATABASE_URL when it names
 *                      a SQLite file, otherwise ./data/ingressi.db)
 *   --to <url>         the PostgreSQL database (default: DATABASE_URL when it is a
 *                      postgres:// URL); DATABASE_SSL_CA_FILE applies as for the app
 *   --replace          delete the Ingressi data the PostgreSQL database already
 *                      holds before copying, instead of refusing
 *   --verify-only      compare the two databases, change nothing
 *   --batch-size <n>   rows per statement (default 2000)
 *
 * Exit status: 0 done, 1 refused or failed (nothing copied), 2 wrong usage.
 * SESSION_SECRET must be the web container's: stored secrets stay encrypted.
 */
import { parseArgs } from "node:util";
import { isPostgresUrl } from "../../src/lib/db/dialect";
import { defaultSqliteFile, sqliteFilePath, SqliteLocationError } from "../../src/lib/db/sqlite-location";
import { PostgresConfigError, readPostgresConfig } from "../../src/lib/db/postgres";
import { BATCH_SIZE_LIMITS, DEFAULT_BATCH_SIZE } from "../../src/lib/db/copy/checks";
import { copySqliteToPostgres } from "../../src/lib/db/copy/copy";
import { CopyRefusedError } from "../../src/lib/db/copy/errors";
import { CopyVerificationError, formatVerifyReport, verifySqliteAgainstPostgres } from "../../src/lib/db/copy/verify";

const USAGE = `Usage: copy-sqlite-to-postgres [--from <sqlite file>] [--to <postgres url>] [--replace] [--verify-only] [--batch-size <n>]

Copies an Ingressi SQLite database into an empty PostgreSQL database (with
--verify-only, compares them). Stop the web container first. See
documentation/postgresql.md.`;

class UsageError extends Error {}

/** The SQLite file: --from, else DATABASE_URL or ./data (src/lib/db/sqlite-location.ts). */
function sourceFile(from: string | undefined): string {
  try {
    return from !== undefined ? sqliteFilePath(from) : defaultSqliteFile();
  } catch (error) {
    if (error instanceof SqliteLocationError) {
      throw new UsageError(error.kind === "remote" ? error.message : "--from must name a SQLite database file.");
    }
    throw error;
  }
}

/** The PostgreSQL database as text without the user's password: host, port and database name. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `the PostgreSQL database "${decodeURIComponent(parsed.pathname.slice(1)) || "(default)"}" on ${parsed.host}`;
  } catch {
    return "the PostgreSQL database";
  }
}

function parseBatchSize(value: string | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  const size = Number(value);
  if (!/^\d+$/.test(value) || size < BATCH_SIZE_LIMITS.min || size > BATCH_SIZE_LIMITS.max) {
    throw new UsageError(`--batch-size must be a whole number from ${BATCH_SIZE_LIMITS.min} to ${BATCH_SIZE_LIMITS.max}.`);
  }
  return size;
}

/** Whether this run only compares (for the wording of a refusal). */
let verifyOnly = false;

async function main(argv: string[]): Promise<number> {
  let values: { from?: string; to?: string; replace?: boolean; "verify-only"?: boolean; "batch-size"?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        replace: { type: "boolean" },
        "verify-only": { type: "boolean" },
        "batch-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  verifyOnly = values["verify-only"] === true;
  if (values.replace && verifyOnly) throw new UsageError("--replace and --verify-only cannot be used together.");

  const sourcePath = sourceFile(values.from);
  const targetUrl = values.to?.trim() || (isPostgresUrl(process.env.DATABASE_URL) ? process.env.DATABASE_URL!.trim() : "");
  if (!isPostgresUrl(targetUrl)) {
    throw new UsageError("Name the PostgreSQL database with --to postgres://… or a postgres:// DATABASE_URL.");
  }
  const batchSize = parseBatchSize(values["batch-size"]);
  const target = readPostgresConfig({ ...process.env, DATABASE_URL: targetUrl });
  const destination = describeTarget(targetUrl);

  if (verifyOnly) {
    console.log(`Comparing ${sourcePath} with ${destination}...`);
    const report = await verifySqliteAgainstPostgres({ sourcePath, target, batchSize, log: (line) => console.log(line) });
    for (const line of formatVerifyReport(report)) console.log(line);
    return report.ok ? 0 : 1;
  }

  console.log(`Copying ${sourcePath} to ${destination}...`);
  if (values.replace) {
    console.error("WARNING: --replace deletes the Ingressi data already in the PostgreSQL database before copying.");
  }
  const result = await copySqliteToPostgres({
    sourcePath,
    target,
    replace: values.replace === true,
    batchSize,
    log: (line) => console.log(line),
    warn: (line) => console.error(`WARNING: ${line}`),
  });
  for (const line of formatVerifyReport(result.verify)) console.log(line);
  console.log(
    `Copied ${result.rows} rows in ${result.tables.length} tables in ${(result.durationMs / 1000).toFixed(1)} s` +
      (result.secretsChecked > 0 ? "; SESSION_SECRET decrypts the stored secrets." : ".")
  );
  console.log(
    "Next: set the web container's DATABASE_URL to the PostgreSQL URL and start it (documentation/postgresql.md). " +
      "Keep the SQLite backup: it is the only way back."
  );
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof CopyVerificationError) {
    for (const line of formatVerifyReport(error.report)) console.error(line);
    console.error(error.message);
    process.exitCode = 1;
  } else if (error instanceof CopyRefusedError || error instanceof PostgresConfigError) {
    console.error(verifyOnly ? error.message : `${error.message}\nNothing was copied.`);
    process.exitCode = 1;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(verifyOnly ? `The comparison failed: ${message}` : `The copy failed, nothing was copied: ${message}`);
    process.exitCode = 1;
  }
}
