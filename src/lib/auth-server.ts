import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth, username } from "better-auth/plugins";
import { createHash } from "node:crypto";
import { appDb } from "./db";
import { getAuthDatabase } from "./db/auth-database";
import { isPostgres } from "./db/dialect";
import { defineCachedValue } from "./db/cached-value";
import * as schema from "./db/schema";
import { and, eq } from "drizzle-orm";
import { config } from "./config";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secret";
import type { OAuthProvider } from "./models/oauth-providers";
import type { GenericOAuthConfig } from "better-auth/plugins";
import {
  CREDENTIAL_ACCOUNT_ISSUER,
  resolveOAuthAccountIssuer,
} from "./account-issuer";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordPolicyMessage } from "./password-policy";
import { LOGIN_USERNAME_MAX_LENGTH, LOGIN_USERNAME_MIN_LENGTH, isValidLoginUsername } from "./login-username";
import { ApiClientError } from "./api-errors";
import { logAuditEvent } from "./audit";
import { isSessionAllowedUnderSsoEnforcement, isSsoEnforced } from "@/ee/sso/sign-in";
import { LDAP_SIGN_IN_PATH, ldapAccountIssuer, parseLdapProviderId } from "@/ee/ldap/constants";
import { ldapSignInPlugin } from "@/ee/ldap/plugin";
import { SAML_ACS_PATH_PREFIX, parseSamlProviderId, samlAccountIssuer } from "@/ee/saml/constants";
import { samlSignInPlugin } from "@/ee/saml/plugin";
import { isDirectorySessionAllowedUnderSsoEnforcement } from "@/ee/ldap/sso";
import { canLinkScimSignIn } from "@/ee/scim/binding";
import {
  MFA_DISABLED_PATHS,
  auditTwoFactorChange,
  createTwoFactorPlugin,
  isMfaSessionRotation,
  mfaAfterRequest,
  mfaBeforeRequest,
  requestSessionSignInMethod,
  signInAuditSummary,
  type MfaHookContext,
} from "./mfa-auth";
import { PASSKEY_DISABLED_PATHS, PASSKEY_SIGN_IN_PATH, createPasskeyPlugin, passkeyGuardPlugin } from "./passkey-auth";
import { completedSignIn, noteFirstSignInStep, recordSignIn, type SignInMethod } from "./sign-in-activity";
import { setSessionSignInMethod } from "./models/sessions";
import { first } from "@/src/lib/db/ops";

/** The enabled OAuth/OIDC providers, as Better Auth is built with them. */
type LoadedProviders = {
  /** SHA-256 of the provider rows: a change to any of them rebuilds Better Auth. */
  fingerprint: string;
  configs: GenericOAuthConfig[];
  trustedProviderIds: string[];
};

// The Better Auth instance of this module copy and the providers it was built with.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedAuth: any = null;
let cachedAuthProviders: LoadedProviders | null = null;

/**
 * OIDC spells the claim `email_verified`; some providers serialize it as a
 * string. Better Auth's generic-OAuth profile reader only looks at a camelCase
 * `emailVerified` field, so the claim has to be mapped explicitly.
 */
function profileEmailVerified(profile: Record<string, unknown>): boolean {
  const claim = profile.email_verified ?? profile.emailVerified;
  return claim === true || claim === "true";
}

