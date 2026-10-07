/**
 * Multi-factor authentication (MFA) for dashboard sign-in: the enrolment
 * state of an account, the administrators' policy ("require MFA for
 * administrators / for everyone who signs in with a password") and the reset
 * an administrator or the ADMIN_USERNAME/ADMIN_PASSWORD recovery performs.
 *
 * The second factor itself is either an authenticator app (TOTP with
 * one-time backup codes, Better Auth's two-factor plugin, configured in
 * auth-server.ts with the hooks in mfa-auth.ts) or a passkey (Better Auth's
 * passkey plugin, passkey-auth.ts and passkeys.ts): a passkey checks the
 * person as well as the device, so an account with one has MFA on. This
 * module only reads and clears what the plugins store (users.twoFactorEnabled,
 * the two_factors row and the passkeys rows); it never returns a TOTP secret,
 * a backup code or a credential.
 *
 * The policy is per dashboard and is not synchronized to sync slaves (users are not).
 * The forward-auth portal is not affected.
 */
import { and, count, eq, isNotNull, ne } from "drizzle-orm";
import { appDb, nowIso } from "./db";
import { accounts, passkeys, settings, twoFactors, users } from "./db/schema";
import { decryptSecret } from "./secret";
import { ApiClientError, ApiValidationError } from "./api-errors";
import { logAuditEvent } from "./audit";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { canSignInWithDirectory, hasDirectoryPassword } from "@/ee/ldap/identity";
import { first } from "@/src/lib/db/ops";
import type { DbExecutor } from "@/src/lib/db/types";

export type MfaReader = Pick<DbExecutor, "select">;

export const MFA_POLICY_SETTING_KEY = "mfa_policy";

/** Where an account goes when the MFA policy requires it to set up MFA before anything else. */
export const MFA_SETUP_PATH = "/mfa-setup";

/**
 * Who the policy requires to use MFA. Only accounts that can sign in with a
 * password are ever affected: an account without one signs in through its
 * identity provider, which handles MFA.
 *  - "off": nobody is required to (anyone may still enrol);
 *  - "admins": administrators and users with a custom role (ee/custom-roles);
 *  - "password_users": every account.
 */
export const MFA_POLICY_SCOPES = ["off", "admins", "password_users"] as const;
export type MfaPolicyScope = (typeof MFA_POLICY_SCOPES)[number];

export const DEFAULT_MFA_GRACE_DAYS = 7;
export const MAX_MFA_GRACE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MfaPolicy = {
  scope: MfaPolicyScope;
  /** Days after `since` during which affected accounts are prompted but not yet forced to enrol. */
  graceDays: number;
  /** When the current scope took effect (ISO 8601); null while the policy is off. */
  since: string | null;
};

export const MFA_POLICY_OFF: MfaPolicy = Object.freeze({
  scope: "off",
  graceDays: DEFAULT_MFA_GRACE_DAYS,
  since: null,
}) as MfaPolicy;

/** What a corrupted stored policy means: everyone with a password, no grace. */
const FAIL_CLOSED_POLICY: MfaPolicy = Object.freeze({
  scope: "password_users",
  graceDays: 0,
  since: new Date(0).toISOString(),
}) as MfaPolicy;

function isScope(value: unknown): value is MfaPolicyScope {
  return typeof value === "string" && (MFA_POLICY_SCOPES as readonly string[]).includes(value);
}

function isGraceDays(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_MFA_GRACE_DAYS;
}

/**
 * The stored value as a policy. No row means "off". A row that cannot be read
 * can only come from editing the database by hand; it fails closed (every
 * account with a password must enrol now) rather than silently turning the
 * policy off. documentation/mfa.md has the reset command.
 */
export function parseMfaPolicy(raw: string | null | undefined): MfaPolicy {
  if (raw === null || raw === undefined) return MFA_POLICY_OFF;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record || !isScope(record.scope) || !isGraceDays(record.graceDays)) {
    console.error(`[mfa] The ${MFA_POLICY_SETTING_KEY} setting is malformed; requiring MFA for every account with a password`);
    return FAIL_CLOSED_POLICY;
  }
  if (record.scope === "off") return { scope: "off", graceDays: record.graceDays, since: null };
  const since = typeof record.since === "string" && !Number.isNaN(Date.parse(record.since))
    ? new Date(record.since).toISOString()
    : new Date(0).toISOString();
  return { scope: record.scope, graceDays: record.graceDays, since };
}

export async function readMfaPolicy(reader: MfaReader = appDb): Promise<MfaPolicy> {
  const row = await first(reader
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, MFA_POLICY_SETTING_KEY))
    .limit(1));
  return parseMfaPolicy(row?.value);
}

