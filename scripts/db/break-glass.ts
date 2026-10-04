/**
 * Break-glass changes from the host, on SQLite or PostgreSQL
 * (src/lib/db/break-glass.ts; documentation/mfa.md, ee/docs/sso-enforcement.md).
 *
 * In the Docker image (one bundled file, docker/web/Dockerfile), while the
 * web container runs:
 *   docker compose exec web bun db-tools/break-glass.js remove-mfa-policy
 *   docker compose exec web bun db-tools/break-glass.js turn-off-sso-enforcement
 * From a checkout: bun scripts/db/break-glass.ts <action>
 *
 * The database is the one DATABASE_URL names (DATABASE_SSL_CA_FILE and
 * sslmode apply as for the application). Exit status: 0 done, 1 failed,
 * 2 wrong usage.
 */
import { isPostgresUrl } from "../../src/lib/db/dialect";
import { PostgresConfigError, readPostgresConfig } from "../../src/lib/db/postgres";
import {
  BREAK_GLASS_ACTIONS,
  BreakGlassError,
  isBreakGlassAction,
  postgresSettingsRows,
  runBreakGlass,
  sqliteSettingsRows,
} from "../../src/lib/db/break-glass";
import { defaultSqliteFile, SqliteLocationError } from "../../src/lib/db/sqlite-location";

const USAGE = `Usage: break-glass <action>

Actions:
  remove-mfa-policy          delete the MFA policy: no account is required to use MFA
  turn-off-sso-enforcement   turn enforced SSO off, keeping the break-glass list

Works on the database DATABASE_URL names, SQLite or PostgreSQL. The change is
not in the audit log: note it in your change log.`;

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(USAGE);
    return 0;
  }
  const action = argv[0] ?? "";
  if (argv.length !== 1 || !isBreakGlassAction(action)) {
    console.error(`Name one action: ${BREAK_GLASS_ACTIONS.join(" or ")}.\n\n${USAGE}`);
    return 2;
  }
  const url = process.env.DATABASE_URL?.trim();
  const rows = isPostgresUrl(url) ? await postgresSettingsRows(readPostgresConfig()) : sqliteSettingsRows(defaultSqliteFile());
  try {
    console.log(await runBreakGlass(action, rows));
  } finally {
    await rows.close();
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const known = error instanceof BreakGlassError || error instanceof PostgresConfigError || error instanceof SqliteLocationError;
  console.error(known ? (error as Error).message : `The change failed, nothing was changed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
