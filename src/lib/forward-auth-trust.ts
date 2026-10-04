import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { resolveForwardAuthAudience, type ForwardAuthAudience } from "./models/forward-auth";

/**
 * Internal proof header injected by generated Caddy routes before they proxy a
 * forward-auth callback/verification request to the dashboard.  Forwarded
 * host/protocol headers alone are not trustworthy because the Next.js origin
 * may be reachable directly and clients can forge them there.
 */
export const FORWARD_AUTH_PROXY_PROOF_HEADER = "X-Ingressi-Forward-Auth-Proof";

/**
 * Proxy-host ID of the Caddy route that issued the subrequest.  Caddy chose the
 * route from the raw Host header, so the dashboard must authorize against that
 * same proxy host rather than re-deriving it from a hostname it parsed itself.
 */
export const FORWARD_AUTH_PROXY_HOST_ID_HEADER = "X-Ingressi-Proxy-Host-Id";

/**
 * The names the two headers above had before the rename.  Caddy keeps sending
 * them until the dashboard has re-applied its configuration after an upgrade,
 * so they are still read when the current name is absent.
 */
export const LEGACY_FORWARD_AUTH_PROXY_PROOF_HEADER = "X-CPM-Forward-Auth-Proof";
export const LEGACY_FORWARD_AUTH_PROXY_HOST_ID_HEADER = "X-CPM-Proxy-Host-Id";

/**
 * Set by the verify endpoint on 401/403 responses: the portal's `rd` value for
 * the request being verified, already encoded for a query string.  The
 * generated Caddy route places it into the portal redirect it issues.
 */
export const FORWARD_AUTH_PORTAL_TARGET_HEADER = "X-Ingressi-Portal-Target";

/**
 * Identity headers the verify endpoint returns and Caddy copies onto the
 * request to the upstream.  The user header carries the sign-in username, or
 * the email address for an account without one.
 */
export const FORWARD_AUTH_IDENTITY_HEADERS = {
  user: "X-Ingressi-User",
  email: "X-Ingressi-Email",
  groups: "X-Ingressi-Groups",
  userId: "X-Ingressi-User-Id",
} as const;

/**
 * The identity headers' names before the rename.  Upstreams configured for
 * them keep receiving them, and they are stripped from clients like the
 * current names.  Deprecated: to be dropped in a future major release.
 */
export const LEGACY_FORWARD_AUTH_IDENTITY_HEADERS = {
  user: "X-CPM-User",
  email: "X-CPM-Email",
  groups: "X-CPM-Groups",
  userId: "X-CPM-User-Id",
} as const;

/** Every identity header Caddy copies from the verify response, current and legacy. */
export const FORWARD_AUTH_COPY_HEADERS: readonly string[] = [
  ...Object.values(FORWARD_AUTH_IDENTITY_HEADERS),
  ...Object.values(LEGACY_FORWARD_AUTH_IDENTITY_HEADERS),
];

/** Session cookie set on protected domains by the callback. */
export const FORWARD_AUTH_COOKIE_NAME = "_ingressi_fa";

/** The cookie's name before the rename, still accepted so sessions survive the upgrade. */
export const LEGACY_FORWARD_AUTH_COOKIE_NAME = "_cpm_fa";

/** Path on protected domains that Caddy routes to the callback endpoint. */
export const FORWARD_AUTH_CALLBACK_PATH = "/.ingressi-auth/callback";

/** The callback path before the rename, still routed for sign-ins started before an upgrade. */
export const LEGACY_FORWARD_AUTH_CALLBACK_PATH = "/.cpm-auth/callback";

/**
 * Host header syntax accepted from Caddy: LDH labels (optionally with a
 * trailing dot) or a bracketed IPv6 literal, plus an optional port.  Anything
 * else — percent-encoding, non-ASCII, IPv4 shorthands — could be normalized by
 * the URL parser into a different hostname than the one Caddy matched.
 */
const FORWARDED_HOST_RE =
  /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * Derivation label of the proof value.  It predates the rename and stays as
 * it is: changing it would change the proof every running Caddy config holds.
 */
const PROOF_CONTEXT = "cpm-forward-auth-proxy-proof:v1";

/**
 * Derive a purpose-specific key instead of placing SESSION_SECRET itself in the
 * generated Caddy configuration.  Administrators who can read Caddy's config
 * are already trusted with the forward-auth control plane.
 */