/** When affected accounts must have enrolled; null while the policy is off. */
export function mfaPolicyDeadline(policy: MfaPolicy): Date | null {
  if (policy.scope === "off" || policy.since === null) return null;
  return new Date(Date.parse(policy.since) + policy.graceDays * DAY_MS);
}

/** The account has a password Better Auth's sign-in checks (a credential account with one). */
export async function hasPasswordCredential(reader: MfaReader, userId: number): Promise<boolean> {
  const row = await first(reader
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(
      eq(accounts.userId, userId),
      eq(accounts.providerId, "credential"),
      isNotNull(accounts.password),
      ne(accounts.password, "")
    ))
    .limit(1));
  return !!row;
}

/**
 * Whether the account can sign in to the dashboard with a password: its own
 * one, unless enforced SSO (ee/sso) refuses it (only break-glass accounts
 * keep password sign-in while SSO is enforced), or a directory password
 * (ee/ldap: linked to an enabled directory that, while SSO is enforced, stays
 * open under it).
 */
export async function canSignInWithPassword(reader: MfaReader, userId: number): Promise<boolean> {
  if (await hasPasswordCredential(reader, userId)) {
    const sso = await readSsoEnforcement(reader);
    if (!sso.enabled || sso.breakGlassUserIds.includes(userId)) return true;
  }
  return await canSignInWithDirectory(reader, userId);
}

/**
 * Whether the policy covers an account. "admins" covers the built-in admin
 * role and every custom role (ee/custom-roles): they hold management
 * permissions, so they are treated like administrators here.
 */
function policyCovers(policy: MfaPolicy, role: string, customRoleId: number | null = null): boolean {
  if (policy.scope === "off") return false;
  return policy.scope === "password_users" || role === "admin" || customRoleId !== null;
}

/** How many passkeys the account has (passkeys.ts). */
export async function passkeyCount(reader: MfaReader, userId: number): Promise<number> {
  return (await first(reader.select({ value: count() }).from(passkeys).where(eq(passkeys.userId, userId)).limit(1)))?.value ?? 0;
}

/**
 * The account's second factors: an authenticator app (the flag Better Auth
 * checks at sign-in and a confirmed secret) and its passkeys.
 */
