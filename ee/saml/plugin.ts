// SPDX-License-Identifier: Elastic-2.0
/**
 * The Better Auth plugin for SAML 2.0 sign-in. Three endpoints under
 * /api/auth, and nothing else: no route registers, changes or lists
 * providers (that is /api/v1/saml-providers, administrators only).
 *
 *  - POST /sign-in/saml {providerId, callbackURL?}: starts an SP-initiated
 *    sign-in. Stores the AuthnRequest ID with the hash of a fresh binding
 *    secret, sets that secret as the __Host-saml_binding cookie (Secure,
 *    HttpOnly, SameSite=None, 10 minutes) and answers {url, redirect: true}
 *    with the identity provider's URL (HTTP-Redirect binding; the request is
 *    signed when the provider has an SP key).
 *  - POST /saml/acs/:providerId: the assertion consumer service. Needs the
 *    binding cookie of a sign-in started for this provider (requests.ts),
 *    verifies the response for exactly that sign-in (response.ts), records
 *    the assertion ID (replay), resolves or creates the account and applies
 *    the role (sign-in.ts), and only then creates the session through Better
 *    Auth's internal adapter, so every session hook runs: disabled accounts,
 *    enforced SSO (this path counts as single sign-on), audit. Answers with a
 *    redirect: to the page the sign-in started from, or to the login page
 *    with a generic error. The reason is only in the audit log.
 *  - GET /saml/metadata/:providerId: this service provider's metadata.
 *
 * Better Auth's origin check is skipped for the ACS path only
 * (src/lib/auth-server.ts): the identity provider posts it cross-site by
 * design, and the binding cookie, the request ID and the signature are what
 * protect it.
 *
 * Multi-factor authentication: as for OAuth/OIDC sign-in, the identity
 * provider is responsible for it. Better Auth's two-factor plugin only turns
 * password sign-ins into a challenge, so an account with TOTP enrolled gets
 * its session from a SAML sign-in without a local code.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import * as z from "zod";
import { appDb } from "@/src/lib/db";
import {
  BINDING_COOKIE_NAME,
  LIMITS,
  NAMEID_FORMAT_PERSISTENT,
  REQUEST_TTL_MS,
  SAML_ACS_PATH,
  SAML_ERROR_REDIRECT,
  SAML_METADATA_PATH,
  SAML_SIGN_IN_PATH,
} from "./constants";
import { buildServiceProviderMetadata } from "./metadata";
import { consumePendingRequest, createPendingRequest, newRequestId, recordAssertionUse } from "./requests";
import { SamlResponseError, verifySamlResponse } from "./response";
import { REFUSAL_DESCRIPTIONS, auditRefusedSignIn, completeSamlSignIn, readSamlUser, type AccountAdapter } from "./sign-in";
import {
  SamlProviderUnavailableError,
  baseUrl,
  baseUrlIsSecureContext,
  getEnabledProviderRow,
  getProviderRow,
  serviceProviderUrls,
  toProviderConfig,
} from "./store";
import type { SamlProviderConfig } from "./types";
import { parseRowId } from "@/src/lib/row-ids";

const startSchema = z.object({
  providerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  callbackURL: z.string().max(2048).optional(),
});

const BINDING_COOKIE_OPTIONS = { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "none" } as const;

/** A path on this dashboard to return to; anything else (absolute URLs, //host, backslashes) becomes "/". */
export function safeCallbackPath(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/";
  return value;
}

function parseProviderIdParam(raw: unknown): number | null {
  return typeof raw === "string" ? parseRowId(raw) : null;
}

/** The SAML instance that writes this provider's AuthnRequest with ID `requestId`. */
function requestWriter(config: SamlProviderConfig, requestId: string): SAML {
  const sp = serviceProviderUrls(config.id);
  return new SAML({
    entryPoint: config.idpSsoUrl,
    issuer: sp.entityId,
    callbackUrl: sp.acsUrl,
    idpCert: config.idpCertificates,
    // Ask for a persistent NameID unless an attribute holds the account id.
    identifierFormat: config.subjectAttribute ? null : NAMEID_FORMAT_PERSISTENT,
    // The IdP picks how the user authenticates (MFA included).
    disableRequestedAuthnContext: true,
    generateUniqueId: () => requestId,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    // The request is stored by createPendingRequest, with the browser binding.
    cacheProvider: { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null },
    ...(config.spPrivateKey ? { privateKey: config.spPrivateKey, signatureAlgorithm: "sha256" as const } : {}),
  });
}

