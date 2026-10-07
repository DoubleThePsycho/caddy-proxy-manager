/**
 * Better Auth wiring for dashboard MFA: the two-factor plugin's options and
 * the request and database hooks src/lib/auth-server.ts installs around it.
 *
 * How sign-in works with MFA (all Better Auth's two-factor plugin):
 *  1. A password sign-in (/sign-in/username or /sign-in/email), or a
 *     directory sign-in (/sign-in/ldap, ee/ldap, which reuses the plugin's
 *     hook for its path), of an account
 *     with MFA passes Ingressi's session checks (status, enforced SSO), then the
 *     plugin deletes the session it just created, clears its cookie and
 *     answers `{ twoFactorRedirect: true }` with a short-lived, signed
 *     `two_factor` challenge cookie instead.
 *  2. /two-factor/verify-totp or /two-factor/verify-backup-code with that
 *     cookie creates the session. Ingressi's session checks run again on that
 *     path, so a break-glass account under enforced SSO is the only password
 *     account that gets this far while SSO is enforced, and a disabled
 *     account never does.
 * OAuth/OIDC and SAML sign-ins (ee/saml) never reach step 1: the identity
 * provider handles MFA, so an account with MFA turned on is not asked for a
 * local code after signing in through one.
 *
 * Passkeys (passkey-auth.ts) are a second factor too. An account whose only
 * second factor is a passkey gets no session from step 1 either: it is told
 * to sign in with the passkey (`twoFactorMethods: ["passkey"]`).
 *
 * Limits on second-factor attempts: 5 per challenge (then sign in again),
 * 10 consecutive failures per account lock it for 15 minutes (any factor,
 * across challenges), Better Auth's per-IP limit of 3 requests per 10 seconds
 * on /two-factor/* (unless AUTH_RATE_LIMIT_ENABLED=false), and a TOTP code
 * that already signed the account in is refused for the rest of its validity.
 */
import { twoFactor } from "better-auth/plugins/two-factor";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { parseCookies } from "better-auth/cookies";
import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import { and, eq, gt } from "drizzle-orm";
import { appDb } from "./db";
import { sessions, users } from "./db/schema";
import { decryptSecret, encryptSecret } from "./secret";
import { BRAND_NAME } from "./brand";
import { brandName } from "@/ee/white-label/store";
import { logAuditEvent } from "./audit";
import { hasPasswordCredential, isMfaRequiredFor, passkeyCount } from "./mfa";
import { getClientIp, UNKNOWN_CLIENT_IP } from "./client-ip";
import { LDAP_SIGN_IN_PATH } from "@/ee/ldap/constants";
import { SAML_ACS_PATH } from "@/ee/saml/constants";
import { confirmDirectoryPassword } from "@/ee/ldap/confirm-password";
import { first } from "@/src/lib/db/ops";
import { defineRuntimeEntries } from "./shared-runtime-state";
import { createHash } from "node:crypto";
import { SIGN_IN_METHODS, type SignInMethod } from "./sign-in-activity";

/** How long the second step of a sign-in may take before the password has to be entered again. */
export const MFA_CHALLENGE_MAX_AGE_SECONDS = 5 * 60;

/** Account-level lockout for failed second-factor attempts at sign-in. */
export const MFA_ACCOUNT_LOCKOUT = { maxFailedAttempts: 10, durationSeconds: 15 * 60 } as const;

export const TOTP_PERIOD_SECONDS = 30;

/** The sign-in steps that complete a password sign-in with a second factor. */
export const MFA_VERIFY_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

/**
 * Plugin endpoints that replace the caller's session with a new one for the
 * same account (turning MFA on or off). Such a replacement is not a sign-in.
 */
export const MFA_SESSION_ROTATION_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

/**
 * Plugin endpoints Ingressi does not offer: reading the TOTP secret back after
 * enrolment, and e-mail/SMS one-time codes (no sender is configured).
 */
export const MFA_DISABLED_PATHS: readonly string[] = [
  "/two-factor/get-totp-uri",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
];