async function readEnrolment(reader: MfaReader, userId: number): Promise<{ totp: boolean; passkeys: number; backupCodes: string | null }> {
  const row = await first(reader
    .select({ flag: users.twoFactorEnabled, verified: twoFactors.verified, backupCodes: twoFactors.backupCodes })
    .from(users)
    .leftJoin(twoFactors, eq(twoFactors.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1));
  const totp = !!row?.flag && row.verified === true;
  return { totp, passkeys: await passkeyCount(reader, userId), backupCodes: totp ? row?.backupCodes ?? null : null };
}

/** Whether the account has MFA on: an authenticator app or at least one passkey. */
export async function isMfaEnabled(reader: MfaReader, userId: number): Promise<boolean> {
  const enrolment = await readEnrolment(reader, userId);
  return enrolment.totp || enrolment.passkeys > 0;
}

/**
 * Whether the policy requires `userId` to use MFA (whether or not it has
 * enrolled): the policy covers its role and it can sign in with a password.
 */
export async function isMfaRequiredFor(reader: MfaReader, userId: number, given?: MfaPolicy): Promise<boolean> {
  const policy = given ?? (await readMfaPolicy(reader));
  if (policy.scope === "off") return false;
  const user = await first(reader.select({ role: users.role, customRoleId: users.customRoleId }).from(users).where(eq(users.id, userId)).limit(1));
  if (!user || !policyCovers(policy, user.role, user.customRoleId)) return false;
  return await canSignInWithPassword(reader, userId);
}

/**
 * What the policy asks of a signed-in account that has not enrolled:
 *  - "none": nothing (not required, or already enrolled);
 *  - "prompt": enrol before `deadline`; the dashboard keeps working meanwhile;
 *  - "required": the grace period is over; the session can only enrol.
 */
export type MfaGate = "none" | "prompt" | "required";
export type MfaGateResult = { gate: MfaGate; deadline: string | null };

export async function getMfaGate(userId: number, now: Date = new Date(), reader: MfaReader = appDb): Promise<MfaGateResult> {
  const policy = await readMfaPolicy(reader);
  if (policy.scope === "off") return { gate: "none", deadline: null };
  if (await isMfaEnabled(reader, userId) || !await isMfaRequiredFor(reader, userId, policy)) {
    return { gate: "none", deadline: null };
  }
  const deadline = mfaPolicyDeadline(policy)!;
  return {
    gate: now.getTime() < deadline.getTime() ? "prompt" : "required",
    deadline: deadline.toISOString(),
  };
}

/** Whether the dashboard must send this account to MFA enrolment before anything else. */
export async function mfaEnrolmentRequired(userId: number): Promise<boolean> {
  try {
    return (await getMfaGate(userId)).gate === "required";
  } catch (error) {
    // Fail closed: a dashboard session the gate cannot check gets nothing
    // but the enrolment page.
    console.error("[mfa] Failed to check the MFA policy:", error);
    return true;
  }
}

/** How many unused backup codes a stored value holds, or null when it cannot be read. */
export function countBackupCodes(stored: string | null): number | null {
  if (!stored) return null;
  try {
    const codes = JSON.parse(decryptSecret(stored, "MFA backup codes")) as unknown;
    return Array.isArray(codes) ? codes.length : null;
  } catch {
    return null;
  }
}

/** An account's MFA state as the API and the dashboard show it. Never holds a secret or a code. */
export type MfaStatus = {
  /** MFA is on: an authenticator app or at least one passkey. */
  enabled: boolean;
  /** An authenticator app (TOTP) is set up. */
  authenticatorApp: boolean;
  /** How many passkeys the account has. */
  passkeys: number;
  /** Unused backup codes; null when the authenticator app is off or the stored codes cannot be read. */
  backupCodesRemaining: number | null;
  /**
   * The account has a password, its own or a directory's (ee/ldap), so it can
   * set up MFA for password sign-in and confirm the change with it.
   */
  hasPassword: boolean;
  /** The policy requires this account to use MFA. */
  required: boolean;
  gate: MfaGate;
  /** Set up MFA by this time; null unless `gate` is "prompt" or "required". */
  deadline: string | null;
};

export async function getMfaStatus(userId: number, now: Date = new Date(), reader: MfaReader = appDb): Promise<MfaStatus> {
  const enrolment = await readEnrolment(reader, userId);
  const { gate, deadline } = await getMfaGate(userId, now, reader);
  return {
    enabled: enrolment.totp || enrolment.passkeys > 0,
    authenticatorApp: enrolment.totp,
    passkeys: enrolment.passkeys,
    backupCodesRemaining: enrolment.totp ? countBackupCodes(enrolment.backupCodes) : null,
    hasPassword: await hasPasswordCredential(reader, userId) || await hasDirectoryPassword(reader, userId),
    required: await isMfaRequiredFor(reader, userId),
    gate,
    deadline,
  };
}

/**
 * Turns MFA off for an account: removes its secret, backup codes, lockout
 * state and passkeys and clears the flag Better Auth checks at sign-in, in
 * one transaction. Returns whether the account had anything to clear.
 * Sessions are left alone.
 */
export async function resetUserMfa(userId: number): Promise<boolean> {
  return await appDb.transaction(async (tx) => {
    const removedPasskeys = await tx.delete(passkeys).where(eq(passkeys.userId, userId)).returning({ id: passkeys.id });
    const deleted = await tx.delete(twoFactors).where(eq(twoFactors.userId, userId)).returning({ id: twoFactors.id });
    const updated = await tx
      .update(users)
      .set({ twoFactorEnabled: false, updatedAt: nowIso() })
      .where(and(eq(users.id, userId), eq(users.twoFactorEnabled, true)))
      .returning({ id: users.id });
    return deleted.length > 0 || updated.length > 0 || removedPasskeys.length > 0;
  });
}

/**
 * An administrator turns MFA off for another account (for example after the
 * user lost their authenticator and their backup codes). Recorded in the
 * audit log. Administrators turn off their own MFA from Profile, with their
 * password.
 */
export async function adminResetUserMfa(targetUserId: number, actorUserId: number): Promise<MfaStatus> {
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    throw new ApiClientError("User not found", 404);
  }
  if (targetUserId === actorUserId) {
    throw new ApiValidationError("Turn off your own MFA from your Profile page, which asks for your password");
  }
  await appDb.transaction(async (tx) => {
    const user = await first(tx.select({ id: users.id }).from(users).where(eq(users.id, targetUserId)).limit(1));
    if (!user) throw new ApiClientError("User not found", 404);
    const cleared = await resetUserMfa(targetUserId);
    if (cleared) {
      await logAuditEvent({
        userId: actorUserId,
        action: "mfa_reset",
        entityType: "user",
        entityId: targetUserId,
        summary: `Reset multi-factor authentication of user ${targetUserId}`,
      });
    }
  }, { behavior: "immediate" });
  return await getMfaStatus(targetUserId);
}

// ── Policy (administrators) ──────────────────────────────────────────────

export type MfaPolicyInput = { scope: MfaPolicyScope; graceDays?: number };

