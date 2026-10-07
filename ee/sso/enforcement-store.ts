// SPDX-License-Identifier: Elastic-2.0
/**
 * Enforced SSO: the stored setting and the checks built on it.
 *
 * Everything here takes a database reader or writer (the database or a
 * transaction on it), so a check and the write it guards can share one
 * transaction. Await every check: a promise is always truthy.
 *
 * Break-glass accounts are stored by user id, not by username. An id follows
 * the account through renames (including an ADMIN_USERNAME change of the
 * primary admin) and cannot be taken over by another account that later gets
 * a freed-up username. The API and the dashboard still show and accept
 * usernames.
 */
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { nowIso } from "@/src/lib/db";
import { accounts, settings, users } from "@/src/lib/db/schema";
import { isUsableSignInUsername } from "@/src/lib/login-username";
import { ApiValidationError } from "@/src/lib/api-errors";
import { first } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

export const SSO_ENFORCEMENT_SETTING_KEY = "sso_enforcement";

/** Upper bound on break-glass accounts; they are meant to be few. */
export const MAX_BREAK_GLASS_ACCOUNTS = 20;

export type SsoEnforcementConfig = {
  enabled: boolean;
  breakGlassUserIds: number[];
};

/** The database or a transaction on it, for reads. */
export type SsoReader = Pick<DbExecutor, "select">;

/** The database or a transaction on it, for reads and writes. */
export type SsoWriter = Pick<DbExecutor, "select" | "insert" | "update" | "delete">;

export const DISABLED_CONFIG: SsoEnforcementConfig = Object.freeze({
  enabled: false,
  breakGlassUserIds: [],
}) as SsoEnforcementConfig;

function uniquePositiveIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is number => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

/**
 * The stored value as a config. No row means "off". A row that is not valid
 * JSON can only come from editing the database by hand; it fails closed
 * (enforced, no break-glass account) rather than silently turning
 * enforcement off. ee/docs/sso-enforcement.md has the reset command.
 */
export function parseSsoEnforcement(raw: string | null | undefined): SsoEnforcementConfig {
  if (raw === null || raw === undefined) return DISABLED_CONFIG;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.error(`[sso] The ${SSO_ENFORCEMENT_SETTING_KEY} setting is not valid JSON; enforcing SSO without break-glass accounts`);
    return { enabled: true, breakGlassUserIds: [] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    console.error(`[sso] The ${SSO_ENFORCEMENT_SETTING_KEY} setting is malformed; enforcing SSO without break-glass accounts`);
    return { enabled: true, breakGlassUserIds: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    // Anything but an explicit false keeps enforcement on.
    enabled: record.enabled !== false,
    breakGlassUserIds: uniquePositiveIds(record.breakGlassUserIds),
  };
}

export async function readSsoEnforcement(reader: SsoReader): Promise<SsoEnforcementConfig> {
  const row = await first(reader
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SSO_ENFORCEMENT_SETTING_KEY))
    .limit(1));
  return parseSsoEnforcement(row?.value);
}

