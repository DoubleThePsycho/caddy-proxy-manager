/**
 * Which database the application runs on (src/lib/db/README.md).
 *
 * The dialect comes from DATABASE_DIALECT when it is set ("sqlite" or
 * "postgres"), otherwise from DATABASE_URL: a postgres:// or postgresql://
 * URL means PostgreSQL, anything else (a file: URL, a path, ":memory:" or
 * nothing) means SQLite. A DATABASE_DIALECT that contradicts DATABASE_URL is
 * a configuration error rather than a guess.
 *
 * PostgreSQL needs version 16 or later and a database with the C collation
 * (src/lib/db/pg-startup.ts checks both); the connection settings are in
 * src/lib/db/postgres.ts.
 */

export type DatabaseDialect = "sqlite" | "postgres";

/** The environment variables the dialect is read from (process.env by default). */
export type DialectEnv = Readonly<Record<string, string | undefined>>;

/** Whether `url` is a PostgreSQL connection URL. */
export function isPostgresUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && /^postgres(?:ql)?:\/\//i.test(url.trim());
}

function parseDialectOverride(value: string): DatabaseDialect {
  const normalized = value.trim().toLowerCase();
  if (normalized === "sqlite") return "sqlite";
  if (normalized === "postgres" || normalized === "postgresql") return "postgres";
  throw new Error(`DATABASE_DIALECT must be "sqlite" or "postgres", not ${JSON.stringify(value)}.`);
}

/**
 * The configured dialect. Reads the environment on every call (it is cheap),
 * so tests can switch it with vi.stubEnv.
 */
export function getDialect(env: DialectEnv = process.env): DatabaseDialect {
  const url = env.DATABASE_URL;
  const override = env.DATABASE_DIALECT;
  if (override !== undefined && override.trim() !== "") {
    const dialect = parseDialectOverride(override);
    if (url && url.trim() !== "") {
      const urlDialect: DatabaseDialect = isPostgresUrl(url) ? "postgres" : "sqlite";
      if (urlDialect !== dialect) {
        throw new Error(
          `DATABASE_DIALECT is "${dialect}" but DATABASE_URL is a ${urlDialect === "postgres" ? "PostgreSQL URL" : "SQLite location"}; ` +
            "set one of them so that they agree."
        );
      }
    }
    return dialect;
  }
  return isPostgresUrl(url) ? "postgres" : "sqlite";
}

export function isPostgres(env?: DialectEnv): boolean {
  return getDialect(env) === "postgres";
}