export function parseMfaPolicyInput(body: unknown): MfaPolicyInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiValidationError("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "scope" && key !== "graceDays") {
      throw new ApiValidationError(`Unknown field "${key}"`);
    }
  }
  if (!isScope(record.scope)) {
    throw new ApiValidationError(`scope must be one of ${MFA_POLICY_SCOPES.join(", ")}`);
  }
  if (record.graceDays !== undefined && !isGraceDays(record.graceDays)) {
    throw new ApiValidationError(`graceDays must be a whole number from 0 to ${MAX_MFA_GRACE_DAYS}`);
  }
  return { scope: record.scope, ...(record.graceDays !== undefined ? { graceDays: record.graceDays as number } : {}) };
}

async function writeMfaPolicy(policy: MfaPolicy): Promise<void> {
  const value = JSON.stringify(policy);
  const now = nowIso();
  await appDb.insert(settings)
    .values({ key: MFA_POLICY_SETTING_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

export type MfaAccountSummary = {
  id: number;
  username: string | null;
  name: string | null;
  email: string;
  role: string;
  /** MFA is on: an authenticator app or at least one passkey. */
  enabled: boolean;
  authenticatorApp: boolean;
  passkeys: number;
  required: boolean;
  gate: MfaGate;
};

export type MfaPolicyView = MfaPolicy & {
  /** When affected accounts must have enrolled; null while off. */
  deadline: string | null;
  /** Accounts the policy covers, and which of them have not enrolled yet. */
  accounts: {
    required: number;
    enrolled: number;
    pending: MfaAccountSummary[];
  };
};

/** Every account's MFA state, for the Users page and the policy view. */
export async function listMfaAccountSummaries(now: Date = new Date(), reader: MfaReader = appDb): Promise<MfaAccountSummary[]> {
  const policy = await readMfaPolicy(reader);
  const deadline = mfaPolicyDeadline(policy);
  const rows = await reader
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      role: users.role,
      customRoleId: users.customRoleId,
      flag: users.twoFactorEnabled,
      verified: twoFactors.verified,
    })
    .from(users)
    .leftJoin(twoFactors, eq(twoFactors.userId, users.id));
  const passkeysByUser = new Map(
    (await reader.select({ userId: passkeys.userId, value: count() }).from(passkeys).groupBy(passkeys.userId))
      .map((row) => [row.userId, row.value] as const)
  );
  const summaries: MfaAccountSummary[] = [];
  for (const row of rows) {
    const authenticatorApp = !!row.flag && row.verified === true;
    const passkeyTotal = passkeysByUser.get(row.id) ?? 0;
    const enabled = authenticatorApp || passkeyTotal > 0;
    const required = policyCovers(policy, row.role, row.customRoleId) && (await canSignInWithPassword(reader, row.id));
    const gate: MfaGate = !required || enabled
      ? "none"
      : deadline && now.getTime() < deadline.getTime() ? "prompt" : "required";
    summaries.push({
      id: row.id,
      username: row.username,
      name: row.name,
      email: row.email,
      role: row.role,
      enabled,
      authenticatorApp,
      passkeys: passkeyTotal,
      required,
      gate,
    });
  }
  return summaries;
}

export async function getMfaPolicyView(now: Date = new Date()): Promise<MfaPolicyView> {
  const policy = await readMfaPolicy();
  const summaries = await listMfaAccountSummaries(now);
  const required = summaries.filter((account) => account.required);
  return {
    ...policy,
    deadline: mfaPolicyDeadline(policy)?.toISOString() ?? null,
    accounts: {
      required: required.length,
      enrolled: required.filter((account) => account.enabled).length,
      pending: required.filter((account) => !account.enabled),
    },
  };
}

/**
 * Saves the policy and records the change in the audit log. The grace period
 * starts over whenever the scope changes; changing only the number of days
 * moves the deadline of the current period.
 */
export async function updateMfaPolicy(input: MfaPolicyInput, actorUserId: number): Promise<MfaPolicyView> {
  // Read, write and audit in one transaction: the grace period's start is
  // decided on the policy being replaced.
  await appDb.transaction(async () => {
    const previous = await readMfaPolicy();
    const graceDays = input.graceDays ?? previous.graceDays;
    const since = input.scope === "off"
      ? null
      : input.scope === previous.scope && previous.since !== null ? previous.since : nowIso();
    const next: MfaPolicy = { scope: input.scope, graceDays, since };
    await writeMfaPolicy(next);
    await logAuditEvent({
      userId: actorUserId,
      action: "mfa_policy_updated",
      entityType: "setting",
      entityId: null,
      summary: `Set the MFA policy to "${next.scope}" with a ${next.graceDays}-day grace period`,
      data: { scope: next.scope, graceDays: next.graceDays, previousScope: previous.scope, previousGraceDays: previous.graceDays },
    });
  }, { behavior: "immediate" });
  return await getMfaPolicyView();
}