/**
 * Better Auth sign-in endpoints that are turned into a challenge for accounts
 * with MFA: password sign-in, and directory sign-in (ee/ldap), which checks a
 * password too.
 */
export const PASSWORD_SIGN_IN_PATHS: ReadonlySet<string> = new Set(["/sign-in/username", "/sign-in/email", LDAP_SIGN_IN_PATH]);

/**
 * Plugin endpoints that confirm the account password first. Better Auth
 * checks it only for an account with a local password (allowPasswordless);
 * mfaBeforeRequest has every other account confirm its directory password,
 * or refuses it.
 */
export const MFA_PASSWORD_CONFIRMATION_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
]);

export const MFA_REQUIRED_BY_POLICY_MESSAGE =
  "Your administrator requires multi-factor authentication for your account, so it cannot be turned off. Add a passkey first to use that instead.";

/** The name authenticator apps show for new entries; ":" would split the otpauth label. */
export function authenticatorIssuer(): string {
  return brandName().replace(/:/g, " ").trim() || BRAND_NAME;
}

/** Better Auth's two-factor plugin as Ingressi configures it. */
export function createTwoFactorPlugin(): BetterAuthPlugin {
  return twoFactor({
    issuer: BRAND_NAME,
    skipVerificationOnEnable: false,
    // Better Auth then asks for the local password only of accounts that
    // have one. Accounts without one (directory and OAuth accounts) never
    // reach the plugin unconfirmed: mfaBeforeRequest has them confirm their
    // directory password, and refuses everyone else, as before.
    allowPasswordless: true,
    twoFactorCookieMaxAge: MFA_CHALLENGE_MAX_AGE_SECONDS,
    totpOptions: { digits: 6, period: TOTP_PERIOD_SECONDS },
    backupCodeOptions: {
      amount: 10,
      length: 10,
      // Ingressi's own encryption, so SESSION_SECRET rotation (secret-rotation.ts)
      // re-encrypts them like every other stored secret.
      storeBackupCodes: {
        encrypt: async (codes: string) => encryptSecret(codes),
        decrypt: async (stored: string) => decryptSecret(stored, "MFA backup codes"),
      },
    },
    accountLockout: { enabled: true, ...MFA_ACCOUNT_LOCKOUT },
    schema: { twoFactor: { modelName: "two_factors" } },
  }) as unknown as BetterAuthPlugin;
}

// ── Request helpers ──────────────────────────────────────────────────────

/** The parts of a Better Auth endpoint or hook context these helpers read. */
type AuthRequestContext = {
  path?: string;
  headers?: Headers;
  request?: Request;
  context?: {
    secret?: string;
    authCookies?: { sessionToken?: { name?: string } };
  };
};

/**
 * The account whose session cookie came with the request, or null when there
 * is none, it is not validly signed, or the session has ended. Reads the
 * database directly, so it works in database hooks too.
 */
/** The unexpired session row the request's signed session cookie names, or null. */
async function sessionFromRequest(
  ctx: AuthRequestContext | null | undefined
): Promise<{ userId: number; signInMethod: string | null } | null> {
  const headers = ctx?.headers ?? ctx?.request?.headers;
  const cookieHeader = headers?.get("cookie");
  const cookieName = ctx?.context?.authCookies?.sessionToken?.name;
  const secret = ctx?.context?.secret;
  if (!cookieHeader || !cookieName || !secret) return null;
  const value = parseCookies(cookieHeader).get(cookieName);
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  if (!constantTimeEqual(value.slice(dot + 1), await makeSignature(token, secret))) return null;
  const row = await first(appDb
    .select({ userId: sessions.userId, signInMethod: sessions.signInMethod })
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date().toISOString())))
    .limit(1));
  return row ?? null;
}

export async function sessionUserIdFromRequest(ctx: AuthRequestContext | null | undefined): Promise<number | null> {
  return (await sessionFromRequest(ctx))?.userId ?? null;
}

/**
 * How the session the request came with was signed in to: an MFA management
 * endpoint that replaces it gives the new session the same method.
 */
