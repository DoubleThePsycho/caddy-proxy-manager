/**
 * Rate limiting rules: the shapes, limits and syntax checks
 * shared by the dashboard forms and the server. Free of Node imports so
 * client components can use it; the server-side validation, inheritance and
 * Caddy handlers live in caddy-rate-limit.ts.
 *
 * A rule counts the requests of one key (a client IP, a request header value
 * or the signed-in forward-auth user) that match its path and methods, and
 * answers 429 with Retry-After once `events` requests fell inside the
 * sliding `window`.
 */

/** What a rule counts requests by. */
export const RATE_LIMIT_KEYS = ["client_ip", "header", "forward_auth_user"] as const;
export type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number];

export const RATE_LIMIT_KEY_LABELS: Record<RateLimitKey, string> = {
  client_ip: "Client IP",
  header: "Request header",
  forward_auth_user: "Signed-in user",
};

/** Methods a rule can be limited to; none means every method. */
export const RATE_LIMIT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"] as const;
export type RateLimitMethod = (typeof RATE_LIMIT_METHODS)[number];

/** How a host's own rules combine with the global defaults. */
export const RATE_LIMIT_MODES = ["merge", "override"] as const;
export type RateLimitMode = (typeof RATE_LIMIT_MODES)[number];

export type RateLimitRule = {
  /** Caddy path pattern, e.g. "/login", "/api/*"; "*" matches every path. */
  path: string;
  /** Upper-case HTTP methods; empty matches every method. */
  methods: string[];
  key: RateLimitKey;
  /** Request header whose value is the key; only with key "header". */
  header?: string;
  /** Requests allowed per window. */
  events: number;
  /** Sliding window: a whole number of seconds, minutes or hours, e.g. "30s", "1m", "1h". */
  window: string;
};

/**
 * A proxy host's rate limiting (ProxyHost.rateLimit, stored as
 * meta.rate_limit). Disabled or absent: the host inherits the global
 * defaults. Merge: the defaults and the host's rules both apply. Override:
 * only the host's rules apply, so override with no rules turns rate limiting
 * off for the host.
 */
export type ProxyHostRateLimit = {
  enabled: boolean;
  mode: RateLimitMode;
  rules: RateLimitRule[];
};

/** Global defaults (settings key "rate_limit", REST group "rate-limit"). */
export type RateLimitSettings = {
  /** Whether the default rules apply to hosts that inherit or merge them. */
  enabled: boolean;
  rules: RateLimitRule[];
  /**
   * Client IPs and CIDR ranges ("private_ranges" for the private networks)
   * that no rule ever limits, the defaults or a host's own. Applies whether
   * or not the defaults are enabled.
   */
  allowlist: string[];
  /**
   * Prefix length client-IP keys of IPv6 clients are grouped by (64 by
   * default: one subscriber usually holds a whole /64). 128 counts every
   * address on its own.
   */
  ipv6Prefix?: number;
};

export const RATE_LIMIT_LIMITS = {
  /** Rules per host, and global default rules. */
  maxRules: 20,
  maxEvents: 1000,
  minWindowSeconds: 1,
  maxWindowSeconds: 3600,
  maxPathLength: 256,
  maxHeaderLength: 128,
  maxAllowlist: 256,
  minIpv6Prefix: 32,
  maxIpv6Prefix: 128,
  defaultIpv6Prefix: 64,
} as const;

/** Memory Caddy keeps per tracked key and rule: one 24-byte timestamp per allowed event. */
export const RATE_LIMIT_BYTES_PER_EVENT = 24;

const WINDOW_RE = /^([1-9][0-9]{0,3})(s|m|h)$/;
const WINDOW_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };

/** Seconds in a window such as "30s", "5m" or "1h"; null when malformed or out of range. */
export function rateLimitWindowSeconds(window: string): number | null {
  const match = WINDOW_RE.exec(window);
  if (!match) return null;
  const seconds = Number(match[1]) * WINDOW_UNIT_SECONDS[match[2]];
  return seconds >= RATE_LIMIT_LIMITS.minWindowSeconds && seconds <= RATE_LIMIT_LIMITS.maxWindowSeconds
    ? seconds
    : null;
}

/**
 * A Caddy path matcher pattern: "*" for every path, or a pattern starting
 * with "/" or "*" (a suffix match such as "*.php") made of RFC 3986 path
 * characters, "*" wildcards and %XX escapes. Braces (Caddy placeholders),
 * brackets, backslashes, spaces and control characters are refused, so a
 * client-controlled value can never be substituted into the matcher.
 */
const PATH_RE = /^[/*](?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/;

export function isValidRateLimitPath(path: string): boolean {
  if (path === "*") return true;
  return path.length <= RATE_LIMIT_LIMITS.maxPathLength && PATH_RE.test(path);
}

/** RFC 7230 token: the header name ends up in a Caddy placeholder and matcher key. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidRateLimitHeader(name: string): boolean {
  return name.length <= RATE_LIMIT_LIMITS.maxHeaderLength && HEADER_NAME_RE.test(name);
}

/** A new rule as the forms start it: 100 requests per minute per client IP, every path. */
export function defaultRateLimitRule(): RateLimitRule {
  return { path: "*", methods: [], key: "client_ip", events: 100, window: "1m" };
}

/** Short human description, e.g. "100 per 1m per client IP on /api/* (POST)". */
export function describeRateLimitRule(rule: RateLimitRule): string {
  const key = rule.key === "header" ? `${rule.header ?? "header"} header` : RATE_LIMIT_KEY_LABELS[rule.key].toLowerCase();
  const where = rule.path === "*" ? "every path" : rule.path;
  const methods = rule.methods.length > 0 ? ` (${rule.methods.join(", ")})` : "";
  return `${rule.events} per ${rule.window} per ${key} on ${where}${methods}`;
}
