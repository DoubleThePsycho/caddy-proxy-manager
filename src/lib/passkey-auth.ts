/**
 * Better Auth wiring for dashboard passkeys (WebAuthn): the passkey plugin's
 * options and a small plugin of hooks around it. The rules are in
 * src/lib/passkeys.ts and documentation/mfa.md.
 *
 *  - Relying party: the RP ID is the host name of BASE_URL and the only origin
 *    accepted is BASE_URL's, whatever the request's Origin header says.
 *  - User verification (PIN or biometrics) is required at registration and at
 *    every sign-in, and checked on the server: the plugin itself would accept
 *    an assertion without it. That is what makes a passkey a second factor.
 *  - Adding a passkey needs the account password (and a session less than a
 *    day old, the plugin's own rule), and only accounts with a local password
 *    may add one; SSO enforcement allows only break-glass accounts.
 *  - Passkey sign-in (/passkey/verify-authentication) creates its session
 *    through the session hooks in auth-server.ts: disabled accounts and
 *    organisations are refused, and while SSO is enforced only break-glass
 *    accounts get in (it is not an identity-provider sign-in).
 *  - A password sign-in of an account whose only second factor is a passkey
 *    does not create a session: it answers like an authenticator challenge,
 *    with `twoFactorMethods: ["passkey"]`, and the account signs in with its
 *    passkey. A passkey sign-in does not need the password, so nothing ties
 *    the two steps together.
 *  - Listing, renaming and removing passkeys go through /api/v1/passkeys
 *    (audit, MFA policy); the plugin's own endpoints for them are off.
 */
import { passkey, getAuthenticatorName } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { appDb } from "./db";
import { accounts, users } from "./db/schema";
import { config } from "./config";
import { logAuditEvent } from "./audit";
import { ApiValidationError } from "./api-errors";
import { createRateLimiter, LOGIN_RATE_LIMIT } from "./rate-limit";
import { sessionUserIdFromRequest, PASSWORD_SIGN_IN_PATHS } from "./mfa-auth";
import { markPasskeyUsed, parsePasskeyName, passkeyRegistrationBlocker } from "./passkeys";
import { passkeyCount } from "./mfa";
import { brandName } from "@/ee/white-label/store";
import { BRAND_NAME } from "./brand";
import { first } from "@/src/lib/db/ops";

export const PASSKEY_REGISTER_OPTIONS_PATH = "/passkey/generate-register-options";
export const PASSKEY_VERIFY_REGISTRATION_PATH = "/passkey/verify-registration";
export const PASSKEY_AUTHENTICATE_OPTIONS_PATH = "/passkey/generate-authenticate-options";
export const PASSKEY_SIGN_IN_PATH = "/passkey/verify-authentication";

/** The plugin's management endpoints Ingressi does not offer: /api/v1/passkeys replaces them. */
export const PASSKEY_DISABLED_PATHS: readonly string[] = [
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
];

/**
 * The relying party: BASE_URL's host name and origin. A BASE_URL that is not
 * an absolute URL (production refuses to start with one) leaves passkeys
 * pinned to http://localhost, where no real browser's ceremony matches:
 * passkeys then fail closed instead of trusting the request's Origin header.
 */
export function passkeyRelyingParty(baseUrl: string = config.baseUrl): { rpID: string; origin: string } {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "https:" || url.protocol === "http:") return { rpID: url.hostname, origin: url.origin };
  } catch {
    // Falls through.
  }
  return { rpID: "localhost", origin: "http://localhost" };
}

function relyingPartyName(): string {
  try {
    return brandName().trim() || BRAND_NAME;
  } catch {
    return BRAND_NAME;
  }
}

const userVerificationRequired = (): APIError =>
  new APIError("BAD_REQUEST", {
    message: "This passkey did not ask for your PIN or biometrics. Use a passkey or security key that does.",
    code: "USER_VERIFICATION_REQUIRED",
  });