/** Reads an application/x-www-form-urlencoded body of at most `maxBytes`, or null. */
export async function readFormBody(request: Request | undefined, maxBytes: number): Promise<URLSearchParams | null> {
  if (!request?.body) return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function samlSignInPlugin(): BetterAuthPlugin {
  return {
    id: "saml",
    endpoints: {
      signInSaml: createAuthEndpoint(
        SAML_SIGN_IN_PATH,
        { method: "POST", body: startSchema, use: [formCsrfMiddleware] },
        async (ctx) => {
          const row = await getEnabledProviderRow(ctx.body.providerId);
          if (!row) {
            throw new APIError("NOT_FOUND", { message: "Unknown SAML provider", code: "SAML_PROVIDER_NOT_FOUND" });
          }
          if (!baseUrlIsSecureContext()) {
            // Browsers drop the Secure binding cookie on plain http, so the sign-in could never complete.
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "SAML sign-in needs BASE_URL to use https",
              code: "SAML_NEEDS_HTTPS",
            });
          }
          let config: SamlProviderConfig;
          let url: string;
          const requestId = newRequestId();
          try {
            config = await toProviderConfig(row);
            url = await requestWriter(config, requestId).getAuthorizeUrlAsync("", undefined, {});
          } catch (error) {
            console.error(`[saml] Provider ${row.id}:`, error instanceof SamlProviderUnavailableError ? error.message : error);
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "The SAML provider is not available. Try again later.",
              code: "SAML_PROVIDER_UNAVAILABLE",
            });
          }
          const secret = await createPendingRequest(appDb, {
            providerId: config.id,
            requestId,
            callbackUrl: safeCallbackPath(ctx.body.callbackURL),
          });
          ctx.setCookie(BINDING_COOKIE_NAME, secret, { ...BINDING_COOKIE_OPTIONS, maxAge: Math.floor(REQUEST_TTL_MS / 1000) });
          return ctx.json({ url, redirect: true });
        }
      ),

      samlAcs: createAuthEndpoint(
        SAML_ACS_PATH,
        // The form body is read below, with a size limit.
        { method: "POST", disableBody: true, metadata: { allowedMediaTypes: ["application/x-www-form-urlencoded"] } },
        async (ctx) => {
          // One response per started sign-in, whatever happens: the cookie goes.
          ctx.setCookie(BINDING_COOKIE_NAME, "", { ...BINDING_COOKIE_OPTIONS, maxAge: 0 });
          const fail: () => never = () => {
            throw ctx.redirect(`${baseUrl()}${SAML_ERROR_REDIRECT}`);
          };

          const providerId = parseProviderIdParam(ctx.params?.providerId);
          const row = providerId === null ? null : await getProviderRow(providerId);
          if (!row) fail();
          const label = { id: row.id, name: row.name };

          const form = await readFormBody(ctx.request, LIMITS.acsBody);
          const posted = form?.get("SAMLResponse") ?? null;
          if (!posted) {
            await auditRefusedSignIn(label, "the request carries no SAMLResponse (or it is too large)", null, { failure: "malformed" });
            return fail();
          }

          // The sign-in this browser started; without the cookie (another
          // browser, or an IdP-initiated response) there is none.
          const pending = await consumePendingRequest(appDb, ctx.getCookie(BINDING_COOKIE_NAME, "host"));
          if (!pending || pending.providerId !== row.id) {
            await auditRefusedSignIn(
              label,
              pending
                ? "the browser started its sign-in with another provider"
                : "no sign-in was started in this browser (the binding cookie is missing, expired or already used)",
              null,
              { failure: "binding" }
            );
            return fail();
          }
          if (!row.enabled) {
            await auditRefusedSignIn(label, "the provider is disabled", null, { failure: "disabled" });
            return fail();
          }

          let config: SamlProviderConfig;
          try {
            config = await toProviderConfig(row);
          } catch (error) {
            console.error(`[saml] Provider ${row.id}:`, error instanceof Error ? error.message : error);
            return fail();
          }

          let identity;
          try {
            identity = await verifySamlResponse(posted, {
              provider: config,
              requestId: pending.requestId,
              requestCreatedAt: pending.createdAt,
            });
          } catch (error) {
            const reason = error instanceof SamlResponseError ? error.reason : "malformed";
            const message = error instanceof Error ? error.message : String(error);
            await auditRefusedSignIn(config, `the response was refused: ${message}`, null, { failure: reason });
            return fail();
          }

          if (!await recordAssertionUse(appDb, { providerId: config.id, assertionId: identity.assertionId, until: identity.replayUntil })) {
            await auditRefusedSignIn(config, "the assertion was used before (replay)", null, { failure: "replayed", assertionId: identity.assertionId });
            return fail();
          }

          const user = readSamlUser(config, identity);
          if (!user) {
            await auditRefusedSignIn(config, REFUSAL_DESCRIPTIONS.subject_unusable, null, {
              failure: "subject_unusable",
              nameIdFormat: identity.nameIdFormat,
            });
            return fail();
          }

          const internalAdapter = ctx.context.internalAdapter as unknown as AccountAdapter & {
            createSession(userId: string, dontRememberMe?: boolean): Promise<{ token: string } | null>;
            findUserById(userId: string): Promise<Record<string, unknown> | null>;
          };
          let completed: Awaited<ReturnType<typeof completeSamlSignIn>>;
          try {
            completed = await completeSamlSignIn(config, user, internalAdapter);
          } catch (error) {
            console.error(`[saml] Sign-in through provider ${config.id} failed:`, error instanceof Error ? error.message : error);
            await auditRefusedSignIn(config, "the account could not be resolved", null, { failure: "internal_error", subject: user.subject });
            return fail();
          }
          if (!completed.ok) {
            await auditRefusedSignIn(config, REFUSAL_DESCRIPTIONS[completed.reason], completed.userId, {
              failure: completed.reason,
              subject: user.subject,
              email: user.email,
            });
            return fail();
          }

          // The session hooks run inside: account status, enforced SSO, audit.
          let session: { token: string } | null;
          try {
            session = await internalAdapter.createSession(String(completed.userId), false);
          } catch (error) {
            await auditRefusedSignIn(config, "no session was created for the account", completed.userId, {
              failure: "session_refused",
              detail: error instanceof Error ? error.message : String(error),
            });
            return fail();
          }
          const signedIn = session ? await internalAdapter.findUserById(String(completed.userId)) : null;
          if (!session || !signedIn) return fail();
          await setSessionCookie(
            ctx,
            { session: session as Parameters<typeof setSessionCookie>[1]["session"], user: signedIn as Parameters<typeof setSessionCookie>[1]["user"] },
            false
          );
          throw ctx.redirect(`${baseUrl()}${pending.callbackUrl}`);
        }
      ),

      samlMetadata: createAuthEndpoint(SAML_METADATA_PATH, { method: "GET" }, async (ctx) => {
        const providerId = parseProviderIdParam(ctx.params?.providerId);
        const row = providerId === null ? null : await getProviderRow(providerId);
        if (!row) throw new APIError("NOT_FOUND", { message: "Unknown SAML provider", code: "SAML_PROVIDER_NOT_FOUND" });
        const xml = buildServiceProviderMetadata({
          id: row.id,
          spCertificate: row.spCertificate,
          signsRequests: Boolean(row.spPrivateKey && row.spCertificate),
          subjectAttribute: row.subjectAttribute,
        });
        return new Response(xml, {
          status: 200,
          headers: { "Content-Type": "application/samlmetadata+xml; charset=utf-8", "Cache-Control": "no-store" },
        });
      }),
    },
  } satisfies BetterAuthPlugin;
}