export function getForwardAuthProxyProof(): string {
  return createHmac("sha256", config.sessionSecret)
    .update(PROOF_CONTEXT)
    .digest("hex");
}

/**
 * The proof and proxy-host ID headers of one naming generation: the current
 * names when the proof is sent under its current name, otherwise the legacy
 * names, so a client can never pair Caddy's proof with an ID it added itself
 * under the other name.
 */
function proxySubrequestHeaders(headers: Headers): { proof: string | null; proxyHostId: string | null } {
  const proof = headers.get(FORWARD_AUTH_PROXY_PROOF_HEADER);
  if (proof !== null) {
    return { proof, proxyHostId: headers.get(FORWARD_AUTH_PROXY_HOST_ID_HEADER) };
  }
  return {
    proof: headers.get(LEGACY_FORWARD_AUTH_PROXY_PROOF_HEADER),
    proxyHostId: headers.get(LEGACY_FORWARD_AUTH_PROXY_HOST_ID_HEADER),
  };
}

function hasValidProxyProof(headers: Headers): boolean {
  const supplied = proxySubrequestHeaders(headers).proof;
  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied)) return false;

  const expected = Buffer.from(getForwardAuthProxyProof(), "hex");
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Return the exact, normalized external origin vouched for by Caddy.  Scheme,
 * hostname, and non-default port are all part of URL.origin.  No Host fallback
 * is allowed: a direct request must never be able to manufacture an audience.
 */
export function getTrustedForwardAuthOrigin(headers: Headers): string | null {
  if (!hasValidProxyProof(headers)) return null;

  const forwardedProto = headers.get("x-forwarded-proto")?.trim().toLowerCase();
  const forwardedHost = headers.get("x-forwarded-host")?.trim();
  if (
    (forwardedProto !== "http" && forwardedProto !== "https") ||
    !forwardedHost ||
    !FORWARDED_HOST_RE.test(forwardedHost)
  ) {
    return null;
  }

  try {
    const parsed = new URL(`${forwardedProto}://${forwardedHost}`);
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    // The parsed hostname must be exactly what Caddy saw (case aside).
    const rawHostname = forwardedHost.startsWith("[")
      ? forwardedHost.slice(0, forwardedHost.indexOf("]") + 1)
      : forwardedHost.replace(/:\d+$/, "");
    if (parsed.hostname !== rawHostname.toLowerCase()) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Encode a value for a query string.  Everything encodeURIComponent escapes
 * stays escaped except "/", ":", "?" and "=", which are unambiguous inside a
 * query value and keep the portal URL readable.  "&", "#", "+" and "%" are
 * always escaped, so the value decodes back to exactly the input.
 */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%(?:2F|3A|3F|3D)/g, (escaped) =>
    decodeURIComponent(escaped)
  );
}

/**
 * The portal `rd` value (query-encoded) for the request Caddy is verifying:
 * the proof-checked forwarded origin plus X-Forwarded-Uri.  Null when the
 * request is not a well-formed Caddy subrequest; Caddy then falls back to a
 * target it escapes itself.
 */
export function getForwardAuthPortalTarget(headers: Headers): string | null {
  const origin = getTrustedForwardAuthOrigin(headers);
  if (!origin) return null;
  // Caddy sends the origin-form request URI, which is printable ASCII.
  const uri = headers.get("x-forwarded-uri") ?? "";
  if (!/^\/[\x21-\x7e]*$/.test(uri)) return null;
  return encodeQueryValue(`${origin}${uri}`);
}

/** The proxy-host ID pinned by the generated Caddy route, or null. */
export function getTrustedForwardAuthProxyHostId(headers: Headers): number | null {
  if (!hasValidProxyProof(headers)) return null;
  const raw = proxySubrequestHeaders(headers).proxyHostId?.trim() ?? "";
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Resolve the forward-auth audience for a Caddy subrequest.  Requires a valid
 * proxy proof, a well-formed forwarded origin, and that the origin resolves to
 * the same proxy host Caddy routed the request through.
 */
export async function resolveTrustedForwardAuthAudience(
  headers: Headers
): Promise<ForwardAuthAudience | null> {
  const origin = getTrustedForwardAuthOrigin(headers);
  const pinnedProxyHostId = getTrustedForwardAuthProxyHostId(headers);
  if (!origin || pinnedProxyHostId === null) return null;
  const audience = await resolveForwardAuthAudience(origin);
  if (!audience || audience.proxyHostId !== pinnedProxyHostId) return null;
  return audience;
}
