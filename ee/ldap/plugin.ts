// SPDX-License-Identifier: Elastic-2.0
/**
 * The Better Auth plugin for directory sign-in: POST /api/auth/sign-in/ldap
 * with {directoryId, username, password, rememberMe?}.
 *
 * It is a Better Auth endpoint so the session is created the standard way:
 * Better Auth's per-client limit on /sign-in/* and its origin checks apply,
 * new accounts go through its user hooks (enforceSafeUserDefaults, sign-in
 * name rules), links through its account hooks (accounts.issuer), and the
 * session through its session hooks (disabled accounts, enforced SSO,
 * audit).
 *
 * Multi-factor authentication: Better Auth's two-factor plugin turns a
 * sign-in into a second-factor challenge in an after hook whose matcher
 * lists the password endpoints (/sign-in/email, /sign-in/username,
 * /sign-in/phone-number) only. This plugin registers that very handler for
 * its own path, so a user with MFA gets the same challenge, cookie and
 * limits after a directory sign-in. If a Better Auth release no longer has
 * that hook, a fallback refuses the sign-in of every user with MFA instead
 * of letting it through without a second factor.
 *
 * Every refusal after the request was admitted, whatever its cause (unknown
 * user, wrong password, several entries, not provisioned, not in the
 * required group, disabled account, enforced SSO), is the reply a wrong
 * password gets: 401 "Invalid username or password". Only a directory that
 * cannot be reached at all answers 503, and that never depends on the
 * username or the password.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, formCsrfMiddleware } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { appDb } from "@/src/lib/db";
import { getClientIp, UNKNOWN_CLIENT_IP } from "@/src/lib/client-ip";
import { isSsoEnforced } from "@/ee/sso/sign-in";
import { LDAP_SIGN_IN_PATH, LIMITS } from "./constants";
import { authenticateDirectoryUser } from "./authenticate";
import { getDirectoryRow, toDirectoryConfig } from "./store";
import { beginDirectoryAttempt, signInAccountKey } from "./limiter";
import { auditRefusedSignIn, completeDirectorySignIn, REFUSAL_DESCRIPTIONS, type AccountAdapter } from "./sign-in";
import { isDirectoryOpen, runDirectorySignIn } from "./sso";

export const INVALID_CREDENTIALS = {
  message: "Invalid username or password",
  code: "INVALID_USERNAME_OR_PASSWORD",
} as const;

function invalidCredentials(): APIError {
  return new APIError("UNAUTHORIZED", { ...INVALID_CREDENTIALS });
}

type AfterHook = NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["after"]>[number];

/**
 * Used when the two-factor plugin's sign-in hook cannot be found: a user with
 * MFA gets no session from a directory sign-in at all (fail closed).
 */
const refuseUsersWithMfa = createAuthMiddleware(async (ctx) => {
  const created = ctx.context.newSession as { session: { token: string }; user: { twoFactorEnabled?: unknown } } | null;
  if (!created || created.user.twoFactorEnabled !== true) return;
  deleteSessionCookie(ctx, true);
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  ctx.context.setNewSession(null);
  throw invalidCredentials();
});

/** The two-factor plugin's after hook for password sign-in, found by asking its matcher. */
export function findSecondFactorHook(twoFactorPlugin: BetterAuthPlugin): AfterHook["handler"] | null {
  for (const hook of twoFactorPlugin.hooks?.after ?? []) {
    try {
      const matches = (path: string) => hook.matcher({ path } as Parameters<AfterHook["matcher"]>[0]);
      if (matches("/sign-in/username") && matches("/sign-in/email") && !matches("/sign-in/social")) return hook.handler;
    } catch {
      // Not the hook we are looking for.
    }
  }
  return null;
}

const bodySchema = z.object({
  directoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  username: z.string().max(LIMITS.username),
  password: z.string().max(LIMITS.password),
  rememberMe: z.boolean().optional(),
});