export async function requestSessionSignInMethod(ctx: AuthRequestContext | null | undefined): Promise<SignInMethod | null> {
  const method = (await sessionFromRequest(ctx))?.signInMethod ?? null;
  return method !== null && (SIGN_IN_METHODS as readonly string[]).includes(method) ? (method as SignInMethod) : null;
}

/**
 * Whether Better Auth is creating `userId`'s session on an MFA management
 * endpoint to replace the one the request came with: the session an account
 * already has, not a new sign-in.
 */
export async function isMfaSessionRotation(
  userId: number,
  ctx: AuthRequestContext | null | undefined
): Promise<boolean> {
  if (!ctx?.path || !MFA_SESSION_ROTATION_PATHS.has(ctx.path)) return false;
  return (await sessionUserIdFromRequest(ctx)) === userId;
}

/**
 * Whether a password sign-in of the account needs a second step: an
 * authenticator app (the flag the two-factor plugin checks) or a passkey
 * (passkey-auth.ts).
 */
async function needsSecondStep(userId: number): Promise<boolean> {
  const row = await first(appDb.select({ flag: users.twoFactorEnabled }).from(users).where(eq(users.id, userId)).limit(1));
  return row?.flag === true || await passkeyCount(appDb, userId) > 0;
}

/**
 * The audit summary for a new session, or null when the session is not a
 * completed sign-in: a password sign-in of an account with MFA (the plugin
 * replaces it with a challenge), or an MFA management endpoint replacing the
 * caller's session.
 */
export async function signInAuditSummary(
  userId: number,
  ctx: AuthRequestContext | null | undefined
): Promise<string | null> {
  const path = ctx?.path;
  if (path && MFA_SESSION_ROTATION_PATHS.has(path)) {
    return (await isMfaSessionRotation(userId, ctx)) ? null : "User signed in with a second factor";
  }
  if (path && PASSWORD_SIGN_IN_PATHS.has(path) && await needsSecondStep(userId)) return null;
  if (path === LDAP_SIGN_IN_PATH) return "User signed in through an LDAP directory";
  if (path === SAML_ACS_PATH) return "User signed in through a SAML provider";
  if (path === "/passkey/verify-authentication") return "User signed in with a passkey";
  return "User signed in";
}

/** Records turning MFA on or off, from Better Auth's user update hook. */
export async function auditTwoFactorChange(
  user: { id?: string | number; twoFactorEnabled?: unknown } | null | undefined,
  ctx: AuthRequestContext | null | undefined
): Promise<void> {
  const userId = Number(user?.id);
  if (!Number.isSafeInteger(userId)) return;
  if (ctx?.path === "/two-factor/verify-totp" && user?.twoFactorEnabled === true) {
    await logAuditEvent({
      userId,
      action: "mfa_enabled",
      entityType: "user",
      entityId: userId,
      summary: "Turned on multi-factor authentication (authenticator app)",
    });
  } else if (ctx?.path === "/two-factor/disable" && user?.twoFactorEnabled === false) {
    await logAuditEvent({
      userId,
      action: "mfa_disabled",
      entityType: "user",
      entityId: userId,
      summary: "Turned off multi-factor authentication",
    });
  }
}

// ── Challenges and TOTP replay ───────────────────────────────────────────

/** A Map that forgets its oldest entries beyond `max`, so client input cannot grow it without bound. */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }

  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.max) {
      const oldest = this.keys().next();
      if (!oldest.done) this.delete(oldest.value);
    }
    return super.set(key, value);
  }
}

/**
 * Challenge identifier -> account, from the before hook to the after hook of
 * one verification (one request, so one process).
 */
const pendingChallenges = new BoundedMap<string, number>(1_000);

/**
 * The TOTP codes that signed an account in, for as long as they could still
 * be accepted, by the SHA-256 of `${userId}:${code}`. The same code may be
 * replayed to another replica: on PostgreSQL they live in the shared runtime
 * state (src/lib/shared-runtime-state.ts), in memory on SQLite.
 */
const usedTotpCodes = defineRuntimeEntries<true>("totp-used", { maxEntries: 10_000, isValue: (value): value is true => value === true });

/** A code is accepted for the step before, the current one and the one after. */
const TOTP_REPLAY_WINDOW_MS = 3 * TOTP_PERIOD_SECONDS * 1000;