/** Better Auth's passkey plugin as Ingressi configures it. */
export function createPasskeyPlugin(): BetterAuthPlugin {
  const { rpID, origin } = passkeyRelyingParty();
  return passkey({
    rpID,
    rpName: relyingPartyName(),
    origin,
    // Discoverable credentials (sign in without typing a username) that
    // verify the person.
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    registration: {
      requireSession: true,
      afterVerification: async ({ verification }) => {
        if (verification.registrationInfo?.userVerified !== true) throw userVerificationRequired();
        const authenticator = getAuthenticatorName(verification.registrationInfo?.aaguid);
        return authenticator ? { name: authenticator } : undefined;
      },
    },
    authentication: {
      afterVerification: async ({ verification }) => {
        if (verification.authenticationInfo?.userVerified !== true) {
          throw new APIError("UNAUTHORIZED", { message: "Authentication failed", code: "AUTHENTICATION_FAILED" });
        }
      },
    },
    schema: { passkey: { modelName: "passkeys" } },
  }) as unknown as BetterAuthPlugin;
}

// ── Hooks ────────────────────────────────────────────────────────────────

/** Wrong passwords when adding a passkey, per account. */
const passwordConfirmations = createRateLimiter({ name: "passkey-password", ...LOGIN_RATE_LIMIT });

/** The local password hash of `userId`, or null when it has none. */
async function localPasswordHash(userId: number): Promise<string | null> {
  const row = await first(appDb
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(
      eq(accounts.userId, userId),
      eq(accounts.providerId, "credential"),
      isNotNull(accounts.password),
      ne(accounts.password, "")
    ))
    .limit(1));
  return row?.password ?? null;
}

/** Checks the account password before a passkey is stored; throws Better Auth's own "Invalid password" otherwise. */
async function confirmPassword(userId: number, password: unknown): Promise<void> {
  const key = `passkey:${userId}`;
  if ((await passwordConfirmations.isRateLimited(key)).blocked) {
    throw new APIError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again in a few minutes.", code: "TOO_MANY_ATTEMPTS" });
  }
  const hash = await localPasswordHash(userId);
  const bcrypt = await import("bcryptjs");
  const ok = typeof password === "string" && password.length > 0 && password.length <= 1024 && hash !== null
    ? await bcrypt.default.compare(password, hash)
    : false;
  if (!ok) {
    await passwordConfirmations.registerAttempt(key);
    throw new APIError("BAD_REQUEST", { message: "Invalid password", code: "INVALID_PASSWORD" });
  }
  await passwordConfirmations.resetAttempts(key);
}

type HookContext = {
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
  headers?: Headers;
  request?: Request;
  json: (body: unknown) => unknown;
  context: {
    secret: string;
    authCookies?: { sessionToken?: { name?: string } };
    returned?: unknown;
    newSession?: { session: { token: string }; user: { id: string | number; twoFactorEnabled?: unknown } } | null;
    setNewSession: (session: null) => void;
    internalAdapter: { deleteSession: (token: string) => Promise<void> };
  };
};

function bodyRecord(ctx: HookContext): Record<string, unknown> | undefined {
  return ctx.body !== null && typeof ctx.body === "object" ? ctx.body as Record<string, unknown> : undefined;
}

async function requireRegistrationAllowed(ctx: HookContext): Promise<number> {
  const userId = await sessionUserIdFromRequest(ctx);
  if (userId === null) throw new APIError("UNAUTHORIZED", { message: "Unauthorized", code: "UNAUTHORIZED" });
  const blocker = await passkeyRegistrationBlocker(userId);
  if (blocker) throw new APIError("BAD_REQUEST", { message: blocker, code: "PASSKEY_NOT_ALLOWED" });
  return userId;
}

/** The name an authenticator shows for the account: its sign-in username, or its email address. */
async function accountLabel(userId: number): Promise<string> {
  const row = await first(appDb.select({ username: users.username, email: users.email }).from(users).where(eq(users.id, userId)).limit(1));
  return row?.username || row?.email || String(userId);
}