export function ldapSignInPlugin(options: { twoFactorPlugin: BetterAuthPlugin }): BetterAuthPlugin {
  const secondFactor = findSecondFactorHook(options.twoFactorPlugin);
  if (!secondFactor) {
    console.error("[ldap] Better Auth's two-factor sign-in hook was not found; directory sign-in is refused for every account with MFA");
  }

  return {
    id: "ldap",
    endpoints: {
      signInLdap: createAuthEndpoint(
        LDAP_SIGN_IN_PATH,
        { method: "POST", body: bodySchema, use: [formCsrfMiddleware] },
        async (ctx) => {
          const { directoryId, username, password, rememberMe } = ctx.body;
          const headers = ctx.request?.headers ?? ctx.headers;
          const ip = headers ? getClientIp(headers) : UNKNOWN_CLIENT_IP;

          const attempt = await beginDirectoryAttempt(signInAccountKey(directoryId, username), ip);
          if (!attempt) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many login attempts. Try again in a few minutes.",
              code: "TOO_MANY_ATTEMPTS",
            });
          }
          try {
            const row = await getDirectoryRow(directoryId);
            // A directory that is off (or closed while SSO is enforced) is refused
            // before anything is sent to it, like a wrong password.
            if (!row || !isDirectoryOpen(row, await isSsoEnforced(appDb))) {
              await attempt.fail();
              throw invalidCredentials();
            }

            let config;
            try {
              config = toDirectoryConfig(row);
            } catch (error) {
              console.error(`[ldap] Directory ${row.id}:`, error instanceof Error ? error.message : error);
              await attempt.release();
              throw new APIError("SERVICE_UNAVAILABLE", { message: "The directory is not available. Try again later.", code: "DIRECTORY_UNAVAILABLE" });
            }

            const outcome = await authenticateDirectoryUser(config, username, password);
            if (!outcome.ok) {
              if (outcome.reason === "directory_unavailable") {
                console.warn(`[ldap] Directory "${config.name}" is not available: ${outcome.detail}`);
                await attempt.release();
                throw new APIError("SERVICE_UNAVAILABLE", { message: "The directory is not available. Try again later.", code: "DIRECTORY_UNAVAILABLE" });
              }
              // The password was right but the entry cannot be used: worth an administrator's attention.
              if (outcome.reason === "incomplete_entry" || outcome.reason === "groups_unavailable") {
                await auditRefusedSignIn(config, null, outcome.detail, null);
              }
              // An empty password reached nothing and guessed nothing; everything else counts.
              if (outcome.reason === "invalid_input") await attempt.release();
              else await attempt.fail();
              throw invalidCredentials();
            }

            const internalAdapter = ctx.context.internalAdapter as unknown as AccountAdapter & {
              createSession(userId: string, dontRememberMe?: boolean): Promise<{ token: string } | null>;
              findUserById(userId: string): Promise<Record<string, unknown> | null>;
            };
            const completed = await completeDirectorySignIn(config, outcome.user, internalAdapter);
            if (!completed.ok) {
              await auditRefusedSignIn(config, outcome.user, REFUSAL_DESCRIPTIONS[completed.reason], completed.userId);
              await attempt.fail();
              throw invalidCredentials();
            }

            // The session hooks run inside: account status, enforced SSO (which
            // admits this sign-in only through runDirectorySignIn), audit.
            let session: { token: string } | null;
            try {
              session = await runDirectorySignIn(
                { userId: completed.userId, directoryId: config.id },
                () => internalAdapter.createSession(String(completed.userId), rememberMe === false)
              );
            } catch (error) {
              await attempt.fail();
              throw error;
            }
            if (!session) {
              await attempt.release();
              throw new APIError("INTERNAL_SERVER_ERROR", { message: "Failed to create session", code: "FAILED_TO_CREATE_SESSION" });
            }
            const user = await internalAdapter.findUserById(String(completed.userId));
            if (!user) {
              await attempt.release();
              throw invalidCredentials();
            }
            await setSessionCookie(
              ctx,
              { session: session as Parameters<typeof setSessionCookie>[1]["session"], user: user as Parameters<typeof setSessionCookie>[1]["user"] },
              rememberMe === false
            );
            await attempt.succeed();
            return ctx.json({
              redirect: false,
              user: { id: String(user.id), email: user.email, name: user.name ?? null },
            });
          } finally {
            await attempt.release();
          }
        }
      ),
    },
    hooks: {
      after: [
        {
          matcher: (context) => context.path === LDAP_SIGN_IN_PATH,
          handler: secondFactor ?? refuseUsersWithMfa,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
