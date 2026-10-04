// SPDX-License-Identifier: Elastic-2.0
/**
 * SAML 2.0 single sign-on (feature "sso_saml"): names, paths and limits
 * shared by the sign-in path, Better Auth's hooks and the administration
 * code. Nothing here touches the database or the license, so src/lib and
 * client components can import it.
 */

export const SAML_FEATURE = "sso_saml" as const;

/** Better Auth endpoint (under /api/auth) that starts an SP-initiated sign-in. */
export const SAML_SIGN_IN_PATH = "/sign-in/saml";

/**
 * The assertion consumer service, as Better Auth's hooks see it (a route
 * template). Enforced SSO (ee/sso/sign-in.ts) counts sessions created here
 * as single sign-on.
 */
export const SAML_ACS_PATH = "/saml/acs/:providerId";

/** The ACS URL prefix: Better Auth's origin check is skipped below it (the IdP posts cross-site). */
export const SAML_ACS_PATH_PREFIX = "/saml/acs";

/** Public SP metadata of a provider. */
export const SAML_METADATA_PATH = "/saml/metadata/:providerId";

/**
 * Accounts signed in through SAML provider `id` are `accounts` rows with
 * this providerId. Like "ldap:<id>" (ee/ldap/constants.ts), the colon cannot
 * occur in an OAuth provider id (a UUID, or a slug of [a-z0-9-] for one
 * configured through the environment), and "saml:" is neither "credential"
 * nor "ldap:", so no two sign-in methods ever share a namespace.
 */
const PROVIDER_PREFIX = "saml:";

export function samlProviderId(id: number): string {
  return `${PROVIDER_PREFIX}${id}`;
}

export function isSamlProviderId(providerId: string | null | undefined): providerId is string {
  return typeof providerId === "string" && providerId.startsWith(PROVIDER_PREFIX);
}

/** The SAML provider id in an accounts.providerId, or null for any other provider. */
export function parseSamlProviderId(providerId: string | null | undefined): number | null {
  if (!isSamlProviderId(providerId)) return null;
  const rest = providerId.slice(PROVIDER_PREFIX.length);
  if (!/^[1-9]\d{0,9}$/.test(rest)) return null;
  const id = Number(rest);
  // Ids are 32-bit integers (MAX_ROW_ID in src/lib/row-ids.ts).
  return id <= 2_147_483_647 ? id : null;
}

/**
 * accounts.issuer of a SAML account: a synthetic namespace of its own,
 * distinct from "local:credential", "local:oauth:..." and "local:ldap:..."
 * (src/lib/account-issuer.ts).
 */
export function samlAccountIssuer(id: number): string {
  return `local:saml:${id}`;
}

/** The binding cookie (sent as __Host-saml_binding): ties an IdP's response to the browser that started the sign-in. */
export const BINDING_COOKIE_NAME = "saml_binding";

/** How long a started sign-in may take at the identity provider. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/** Clock skew accepted on every time check of a response. */
export const CLOCK_SKEW_MS = 60 * 1000;

/** Where a refused or failed sign-in is sent. The reason is only in the audit log. */
export const SAML_ERROR_REDIRECT = "/login?error=saml";

export const SAML_ROLES = ["admin", "user", "viewer"] as const;
export type SamlRole = (typeof SAML_ROLES)[number];

/** Roles a user in none of the mapped groups may get: never admin. */
export const SAML_DEFAULT_ROLES = ["user", "viewer"] as const;

export const NAMEID_FORMAT_PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

export const XML_NS = {
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
  dsig: "http://www.w3.org/2000/09/xmldsig#",
} as const;

export const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
export const CONFIRMATION_BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
export const BINDING_HTTP_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
export const BINDING_HTTP_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

/**
 * Signature algorithms accepted in a response: RSA with SHA-256 or SHA-512
 * (PKCS#1 v1.5 or PSS). SHA-1 (rsa-sha1), HMAC and everything else is
 * refused, whatever the identity provider chose, before any signature is
 * checked. xml-crypto (the verifier) has no ECDSA, so EC keys cannot be used.
 */
export const ALLOWED_SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1",
]);

/** Digest algorithms accepted in a response's signature references. */
export const ALLOWED_DIGEST_ALGORITHMS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
]);

/** Canonicalization and transform algorithms a SAML signature uses; anything else is refused. */
export const ALLOWED_TRANSFORMS: ReadonlySet<string> = new Set([
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
  "http://www.w3.org/2001/10/xml-exc-c14n#",
  "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
  "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  "http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments",
]);

export const LIMITS = {
  name: 100,
  entityId: 1024,
  url: 2048,
  /** Signing certificates per provider (rollover). */
  certificates: 5,
  certificate: 16 * 1024,
  privateKey: 16 * 1024,
  metadataXml: 512 * 1024,
  attribute: 256,
  group: 512,
  mappings: 100,
  /** The form body of the ACS (base64 SAMLResponse and RelayState). */
  acsBody: 512 * 1024,
  /** The decoded response XML. */
  responseXml: 384 * 1024,
  /** Values kept per attribute; more fails closed. */
  attributeValues: 1000,
  attributes: 200,
  value: 1024,
  email: 254,
  displayName: 256,
  /** accounts.accountId of a SAML account. */
  subject: 512,
  /** Started sign-ins kept at once; the oldest are dropped beyond it. */
  pendingRequests: 10_000,
} as const;