export function mapOAuthProvider(p: OAuthProvider): GenericOAuthConfig {
  const cfg: GenericOAuthConfig = {
    providerId: p.id,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    scopes: p.scopes ? p.scopes.split(/[\s,]+/).filter(Boolean) : undefined,
    pkce: true,
    // Security: do not let an OAuth sign-in implicitly create a brand-new
    // account unless OAuth self-registration is explicitly enabled. Existing
    // users and (where configured) account linking still work — only first-time
    // auto-provisioning of an unknown identity is gated. Controlled by its own
    // flag, independent of credential self-registration.
    disableImplicitSignUp: !config.auth.allowOauthRegistration,
    // disableImplicitSignUp alone can be overridden by the client: Better Auth
    // honours a `requestSignUp: true` field on /sign-in/social. disableSignUp
    // closes account creation regardless of what the request asks for.
    disableSignUp: !config.auth.allowOauthRegistration,
    // Ownership of an existing Ingressi account is asserted by the operator through
    // the provider's auto-link switch, never by the IdP alone. Reporting the
    // claim only for auto-link providers keeps a provider that merely returns
    // `email_verified: true` from attaching itself to a local account. The
    // switch does not depend on the claim: Better Auth links an auto-link
    // (trusted) provider's identity by matching email even when the claim is
    // missing or false, so the switch trusts the provider's addresses.
    //
    // SCIM provisioning (ee/scim) adds one narrow case: the first sign-in
    // through the provider chosen in the SCIM settings may link to an account
    // SCIM provisioned (never a local account SCIM was not given), under the
    // checks in ee/scim/binding.ts.
    mapProfileToUser: async (profile) => ({
      emailVerified:
        (p.autoLink === true && profileEmailVerified(profile)) ||
        await canLinkScimSignIn(p.id, profile as Record<string, unknown>),
    }),
  };
  if (p.authorizationUrl) cfg.authorizationUrl = p.authorizationUrl;
  if (p.tokenUrl) cfg.tokenUrl = p.tokenUrl;
  if (p.userinfoUrl) cfg.userInfoUrl = p.userinfoUrl;
  if (p.issuer) {
    // Only use discovery when explicit URLs are not provided
    if (!p.authorizationUrl && !p.tokenUrl) {
      cfg.discoveryUrl = p.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
    }
  }
  return cfg;
}

/**
 * Reads the enabled providers. A provider whose secrets do not decrypt fails
 * the whole read: the previous providers stay in use (none before the first
 * read) and the read is tried again.
 */
async function readProviders(): Promise<LoadedProviders> {
  const rows = await appDb
    .select()
    .from(schema.oauthProviders)
    .where(eq(schema.oauthProviders.enabled, true))
    .orderBy(schema.oauthProviders.id);
  const providers: OAuthProvider[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    clientId: decryptSecret(row.clientId, `OAuth provider "${row.name}"`),
    clientSecret: decryptSecret(row.clientSecret, `OAuth provider "${row.name}"`),
    issuer: row.issuer,
    authorizationUrl: row.authorizationUrl,
    tokenUrl: row.tokenUrl,
    userinfoUrl: row.userinfoUrl,
    scopes: row.scopes,
    autoLink: row.autoLink,
    enabled: row.enabled,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    configs: providers.map(mapOAuthProvider),
    trustedProviderIds: providers.filter((p) => p.autoLink).map((p) => p.id),
  };
}

/**
 * The providers Better Auth is built with, in memory (src/lib/db/cached-value.ts):
 * loaded at start-up, read again by reloadOAuthProviders() after a change and
 * every 30 seconds in the background, so getAuth() stays synchronous.
 */
const providerCache = defineCachedValue<LoadedProviders>("sign-in providers", {
  load: readProviders,
  fallback: { fingerprint: "", configs: [], trustedProviderIds: [] },
  isUnchanged: (current, next) => current.fingerprint === next.fingerprint,
});

/**
 * Security: force privileged user fields to safe defaults on every
 * better-auth-managed user creation (OAuth signup, and credential signup when
 * enabled). better-auth's generic-OAuth signup spreads the raw IdP profile
 * claims into the new user record (createOAuthUser({...restUserInfo})) and does
 * NOT honour the `input:false` flags declared on these additionalFields, so
 * without this a permissive or attacker-influenced IdP returning a `role` (or
 * `status`) claim could self-provision an admin account.
 *
 * Admin-initiated user creation goes through models/user.ts (a direct insert
 * that bypasses better-auth's database hooks), so legitimate role assignment is
 * unaffected. `provider`/`subject` are informational, not access-control, and
 * are intentionally left untouched.
 */
export function enforceSafeUserDefaults<T extends object>(user: T): T & { role: string; status: string } {
  return { ...withoutCustomRole(user), role: "user", status: "active" };
}

/**
 * Drops a `customRoleId` from a user Better Auth is about to create. Custom
 * roles (ee/custom-roles) are only ever assigned by a user with users:write;
 * an identity provider's claims can
 * never set one, not even with AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true, which
 * maps claims to the built-in roles only.
 */
export function withoutCustomRole<T extends object>(user: T): T {
  if (!("customRoleId" in user)) return user;
  const { customRoleId: _dropped, ...rest } = user as T & { customRoleId?: unknown };
  void _dropped;
  return rest as T;
}