export async function writeSsoEnforcement(writer: SsoWriter, config: SsoEnforcementConfig): Promise<void> {
  const value = JSON.stringify({
    enabled: config.enabled,
    breakGlassUserIds: uniquePositiveIds(config.breakGlassUserIds),
  });
  const now = nowIso();
  await writer
    .insert(settings)
    .values({ key: SSO_ENFORCEMENT_SETTING_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

/** Drops a deleted user from the break-glass list, so a later account with the same id never inherits it. */
export async function removeBreakGlassUser(writer: SsoWriter, userId: number): Promise<void> {
  const row = await first(writer
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SSO_ENFORCEMENT_SETTING_KEY))
    .limit(1));
  if (!row) return;
  const config = parseSsoEnforcement(row.value);
  if (!config.breakGlassUserIds.includes(userId)) return;
  await writeSsoEnforcement(writer, {
    ...config,
    breakGlassUserIds: config.breakGlassUserIds.filter((id) => id !== userId),
  });
}

/**
 * The username the login page signs user `userId` in with, or null. Mirrors
 * getPasswordSignInUsername in src/lib/models/user.ts (a usable username and
 * a credential account with a password), synchronously.
 */
export async function passwordSignInUsername(reader: SsoReader, userId: number): Promise<string | null> {
  const row = await first(reader
    .select({ username: users.username })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(and(
      eq(accounts.userId, userId),
      eq(accounts.providerId, "credential"),
      isNotNull(accounts.password),
      ne(accounts.password, "")
    ))
    .limit(1));
  return isUsableSignInUsername(row?.username) ? row.username : null;
}

export type BreakGlassAccount = {
  id: number;
  username: string | null;
  name: string | null;
  email: string;
  role: string;
  status: string;
  /** The account can sign in on the login page with a username and password. */
  passwordSignIn: boolean;
  /** An active administrator that can sign in with a password: what the lockout guards count. */
  validAdmin: boolean;
};

/** A change about to be made to one account, for the lockout guard. */
export type AccountChange = {
  userId: number;
  role?: string;
  status?: string;
  deleted?: boolean;
};

/** The listed accounts that still exist, as they are, or as they would be after `change`. */
export async function describeBreakGlassAccounts(
  reader: SsoReader,
  userIds: readonly number[],
  change?: AccountChange
): Promise<BreakGlassAccount[]> {
  if (userIds.length === 0) return [];
  const rows = await reader
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(inArray(users.id, [...userIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: BreakGlassAccount[] = [];
  for (const id of userIds) {
    const row = byId.get(id);
    if (!row) continue;
    if (change?.userId === id && change.deleted) continue;
    const role = change?.userId === id && change.role !== undefined ? change.role : row.role;
    const status = change?.userId === id && change.status !== undefined ? change.status : row.status;
    const passwordSignIn = await passwordSignInUsername(reader, id) !== null;
    result.push({
      id,
      username: row.username,
      name: row.name,
      email: row.email,
      role,
      status,
      passwordSignIn,
      validAdmin: passwordSignIn && role === "admin" && status === "active",
    });
  }
  return result;
}

export async function countValidBreakGlassAdmins(
  reader: SsoReader,
  config: SsoEnforcementConfig,
  change?: AccountChange
): Promise<number> {
  return (await describeBreakGlassAccounts(reader, config.breakGlassUserIds, change)).filter((a) => a.validAdmin).length;
}

/** Some break-glass account can sign in on the login page: it is active and has a password. */
export function canAnyBreakGlassSignIn(accounts: readonly BreakGlassAccount[]): boolean {
  return accounts.some((account) => account.passwordSignIn && account.status === "active");
}

export const LAST_BREAK_GLASS_ADMIN_MESSAGE =
  "This is the last break-glass administrator for enforced SSO. To go without one, remove it from the break-glass " +
  "accounts on the Single sign-on page first.";

/** A lockout guard refusal (400); the message is safe to show. */
export class BreakGlassGuardError extends ApiValidationError {
  constructor(message: string = LAST_BREAK_GLASS_ADMIN_MESSAGE) {
    super(message);
    this.name = "BreakGlassGuardError";
  }
}

/**
 * Throws BreakGlassGuardError when SSO is enforced and `change` would take the
 * number of valid break-glass administrators from at least one to none, so an
 * administrator does not lose that way in by accident. Break-glass accounts
 * are optional: going without one is a choice made on the SSO page, and a
 * change is allowed when there is already none. Call it inside the
 * transaction that makes the change.
 */
export async function assertBreakGlassAdminRemains(reader: SsoReader, change: AccountChange): Promise<void> {
  const config = await readSsoEnforcement(reader);
  if (!config.enabled || !config.breakGlassUserIds.includes(change.userId)) return;
  const before = await countValidBreakGlassAdmins(reader, config);
  if (before === 0) return;
  if (await countValidBreakGlassAdmins(reader, config, change) === 0) {
    throw new BreakGlassGuardError();
  }
}
