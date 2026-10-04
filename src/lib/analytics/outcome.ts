/**
 * The outcome of a request: what Caddy did with it, one value per request,
 * stored in traffic_events.outcome by log-parser.ts. Every value but
 * "served" counts as mitigated.
 *
 * Derived from the access log line of the request and what the parser
 * correlates with it, in this order (the first rule that matches wins):
 *
 * 1. rate_limit: Caddy's rate limiter refused it. Status 429 and the access
 *    log line carries `rate_limit_zone`, which the server error route adds
 *    only to the limiter's own refusals (caddy-rate-limit.ts). An upstream's
 *    429 has no zone and stays "served".
 * 2. geo / access: caddy-blocker logged "request blocked" for the same
 *    client, method and URI right before the access log line
 *    (collectBlockedSignatures in log-parser.ts). It is "access" when the
 *    client address is listed in an address rule (block_ips / block_cidrs of
 *    the global or a host's geoblocking settings, address-rules.ts), and
 *    "geo" otherwise: a country, continent or AS number rule, or fail-closed
 *    blocking of an unknown client address.
 * 3. waf: the WAF interrupted the request. Coraza logs "WAF rule violation
 *    detected" (client, Host and URI) to waf-rules.log before Caddy writes
 *    the access log line (waf-correlation.ts). Detection-only matches are
 *    not interruptions and stay "served".
 * 4. access: Caddy's HTTP basic authentication (access lists) refused it:
 *    status 401 with `WWW-Authenticate: Basic realm="restricted"`, the realm
 *    Caddy's http_basic provider uses.
 * 5. auth: a forward-auth sign-in redirect (sign-in required, or the signed-in
 *    user was refused): a 3xx whose Location is the dashboard's portal with
 *    an `rd` parameter (built-in forward auth), Authentik's outpost start
 *    URL, oauth2-proxy's /oauth2/start or /oauth2/sign_in on the same host,
 *    or any URL whose `rd` parameter points back to the requested host (the
 *    convention Authelia and the others share).
 * 6. served: everything else, whatever the status.
 *
 * Rows written before the outcome column existed have an empty outcome; the
 * query layer treats them as rate_limit / geo / served from is_rate_limited
 * and is_blocked (OUTCOME_SQL in dimensions.ts).
 */

export const OUTCOMES = ['served', 'waf', 'geo', 'access', 'auth', 'rate_limit'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Outcomes that count as mitigated (everything but served). */
export const MITIGATED_OUTCOMES: readonly Outcome[] = OUTCOMES.filter((outcome) => outcome !== 'served');

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

/** The realm Caddy's http_basic provider answers with (access lists set none). */
const CADDY_BASIC_REALM = /^basic\s+realm="restricted"/i;

export type OutcomeInput = {
  status: number;
  /** The access log line's `rate_limit_zone` field, as logged. */
  rateLimitZone?: unknown;
  /** caddy-blocker blocked the request. */
  blockedByBlocker: boolean;
  /** The client address is listed in an address rule (only read when blockedByBlocker). */
  addressRule: boolean;
  /** The WAF interrupted the request. */
  wafBlocked: boolean;
  /** The access log line's `resp_headers`. */
  respHeaders?: unknown;
  /** The requested Host, as logged. */
  requestHost: string;
  /** The dashboard's forward-auth portal URL (BASE_URL + "/portal"), or null. */
  portalUrl: string | null;
};

/** First value of a response header, matching its name case-insensitively. */
export function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first : null;
  }
  return null;
}

/** The host name of a Host header value: lowercase, no port. */
function hostName(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  return value.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
}

/**
 * True when `location` (a redirect's Location header) sends the visitor to
 * a forward-auth sign-in (rule 5 of the module comment).
 */
export function isForwardAuthRedirect(location: string, requestHost: string, portalUrl: string | null): boolean {
  const host = hostName(requestHost);
  let url: URL;
  try {
    url = new URL(location, `https://${host || 'request.invalid'}`);
  } catch {
    return false;
  }
  if (portalUrl) {
    try {
      const portal = new URL(portalUrl);
      if (url.origin === portal.origin && url.pathname.replace(/\/$/, '') === portal.pathname.replace(/\/$/, '') && url.searchParams.has('rd')) {
        return true;
      }
    } catch {
      // A malformed BASE_URL only disables this rule.
    }
  }
  if (url.pathname.startsWith('/outpost.goauthentik.io/start')) return true;
  const sameHost = hostName(url.host) === host;
  if (sameHost && /^\/oauth2\/(start|sign_in)\b/.test(url.pathname)) return true;
  const rd = url.searchParams.get('rd');
  if (rd && host) {
    try {
      const back = new URL(rd);
      if ((back.protocol === 'https:' || back.protocol === 'http:') && hostName(back.host) === host) return true;
    } catch {
      // Not an absolute URL: not the forward-auth return convention.
    }
  }
  return false;
}

/** The outcome of one request (see the module comment for the rules). */
export function deriveOutcome(input: OutcomeInput): Outcome {
  if (input.status === 429 && typeof input.rateLimitZone === 'string' && input.rateLimitZone.length > 0) {
    return 'rate_limit';
  }
  if (input.blockedByBlocker) return input.addressRule ? 'access' : 'geo';
  if (input.wafBlocked) return 'waf';
  if (input.status === 401) {
    const challenge = headerValue(input.respHeaders, 'WWW-Authenticate');
    if (challenge && CADDY_BASIC_REALM.test(challenge.trim())) return 'access';
  }
  if (input.status >= 300 && input.status < 400) {
    const location = headerValue(input.respHeaders, 'Location');
    if (location && isForwardAuthRedirect(location, input.requestHost, input.portalUrl)) return 'auth';
  }
  return 'served';
}