/**
 * Better Auth endpoints left enabled that set a password from the request
 * body, mapped to the body field carrying it. /sign-up/email is live when
 * AUTH_ALLOW_SELF_REGISTRATION is on; /reset-password is reachable but has no
 * way to issue tokens while no sendResetPassword is configured.
 */
const PASSWORD_SETTING_FIELDS = new Map<string, string>([
  ["/sign-up/email", "password"],
  ["/reset-password", "newPassword"],
]);

/** Applies Ingressi's password policy to the Better Auth endpoints above. */
function enforcePasswordPolicy(path: string, body: Record<string, unknown> | undefined): void {
  const field = PASSWORD_SETTING_FIELDS.get(path);
  if (!field) return;
  const password = body?.[field];
  // A missing or non-string value is rejected by the endpoint's own validation.
  if (typeof password !== "string") return;
  const policyError = passwordPolicyMessage(password);
  if (policyError) {
    throw new APIError("BAD_REQUEST", { message: policyError });
  }
}

/**
 * Self-registration cannot choose a username: the account gets its own email
 * address as one (see applySignInNameRules). Removing the requested one
 * before the username plugin's hooks run also keeps the plugin from copying
 * displayUsername into it and from answering whether a name is taken.
 */
function dropRequestedUsername(path: string, body: Record<string, unknown> | undefined): void {
  if (path !== "/sign-up/email" || !body) return;
  delete body.username;
  delete body.displayUsername;
}

/**
 * Enforced SSO (ee/sso) closes self-registration with a password. It answers
 * as Better Auth does when self-registration is off, before the account is
 * created; the session hook below refuses every other password sign-in.
 */
async function refuseSignUpUnderSsoEnforcement(path: string): Promise<void> {
  if (path !== "/sign-up/email" || !await isSsoEnforced(appDb)) return;
  throw new APIError("BAD_REQUEST", {
    message: "Email and password sign up is not enabled",
    code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  });
}

/**
 * Records on a new session how its sign-in was made. A session left without
 * one (the write failed) is simply not reused by the forward-auth portal.
 */
