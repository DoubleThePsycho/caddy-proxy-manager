/**
 * The break-glass tool: changes an administrator makes from the host, in the
 * database, when nobody can sign in to make them in the dashboard
 * (documentation/mfa.md, ee/docs/sso-enforcement.md). In the image it is
 * db-tools/break-glass.js (scripts/db/break-glass.ts):
 *
 *   docker compose exec web bun db-tools/break-glass.js <action>
 *
 * It works on the database DATABASE_URL names, SQLite or PostgreSQL (with
 * the TLS settings the application uses), while the web container runs. Like
 * the copy tool it never loads the application's database modules: nothing
 * is migrated or started.
 *
 * - remove-mfa-policy: deletes the MFA policy setting. Without it nobody is
 *   required to use MFA. A policy that cannot be read requires MFA of every
 *   account with a password (fail closed), so this is also the way out of a
 *   corrupted one.
 * - turn-off-sso-enforcement: turns enforced SSO off and keeps the
 *   break-glass list. A stored value that is not a JSON object (which counts
 *   as enforced, without break-glass accounts) is deleted instead.
 *
 * Both take effect at the next sign-in on every replica: the settings are
 * read from the database each time. Neither is in the audit log: the change
 * bypasses the application.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import pg from "pg";

/** The settings rows (src/lib/mfa.ts MFA_POLICY_SETTING_KEY, ee/sso/enforcement-store.ts SSO_ENFORCEMENT_SETTING_KEY). */
export const MFA_POLICY_KEY = "mfa_policy";
export const SSO_ENFORCEMENT_KEY = "sso_enforcement";

export const BREAK_GLASS_ACTIONS = ["remove-mfa-policy", "turn-off-sso-enforcement"] as const;
export type BreakGlassAction = (typeof BREAK_GLASS_ACTIONS)[number];

export function isBreakGlassAction(value: string): value is BreakGlassAction {
  return (BREAK_GLASS_ACTIONS as readonly string[]).includes(value);
}

/** The database cannot be used; the message says why. */
export class BreakGlassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BreakGlassError";
  }
}

/** The rows of the settings table the actions read and change. */
export interface SettingsRows {
  read(key: string): Promise<string | null>;
  /** Replaces the value of an existing row; false when there is none. */
  update(key: string, value: string, updatedAt: string): Promise<boolean>;
  /** Deletes a row; false when there is none. */
  remove(key: string): Promise<boolean>;
  close(): Promise<void>;
}

/** The settings of a SQLite database file, opened while the web container may be using it. */
export function sqliteSettingsRows(path: string): SettingsRows {
  if (!existsSync(path)) throw new BreakGlassError(`There is no SQLite database at ${path}: check DATABASE_URL.`);
  const database = new Database(path);
  // The web container may be writing: wait for its lock rather than fail.
  database.exec("PRAGMA busy_timeout = 10000");
  const changes = (result: unknown) => Number((result as { changes?: number | bigint }).changes ?? 0);
  return {
    async read(key) {
      const row = database.prepare('SELECT "value" FROM settings WHERE "key" = ?').get(key) as { value: string } | null | undefined;
      return row?.value ?? null;
    },
    async update(key, value, updatedAt) {
      return changes(database.prepare('UPDATE settings SET "value" = ?, "updatedAt" = ? WHERE "key" = ?').run(value, updatedAt, key)) > 0;
    },
    async remove(key) {
      return changes(database.prepare('DELETE FROM settings WHERE "key" = ?').run(key)) > 0;
    },
    async close() {
      database.close();
    },
  };
}

/** The settings of a PostgreSQL database, on one connection of its own (`config`: readPostgresConfig()). */
export async function postgresSettingsRows(config: pg.ClientConfig): Promise<SettingsRows> {
  const client = new pg.Client({ ...config, application_name: "ingressi-break-glass" });
  // A connection the server ends fails the next query; unwatched, it would end the process.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new BreakGlassError(`Cannot connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    async read(key) {
      const { rows } = await client.query<{ value: string }>('SELECT "value" FROM settings WHERE "key" = $1', [key]);
      return rows[0]?.value ?? null;
    },
    async update(key, value, updatedAt) {
      const { rowCount } = await client.query('UPDATE settings SET "value" = $1, "updatedAt" = $2 WHERE "key" = $3', [value, updatedAt, key]);
      return (rowCount ?? 0) > 0;
    },
    async remove(key) {
      const { rowCount } = await client.query('DELETE FROM settings WHERE "key" = $1', [key]);
      return (rowCount ?? 0) > 0;
    },
    async close() {
      await client.end();
    },
  };
}

/** Runs `action` on `rows`; returns what was done, in a sentence. */
export async function runBreakGlass(action: BreakGlassAction, rows: SettingsRows, now: Date = new Date()): Promise<string> {
  if (action === "remove-mfa-policy") {
    return (await rows.remove(MFA_POLICY_KEY))
      ? "MFA policy removed: no account is required to use MFA. Set the policy again on the Users page when you can sign in."
      : "There was no MFA policy: no account is required to use MFA.";
  }

  const raw = await rows.read(SSO_ENFORCEMENT_KEY);
  if (raw === null) return "Enforced SSO is off already: there is no setting.";
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not JSON: counts as enforced (ee/sso/enforcement-store.ts).
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    await rows.remove(SSO_ENFORCEMENT_KEY);
    return "The enforced SSO setting could not be read, so it was enforced without break-glass accounts; it was removed: enforced SSO is off and the break-glass list is empty.";
  }
  const record = value as Record<string, unknown>;
  if (record.enabled === false) return "Enforced SSO is off already.";
  await rows.update(SSO_ENFORCEMENT_KEY, JSON.stringify({ ...record, enabled: false }), now.toISOString());
  return "Enforced SSO is off. The break-glass list is kept.";
}
