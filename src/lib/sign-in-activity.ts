/**
 * The last completed dashboard sign-in of each account (users.lastSignInAt
 * and users.lastSignInMethod) and of each identity provider (sign_in_sources),
 * written from Better Auth's session hook in auth-server.ts whenever a
 * sign-in completes, whatever the method. An account that has never signed
 * in is "invited": it exists because an administrator created it or SCIM
 * provisioned it.
 */
import { eq } from "drizzle-orm";
import { appDb } from "./db";
import { signInSources, users } from "./db/schema";
import { recoverable } from "./db/ops";
import { defineRuntimeEntries } from "./shared-runtime-state";
import { LDAP_SIGN_IN_PATH, ldapProviderId } from "@/ee/ldap/constants";
import { SAML_ACS_PATH, samlProviderId } from "@/ee/saml/constants";

export const SIGN_IN_METHODS = ["password", "sso", "saml", "ldap", "passkey"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/** The sign-in steps that complete a password sign-in with a second factor (mfa-auth.ts). */
const SECOND_STEP_PATHS: ReadonlySet<string> = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

/** The method of a sign-in that completed on Better Auth endpoint `path`. */
export function signInMethodForPath(path: string | undefined): SignInMethod | null {
  switch (path) {
    case "/sign-in/username":
    case "/sign-in/email":
    case "/sign-up/email":
      return "password";
    case LDAP_SIGN_IN_PATH:
      return "ldap";
    case SAML_ACS_PATH:
      return "saml";
    case "/callback/:id":
    case "/sign-in/social":
      return "sso";
    case "/passkey/verify-authentication":
      return "passkey";
    default:
      return null;
  }
}

/** What the session hook knows of the request that completed (or started) a sign-in. */
export type SignInContext = { path?: string; params?: unknown; body?: unknown } | null | undefined;

/** How a sign-in was made, and through which identity provider (as accounts.providerId; null for password and passkey). */
export type CompletedSignIn = { method: SignInMethod | null; providerId: string | null };

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const POSITIVE_ID = /^[1-9]\d{0,14}$/;

/**
 * The identity provider a sign-in made with `method` went through: the OIDC
 * provider in the callback route (or the id-token sign-in's body), the SAML
 * provider in the ACS route, the directory in the LDAP sign-in's body.
 */
export function signInProviderFor(method: SignInMethod | null, context: SignInContext): string | null {
  switch (method) {
    case "sso": {
      const id = context?.path === "/sign-in/social" ? field(context.body, "provider") : field(context?.params, "id");
      // OIDC ids are UUIDs or [a-z0-9-] slugs: never "saml:…" or "ldap:…".
      return typeof id === "string" && id.length > 0 && id.length <= 200 && !id.includes(":") ? id : null;
    }
    case "saml": {
      const id = field(context?.params, "providerId");
      return typeof id === "string" && POSITIVE_ID.test(id) ? samlProviderId(Number(id)) : null;
    }
    case "ldap": {
      const id = field(context?.body, "directoryId");
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? ldapProviderId(id) : null;
    }
    default:
      return null;
  }
}

function isCompletedSignIn(value: unknown): value is CompletedSignIn {
  if (value === null || typeof value !== "object") return false;
  const { method, providerId } = value as Record<string, unknown>;
  return (method === null || (SIGN_IN_METHODS as readonly unknown[]).includes(method)) &&
    (providerId === null || (typeof providerId === "string" && providerId.length <= 200));
}

/**
 * Account -> how its pending sign-in started, until the second factor
 * completes it. The second factor may reach another replica than the first
 * step did: on PostgreSQL this lives in the shared runtime state
 * (src/lib/shared-runtime-state.ts), in memory on SQLite.
 */
const firstSteps = defineRuntimeEntries<CompletedSignIn>("sign-in-first-step", { maxEntries: 1_000, isValue: isCompletedSignIn });

/** Longer than a second-factor challenge lives (Better Auth's two-factor cookie). */
const FIRST_STEP_TTL_MS = 30 * 60_000;

/** Remembers how a sign-in that now waits for its second factor started (password or directory, and which directory). Never throws. */
export async function noteFirstSignInStep(userId: number, context: SignInContext): Promise<void> {
  const method = signInMethodForPath(context?.path);
  if (method !== "password" && method !== "ldap") return;
  try {
    await firstSteps.put(String(userId), { method, providerId: signInProviderFor(method, context) }, FIRST_STEP_TTL_MS);
  } catch (error) {
    console.warn("[sign-in] Failed to note the first sign-in step:", error instanceof Error ? error.name : typeof error);
  }
}

/** How a sign-in that just completed on `context` was made: a second factor completes the step noted before it. */
export async function completedSignIn(userId: number, context: SignInContext): Promise<CompletedSignIn> {
  const path = context?.path;
  if (path !== undefined && SECOND_STEP_PATHS.has(path)) {
    let noted: CompletedSignIn | null = null;
    try {
      noted = await firstSteps.take(String(userId));
    } catch (error) {
      console.warn("[sign-in] Failed to read the first sign-in step:", error instanceof Error ? error.name : typeof error);
    }
    return noted ?? { method: "password", providerId: null };
  }
  const method = signInMethodForPath(path);
  return { method, providerId: signInProviderFor(method, context) };
}

/** Records a completed sign-in on the account and, for an identity provider, on the provider. Bookkeeping only: never throws. */
export async function recordSignIn(userId: number, signIn: CompletedSignIn, at: string = new Date().toISOString()): Promise<void> {
  try {
    // In a savepoint when the sign-in runs in a transaction: a failure here does not end it.
    await recoverable(async () => {
      await appDb.update(users)
        .set({ lastSignInAt: at, lastSignInMethod: signIn.method })
        .where(eq(users.id, userId));
      if (signIn.providerId) {
        await appDb.insert(signInSources)
          .values({ providerId: signIn.providerId, lastSignInAt: at, lastUserId: userId })
          .onConflictDoUpdate({ target: signInSources.providerId, set: { lastSignInAt: at, lastUserId: userId } });
      }
    });
  } catch (error) {
    console.warn("[sign-in] Failed to record the last sign-in:", error instanceof Error ? error.name : typeof error);
  }
}

/** The newest sign-in through each identity provider that has had one, by accounts.providerId. */
export async function signInSourceActivity(): Promise<Map<string, { at: string; userId: number | null }>> {
  return new Map((await appDb.select().from(signInSources)).map((row) => [row.providerId, { at: row.lastSignInAt, userId: row.lastUserId }]));
}

/**
 * Whether an account is "invited": active, never signed in to the dashboard,
 * and none of its API tokens has been used (an account used only through
 * tokens is in use).
 */
export function isInvited(user: { status: string; lastSignInAt: string | null }, usedApiToken: boolean): boolean {
  return user.status === "active" && !user.lastSignInAt && !usedApiToken;
}