async function markSessionSignInMethod(session: unknown, method: SignInMethod | null): Promise<void> {
  const id = Number((session as { id?: unknown } | null)?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  try {
    await setSessionSignInMethod(id, method);
  } catch {
    // Bookkeeping only; never fail a sign-in over it.
  }
}

/** Ingressi's checks on Better Auth requests; they run before the plugins' hooks. */
const beforeRequest = createAuthMiddleware(async (ctx) => {
  await refuseSignUpUnderSsoEnforcement(ctx.path);
  const body = ctx.body !== null && typeof ctx.body === "object" ? ctx.body as Record<string, unknown> : undefined;
  enforcePasswordPolicy(ctx.path, body);
  dropRequestedUsername(ctx.path, body);
  await mfaBeforeRequest(ctx as unknown as MfaHookContext);
});

/** Ingressi's bookkeeping after Better Auth answered; runs before the plugins' after hooks. */
const afterRequest = createAuthMiddleware(async (ctx) => {
  await mfaAfterRequest(ctx as unknown as MfaHookContext);
});

/**
 * The refusal a wrong password gets on `path`. Used for every sign-in that is
 * refused after the password was checked, so the reply never tells whether
 * the password was right.
 */
function invalidCredentials(path: string | undefined): APIError {
  // A passkey sign-in checks no password: it fails like a passkey that did not verify.
  if (path === PASSKEY_SIGN_IN_PATH) {
    return new APIError("UNAUTHORIZED", { message: "Authentication failed", code: "AUTHENTICATION_FAILED" });
  }
  return new APIError(
    "UNAUTHORIZED",
    path === "/sign-in/username" || path === LDAP_SIGN_IN_PATH
      ? { message: "Invalid username or password", code: "INVALID_USERNAME_OR_PASSWORD" }
      : { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" }
  );
}

/**
 * The accounts.issuer namespace of a new account: the credential namespace,
 * a directory's (ee/ldap, providerId "ldap:<id>"), a SAML provider's
 * (ee/saml, providerId "saml:<id>"), or the OAuth provider's pinned or
 * synthetic issuer.
 */
async function accountIssuerFor(providerId: string): Promise<string> {
  if (providerId === "credential") return CREDENTIAL_ACCOUNT_ISSUER;
  const directoryId = parseLdapProviderId(providerId);
  if (directoryId !== null) return ldapAccountIssuer(directoryId);
  const samlId = parseSamlProviderId(providerId);
  if (samlId !== null) return samlAccountIssuer(samlId);
  const configured = await first(appDb
    .select({ issuer: schema.oauthProviders.issuer })
    .from(schema.oauthProviders)
    .where(eq(schema.oauthProviders.id, providerId))
    .limit(1));
  return resolveOAuthAccountIssuer(providerId, configured?.issuer);
}

/** betterAuth()'s options, typed as betterAuth() types them, without the database. */
function authOptions<Options extends Omit<BetterAuthOptions, "database">>(options: Options): Options {
  return options;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createAuth(providers: LoadedProviders): any {
  const oauthConfigs = providers.configs;
  const trustedProviderIds = [...providers.trustedProviderIds];
  // One instance: directory sign-in (ee/ldap) reuses its second-factor hook.
  const twoFactorPlugin = createTwoFactorPlugin();

  const options = authOptions({
    secret: config.sessionSecret,
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    // Only trust the Host header when the operator explicitly opts in.
    // baseURL already pins the canonical origin; trustHost is only needed
    // behind reverse proxies that rewrite Host without setting X-Forwarded-Host.
    trustHost: process.env.AUTH_TRUST_HOST === "true",
    trustedOrigins: [config.baseUrl],
    // Self-service endpoints Ingressi does not use. Profile, password and account
    // changes go through Ingressi's own routes, which enforce its password policy,
    // keep users.passwordHash in sync and audit the change; leaving Better
    // Auth's equivalents reachable would bypass all of that (and let users
    // rename themselves, which feeds the forward-auth X-Ingressi-User header).
    disabledPaths: [
      "/update-user",
      "/change-password",
      "/change-email",
      "/delete-user",
      "/unlink-account",
      "/update-session",
      "/verify-password",
      "/is-username-available",
      // Two-factor plugin endpoints Ingressi does not offer (see mfa-auth.ts).
      ...MFA_DISABLED_PATHS,
      // Passkey management goes through /api/v1/passkeys (see passkey-auth.ts).
      ...PASSKEY_DISABLED_PATHS,
    ],
    advanced: {
      database: {
        generateId: "serial",
      },
      // The SAML assertion consumer service (ee/saml) is posted to by the
      // identity provider, cross-site by design, so Better Auth's origin
      // check is skipped for that path only. The binding cookie, the
      // request ID and the response signature protect it (ee/saml/plugin.ts).
      disableOriginCheck: [SAML_ACS_PATH_PREFIX],
    } as Record<string, unknown>,
    rateLimit: {
      enabled: process.env.AUTH_RATE_LIMIT_ENABLED !== "false",
      window: Number(process.env.AUTH_RATE_LIMIT_WINDOW ?? 60),
      max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 5),
      // On PostgreSQL several replicas may serve sign-in: they count together
      // in the auth_rate_limits table. One process (SQLite) keeps the counts
      // in memory, as before.
      ...(isPostgres() ? { storage: "database" as const, modelName: "auth_rate_limits" } : {}),
    },
    user: {
      modelName: "users",
      fields: {
        image: "avatarUrl",
      },
      additionalFields: {
        role: { type: "string", defaultValue: "user", input: false },
        status: { type: "string", defaultValue: "active", input: false },
        provider: { type: "string", defaultValue: "", input: false },
        subject: { type: "string", defaultValue: "", input: false },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: 7 * 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "accounts",
      accountLinking: {
        enabled: true,
        // A provider with "Auto-link accounts" enabled is trusted to prove that
        // its identity owns the Ingressi account carrying the same email address.
        trustedProviders: trustedProviderIds,
        // Ingressi has no local email-verification flow, so a user row's
        // emailVerified is never set and the default gate would refuse every
        // link. The per-provider trust decision above is the ownership signal.
        requireLocalEmailVerified: false,
      },
    },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.auth.allowSelfRegistration,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      password: {
        async hash(password: string) {
          const bcrypt = await import("bcryptjs");
          return await bcrypt.default.hash(password, 12);
        },
        async verify({ hash, password }: { hash: string; password: string }) {
          const bcrypt = await import("bcryptjs");
          return await bcrypt.default.compare(password, hash);
        },
      },
    },
    hooks: {
      before: beforeRequest,
      after: afterRequest,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: Record<string, unknown>, context?: { path?: string } | null) => {
            // Self-registration and OAuth sign-ups follow Ingressi's sign-in name
            // rules: the email address must not be another account's sign-in
            // name, and a self-registered account can only get its own email
            // as username (see applySignInNameRules).
            const { applySignInNameRules } = await import("./models/user");
            const selfRegistered = context?.path === "/sign-up/email";
            let named: Record<string, unknown>;
            try {
              named = await applySignInNameRules(user, selfRegistered);
            } catch (error) {
              // Self-registration answers as Better Auth does for an email
              // address an account already has, whatever the reason, so the
              // reply does not tell whether a name is another account's
              // username or portal name. An OAuth sign-up fails as Better
              // Auth's "unable to create user".
              if (selfRegistered && error instanceof ApiClientError) {
                throw new APIError("UNPROCESSABLE_ENTITY", {
                  message: "User already exists. Use another email.",
                  code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
                });
              }
              throw error;
            }
            // By default, never let an external IdP set privileged fields
            // (role/status) on a newly federated user — see enforceSafeUserDefaults
            // above. Operators who trust their IdP to manage roles can opt out
            // with AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS=true.
            if (config.auth.allowOauthRoleFromClaims) {
              return { data: withoutCustomRole(named) };
            }
            return { data: enforceSafeUserDefaults(named) };
          },
          after: async (user: { id: string | number }) => {
            const { releaseContestedSignInUsername } = await import("./models/user");
            await releaseContestedSignInUsername(Number(user.id));
          },
        },
        update: {
          // The two-factor plugin turns MFA on and off through a user update.
          after: async (user: { id?: string | number; twoFactorEnabled?: unknown } | null, context?: unknown) => {
            try {
              await auditTwoFactorChange(user, context as Parameters<typeof auditTwoFactorChange>[1]);
            } catch {
              // Audit only — never break authentication over it.
            }
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            const data = { ...account };
            if (data.accessToken) data.accessToken = encryptSecret(data.accessToken);
            if (data.refreshToken) data.refreshToken = encryptSecret(data.refreshToken);
            if (data.idToken) data.idToken = encryptSecret(data.idToken);
            // Better Auth 1.7.4 removed `issuer` from the account schema and
            // keys external identities by (providerId, accountId). Ingressi's
            // `accounts` table keeps a NOT NULL `issuer` column (with a
            // database default — see migration 0025 / issue #283) for its own
            // identity bookkeeping. Derive the namespace here: the credential
            // namespace for local password accounts, or the provider's
            // pinned/synthetic OAuth issuer otherwise.
            //
            // NOTE: this assignment does NOT survive to the database on
            // Better Auth 1.7.4 — its adapter maps inserts through the account
            // model's own fields and silently drops unknown ones like `issuer`
            // (verified against node_modules internals). The column default is
            // what actually satisfies the insert, and the account.create.after
            // hook below backfills the real namespace afterwards.
            const providerId = typeof data.providerId === "string" ? data.providerId : null;
            if (providerId) {
              // `issuer` is an Ingressi-only column absent from Better Auth 1.7.4's
              // account model, so assign through the widened record type.
              (data as Record<string, unknown>).issuer = await accountIssuerFor(providerId);
            }
            return { data };
          },
          after: async (account) => {
            // Better Auth 1.7.4's insert pipeline drops the issuer the `before`
            // hook assigns (unknown field), so accounts created by Better Auth
            // itself (credential link-account on sign-up, federated identities)
            // land with the column default ''. Ingressi queries key on issuer
            // namespaces (password change, account linking, identity lookup),
            // so backfill the real namespace here. Better Auth writes through
            // the application's executor (src/lib/db/auth-database.ts), so
            // this joins its open transaction instead of waiting for it on a
            // second connection.
            try {
              const providerId = typeof account.providerId === "string" && account.providerId
                ? account.providerId
                : null;
              const accountId = typeof account.accountId === "string" && account.accountId
                ? account.accountId
                : null;
              const userId = typeof account.userId === "string" ? Number(account.userId) : account.userId;
              if (providerId && accountId && Number.isFinite(userId)) {
                const issuer = await accountIssuerFor(providerId);
                if (issuer) {
                  await appDb.update(schema.accounts)
                    .set({ issuer })
                    .where(and(
                      eq(schema.accounts.userId, userId),
                      eq(schema.accounts.providerId, providerId),
                      eq(schema.accounts.accountId, accountId),
                      eq(schema.accounts.issuer, "")
                    ));
                }
              }
            } catch (e) {
              // Bookkeeping only — never break authentication over it.
              console.warn("[auth-server] Failed to backfill accounts.issuer:", e);
            }
            // Better Auth writes federated identities to the `accounts` table
            // only. Re-derive the informational users.provider/subject columns
            // from it so auto-linking, profile linking, and federated sign-up
            // are all reflected in the Ingressi user state (#261).
            try {
              const { syncUserOAuthIdentity } = await import("./models/user");
              const userId = typeof account.userId === "string" ? Number(account.userId) : account.userId;
              if (Number.isFinite(userId)) {
                await syncUserOAuthIdentity(userId);
              }
            } catch (e) {
              // Informational columns only — never break authentication over them.
              console.warn("[auth-server] Failed to sync users.provider/subject from accounts:", e);
            }
            // SCIM (ee/scim): record the first link of a provisioned account.
            try {
              const userId = typeof account.userId === "string" ? Number(account.userId) : account.userId;
              if (Number.isFinite(userId) && typeof account.providerId === "string" && account.providerId !== "credential") {
                const { noteScimSignInLink } = await import("@/ee/scim/binding");
                await noteScimSignInLink(userId, account.providerId);
              }
            } catch (e) {
              console.warn("[auth-server] Failed to record the SCIM sign-in link:", e instanceof Error ? e.name : typeof e);
            }
          },
        },
        update: {
          before: async (account) => {
            const data = { ...account };
            if (data.accessToken && !isEncryptedSecret(data.accessToken)) data.accessToken = encryptSecret(data.accessToken);
            if (data.refreshToken && !isEncryptedSecret(data.refreshToken)) data.refreshToken = encryptSecret(data.refreshToken);
            if (data.idToken && !isEncryptedSecret(data.idToken)) data.idToken = encryptSecret(data.idToken);
            return { data };
          },
          after: async (account) => {
            // Repeat OAuth sign-ins update the existing account row rather than
            // creating one; keep the projection fresh in that path too.
            try {
              const { syncUserOAuthIdentity } = await import("./models/user");
              const userId = typeof account.userId === "string" ? Number(account.userId) : account.userId;
              if (Number.isFinite(userId)) {
                await syncUserOAuthIdentity(userId);
              }
            } catch (e) {
              console.warn("[auth-server] Failed to sync users.provider/subject from accounts:", e);
            }
          },
        },
      },
      session: {
        create: {
          // A disabled account gets no session. Ingressi's own routes refuse one,
          // but Better Auth's endpoints would accept it, and a successful
          // sign-in would confirm the password. The refusal is the one a
          // wrong password gets.
          before: async (session: { userId: string | number }, context?: { path?: string } | null) => {
            const userId = Number(session.userId);
            const requestContext = context as Parameters<typeof isMfaSessionRotation>[1];
            const user = await first(appDb
              .select({ status: schema.users.status })
              .from(schema.users)
              .where(eq(schema.users.id, userId))
              .limit(1));
            if (user?.status !== "active") throw invalidCredentials(context?.path);
            // Enforced SSO (ee/sso): only identity-provider sign-ins and
            // break-glass accounts get a session. The password has already
            // been checked here, so the refusal is the one a wrong password
            // gets and takes as long: it tells nobody whether the password
            // was right or which accounts are break-glass ones.
            //
            // Turning MFA on or off replaces the caller's session with a new
            // one for the same account (see mfa-auth.ts). That is not a
            // sign-in, so it is not refused either: enforcement never ends
            // sessions that already exist.
            //
            // Directory sign-in (ee/ldap) is a password sign-in too: it gets a
            // session only through a directory that stays open while SSO is
            // enforced, which isDirectorySessionAllowedUnderSsoEnforcement
            // checks for the sign-in being made.
            //
            // Passkey sign-in (passkey-auth.ts) is not an identity-provider
            // sign-in either: while SSO is enforced only break-glass accounts
            // get a session from it.
            if (
              !await isSessionAllowedUnderSsoEnforcement(appDb, userId, context?.path) &&
              !await isDirectorySessionAllowedUnderSsoEnforcement(appDb, userId, context?.path) &&
              !(await isMfaSessionRotation(userId, requestContext))
            ) {
              await logAuditEvent({
                userId,
                action: "sso_enforced_sign_in_refused",
                entityType: "user",
                entityId: userId,
                summary: context?.path === LDAP_SIGN_IN_PATH
                  ? "Directory sign-in refused: SSO is enforced and the directory is not open while it is"
                  : context?.path === PASSKEY_SIGN_IN_PATH
                    ? "Passkey sign-in refused: SSO is enforced and the account is not a break-glass account"
                    : "Password sign-in refused: SSO is enforced and the account is not a break-glass account",
                data: { path: context?.path ?? null },
              });
              throw invalidCredentials(context?.path);
            }
          },
          after: async (session, context) => {
            try {
              const userId = typeof session.userId === "string" ? Number(session.userId) : session.userId;
              // Null when the session is not a completed sign-in: a password
              // sign-in that still needs its second factor, or MFA being
              // turned on or off.
              const requestContext = context as Parameters<typeof signInAuditSummary>[1];
              const summary = await signInAuditSummary(userId, requestContext);
              if (summary === null) {
                // Turning MFA on or off replaces the caller's session: the new
                // one keeps how the user signed in.
                if (await isMfaSessionRotation(userId, requestContext)) {
                  await markSessionSignInMethod(session, await requestSessionSignInMethod(requestContext));
                }
                await noteFirstSignInStep(userId, context);
                return;
              }
              const signIn = await completedSignIn(userId, context);
              // The forward-auth portal reuses only sessions an identity
              // provider created (portalMayReuseSession in auth.ts).
              await markSessionSignInMethod(session, signIn.method);
              // users.lastSignInAt / lastSignInMethod and sign_in_sources (Users page, Sign-in and directories, their APIs).
              await recordSignIn(userId, signIn);
              const { createAuditEvent } = await import("./models/audit");
              await createAuditEvent({
                userId,
                action: "login_success",
                entityType: "session",
                entityId: null,
                summary,
              });
            } catch {
              // Don't break auth flow if audit logging fails
            }
          },
        },
      },
    },
    plugins: [
      // Cast via unknown: better-auth's `username` plugin declares
      // databaseHooks.user.create.before's `email: string` (required) while BetterAuthPlugin
      // expects `email?: any`. The mismatch surfaces in some environments and not others, so
      // the cast keeps the typecheck stable across local and Docker builds.
      username({
        minUsernameLength: LOGIN_USERNAME_MIN_LENGTH,
        maxUsernameLength: LOGIN_USERNAME_MAX_LENGTH,
        usernameValidator: isValidLoginUsername,
      }) as unknown as BetterAuthPlugin,
      genericOAuth({ config: oauthConfigs }),
      // LDAP / Active Directory sign-in (ee/ldap): POST /sign-in/ldap, with
      // the same second-factor step as password sign-in.
      ldapSignInPlugin({ twoFactorPlugin }),
      // SAML 2.0 single sign-on (ee/saml): POST /sign-in/saml starts an
      // SP-initiated sign-in, POST /saml/acs/:providerId completes it. No
      // route manages providers; that is /api/v1/saml-providers.
      samlSignInPlugin(),
      // Multi-factor authentication for password and directory sign-in (TOTP
      // and backup codes); see mfa-auth.ts and documentation/mfa.md.
      twoFactorPlugin,
      // Passkeys (WebAuthn): sign-in and the second factor of password
      // sign-in; see passkey-auth.ts and documentation/mfa.md.
      createPasskeyPlugin(),
      passkeyGuardPlugin(),
    ],
  });

  return betterAuth({
    ...options,
    // The application database through its executor: Better Auth's queries
    // wait for, or join, the application's transactions. Its tables tell the
    // PostgreSQL connection which columns hold dates.
    database: getAuthDatabase(getAuthTables(options)),
  });
}

/**
 * The Better Auth instance, built with the providers in memory; rebuilt when
 * they change. Synchronous: it never waits for the database.
 */
export function getAuth(): ReturnType<typeof betterAuth> {
  const providers = providerCache.current();
  if (!cachedAuth || cachedAuthProviders !== providers) {
    cachedAuth = createAuth(providers);
    cachedAuthProviders = providers;
  }
  return cachedAuth;
}

/** After an OAuth provider changed: reads the providers again; the next getAuth() uses them. */
export async function reloadOAuthProviders(): Promise<void> {
  await providerCache.changed();
}