const beforePasskeyRequest = createAuthMiddleware(async (rawCtx) => {
  const ctx = rawCtx as unknown as HookContext;
  if (ctx.path === PASSKEY_REGISTER_OPTIONS_PATH) {
    const userId = await requireRegistrationAllowed(ctx);
    // The server names the credential's user, never the client.
    return { context: { query: { ...(ctx.query ?? {}), name: await accountLabel(userId) } } };
  }
  if (ctx.path === PASSKEY_VERIFY_REGISTRATION_PATH) {
    const body = bodyRecord(ctx);
    const userId = await requireRegistrationAllowed(ctx);
    if (body) {
      // Registering never signs anyone in.
      delete body.createSession;
      if (body.name !== undefined && body.name !== null && body.name !== "") {
        try {
          body.name = parsePasskeyName(body.name);
        } catch (error) {
          if (error instanceof ApiValidationError) throw new APIError("BAD_REQUEST", { message: error.message, code: "INVALID_NAME" });
          throw error;
        }
      } else {
        delete body.name;
      }
    }
    const password = body?.password;
    if (body) delete body.password;
    await confirmPassword(userId, password);
  }
  return undefined;
});

/**
 * A password sign-in (local or directory) of an account whose second factor
 * is a passkey and not an authenticator app: the session it just created is
 * removed and the client is told to sign in with the passkey. Accounts with an
 * authenticator app get Better Auth's own challenge (two-factor plugin).
 */
const passkeyInsteadOfPassword = createAuthMiddleware(async (rawCtx) => {
  const ctx = rawCtx as unknown as HookContext;
  const created = ctx.context.newSession;
  if (!created) return;
  const userId = Number(created.user.id);
  if (!Number.isSafeInteger(userId)) return;
  // An authenticator app: the two-factor plugin's challenge handles this sign-in.
  const totp = (await first(appDb.select({ flag: users.twoFactorEnabled }).from(users).where(eq(users.id, userId)).limit(1)))?.flag === true;
  if (totp || created.user.twoFactorEnabled === true || await passkeyCount(appDb, userId) === 0) return;
  deleteSessionCookie(rawCtx as Parameters<typeof deleteSessionCookie>[0], true);
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  ctx.context.setNewSession(null);
  return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ["passkey"] });
});

const afterPasskeyRequest = createAuthMiddleware(async (rawCtx) => {
  const ctx = rawCtx as unknown as HookContext;
  const returned = ctx.context.returned;
  if (returned === undefined || isAPIError(returned)) return;
  if (ctx.path === PASSKEY_VERIFY_REGISTRATION_PATH) {
    const userId = await sessionUserIdFromRequest(ctx);
    if (userId === null) return;
    const name = typeof (returned as { name?: unknown }).name === "string" ? (returned as { name: string }).name : null;
    await logAuditEvent({
      userId,
      action: "passkey_added",
      entityType: "user",
      entityId: userId,
      summary: name ? `Added a passkey ("${name}")` : "Added a passkey",
      data: { passkeyId: Number((returned as { id?: unknown }).id) || null },
    });
    return;
  }
  if (ctx.path === PASSKEY_SIGN_IN_PATH && ctx.context.newSession) {
    const response = bodyRecord(ctx)?.response as { id?: unknown } | undefined;
    if (typeof response?.id === "string") await markPasskeyUsed(response.id);
  }
});

/** Ingressi's checks around the passkey plugin. */
export function passkeyGuardPlugin(): BetterAuthPlugin {
  return {
    id: "ingressi-passkey-guard",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === PASSKEY_REGISTER_OPTIONS_PATH || context.path === PASSKEY_VERIFY_REGISTRATION_PATH,
          handler: beforePasskeyRequest,
        },
      ],
      after: [
        {
          matcher: (context) => context.path !== undefined && PASSWORD_SIGN_IN_PATHS.has(context.path),
          handler: passkeyInsteadOfPassword,
        },
        {
          matcher: (context) => context.path === PASSKEY_VERIFY_REGISTRATION_PATH || context.path === PASSKEY_SIGN_IN_PATH,
          handler: afterPasskeyRequest,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