function usedCodeKey(userId: number, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`, "utf8").digest("base64url");
}

async function totpCodeWasUsed(userId: number, code: string): Promise<boolean> {
  return (await usedTotpCodes.get(usedCodeKey(userId, code))) === true;
}

async function rememberTotpCode(userId: number, code: string): Promise<void> {
  try {
    await usedTotpCodes.put(usedCodeKey(userId, code), true, TOTP_REPLAY_WINDOW_MS);
  } catch (error) {
    console.warn("[mfa] Failed to remember a used authenticator code:", error instanceof Error ? error.name : typeof error);
  }
}

/** For tests: forget used codes and pending challenges. */
export async function resetMfaRequestStateForTests(): Promise<void> {
  pendingChallenges.clear();
  await usedTotpCodes.clear();
}

/** The parts of a Better Auth hook context the request hooks use. */
export type MfaHookContext = AuthRequestContext & {
  path: string;
  body?: unknown;
  getSignedCookie: (name: string, secret: string) => Promise<string | null | false>;
  context: NonNullable<AuthRequestContext["context"]> & {
    secret: string;
    createAuthCookie: (name: string) => { name: string };
    internalAdapter: {
      findVerificationValue: (identifier: string) => Promise<{ value: string; expiresAt: Date | string } | null>;
    };
    returned?: unknown;
    newSession?: { user?: { id?: string | number } } | null;
  };
};

async function challengeIdentifier(ctx: MfaHookContext): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie("two_factor");
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  return typeof value === "string" && value ? value : null;
}

/** The account a sign-in challenge belongs to, or null when it is unknown or has expired. */
async function challengeUserId(ctx: MfaHookContext, identifier: string): Promise<number | null> {
  const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!row || new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const userId = Number(row.value);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

function bodyRecord(ctx: MfaHookContext): Record<string, unknown> | undefined {
  return ctx.body !== null && typeof ctx.body === "object" ? ctx.body as Record<string, unknown> : undefined;
}

/** What a wrong code gets. */
function invalidCode(): APIError {
  return new APIError("UNAUTHORIZED", { message: "Invalid code", code: "INVALID_CODE" });
}

/** What a wrong password gets on the plugin's endpoints (Better Auth's own reply). */
function invalidPassword(): APIError {
  return new APIError("BAD_REQUEST", { message: "Invalid password", code: "INVALID_PASSWORD" });
}

/**
 * The password check for an account without a local password, before the
 * plugin's endpoint runs (which, with allowPasswordless, would not ask). An
 * account linked to a directory confirms its directory password; any other
 * account (signing in only through an identity provider) cannot manage MFA,
 * exactly as before. Fails closed when the session cannot be read.
 */
async function confirmPasswordWithoutLocalOne(ctx: MfaHookContext, body: Record<string, unknown> | undefined): Promise<void> {
  const userId = await sessionUserIdFromRequest(ctx);
  if (userId === null) {
    throw new APIError("UNAUTHORIZED", { message: "Unauthorized", code: "UNAUTHORIZED" });
  }
  if (await hasPasswordCredential(appDb, userId)) return; // Better Auth checks the local password.
  const password = typeof body?.password === "string" ? body.password : "";
  const headers = ctx.headers ?? ctx.request?.headers;
  const result = await confirmDirectoryPassword(userId, password, headers ? getClientIp(headers) : UNKNOWN_CLIENT_IP);
  if (result === "rate_limited") {
    throw new APIError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again in a few minutes.", code: "TOO_MANY_ATTEMPTS" });
  }
  if (result !== "confirmed") throw invalidPassword();
}

/**
 * Ingressi's checks on the plugin's endpoints, before the plugin runs:
 *  - an account without a local password confirms its directory password
 *    before turning MFA on or off or making new backup codes, or is refused;
 *  - no "trust this device" (it would skip the second factor for 30 days),
 *    and a backup code at sign-in always completes the sign-in (no
 *    `disableSession`, which would use up the code but leave the challenge open);
 *  - the issuer in the authenticator entry is set here (the product name), never by the client;
 *  - a TOTP code that already signed the account in is refused like a wrong
 *    one for as long as it could still be accepted;
 *  - an account the MFA policy covers cannot turn MFA off.
 */
export async function mfaBeforeRequest(ctx: MfaHookContext): Promise<void> {
  const body = bodyRecord(ctx);
  if (ctx.path === "/two-factor/enable" && body) {
    // The server picks the issuer (the white-label product name); a client-sent one is ignored.
    body.issuer = authenticatorIssuer();
  }

  if (MFA_PASSWORD_CONFIRMATION_PATHS.has(ctx.path)) {
    await confirmPasswordWithoutLocalOne(ctx, body);
  }

  if (MFA_VERIFY_PATHS.has(ctx.path)) {
    if (body) {
      delete body.trustDevice;
      delete body.disableSession;
      if (typeof body.code === "string") {
        body.code = ctx.path === "/two-factor/verify-totp" ? body.code.replace(/\s+/g, "") : body.code.trim();
      }
    }
    const identifier = await challengeIdentifier(ctx);
    const userId = identifier ? await challengeUserId(ctx, identifier) : null;
    if (identifier && userId !== null) {
      pendingChallenges.set(identifier, userId);
      if (ctx.path === "/two-factor/verify-totp" && typeof body?.code === "string" && await totpCodeWasUsed(userId, body.code)) {
        pendingChallenges.delete(identifier);
        await logAuditEvent({
          userId,
          action: "mfa_verification_failed",
          entityType: "user",
          entityId: userId,
          summary: "Second-factor sign-in step refused: the authenticator code was already used",
          data: { method: "totp", reason: "REPLAYED_CODE" },
        });
        throw invalidCode();
      }
    }
  }

  if (ctx.path === "/two-factor/disable") {
    const userId = await sessionUserIdFromRequest(ctx);
    // A passkey keeps MFA on, so the authenticator app can go.
    if (userId !== null && await isMfaRequiredFor(appDb, userId) && await passkeyCount(appDb, userId) === 0) {
      throw new APIError("BAD_REQUEST", { message: MFA_REQUIRED_BY_POLICY_MESSAGE, code: "MFA_REQUIRED_BY_POLICY" });
    }
  }
}

/** Audit records and replay bookkeeping once the plugin has answered. */
export async function mfaAfterRequest(ctx: MfaHookContext): Promise<void> {
  const returned = ctx.context.returned;

  if (MFA_VERIFY_PATHS.has(ctx.path)) {
    const identifier = await challengeIdentifier(ctx);
    const userId = identifier ? pendingChallenges.get(identifier) ?? null : null;
    if (identifier) pendingChallenges.delete(identifier);
    if (userId === null) return;
    const method = ctx.path === "/two-factor/verify-totp" ? "totp" : "backup_code";
    if (isAPIError(returned)) {
      const code = (returned.body as { code?: unknown } | undefined)?.code;
      await logAuditEvent({
        userId,
        action: "mfa_verification_failed",
        entityType: "user",
        entityId: userId,
        summary: "Second-factor sign-in step failed",
        data: { method, reason: typeof code === "string" ? code : "UNKNOWN" },
      });
      return;
    }
    const signedIn = Number(ctx.context.newSession?.user?.id) === userId;
    const code = bodyRecord(ctx)?.code;
    if (signedIn && method === "totp" && typeof code === "string") await rememberTotpCode(userId, code);
    if (signedIn && method === "backup_code") {
      await logAuditEvent({
        userId,
        action: "mfa_backup_code_used",
        entityType: "user",
        entityId: userId,
        summary: "Signed in with a backup code",
      });
    }
    return;
  }

  if (ctx.path === "/two-factor/generate-backup-codes" && returned !== undefined && !isAPIError(returned)) {
    const userId = await sessionUserIdFromRequest(ctx);
    if (userId !== null) {
      await logAuditEvent({
        userId,
        action: "mfa_backup_codes_regenerated",
        entityType: "user",
        entityId: userId,
        summary: "Generated new MFA backup codes",
      });
    }
  }
}
