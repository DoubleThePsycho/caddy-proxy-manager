/**
 * Where Caddy reaches the dashboard: the forward-auth verify subrequest, the
 * sign-in callback of protected hosts and the API monetization gate
 * (src/lib/caddy.ts). With several web replicas on one PostgreSQL database
 * (ee/docs/high-availability.md, "PostgreSQL replicas") every replica serves
 * these routes, so Caddy can send them to all of them.
 *
 * DASHBOARD_UPSTREAMS lists the replicas, comma-separated: `host:port`
 * (`web:3000,web-2:3000`), IPv6 in brackets (`[2001:db8::10]:3000`), an
 * optional `http://` in front. Unset or empty, Caddy uses the single address
 * it always used (FORWARD_AUTH_INTERNAL_URL, else `web:3000` on a Docker
 * network, else the host of BASE_URL).
 *
 * With one address the generated handlers are exactly as before. With two or
 * more, each handler also gets health checks and retries:
 * - active: GET /api/health on every replica when Caddy loads the
 *   configuration and every 10 seconds after; a replica that does not answer
 *   200 within 5 seconds (one that is down, or not admitted) gets
 *   nothing until it does;
 * - passive: three failed requests within 10 seconds (no connection, a
 *   broken response) take a replica out for those 10 seconds, for every
 *   handler at once (Caddy keeps that count per address);
 * - retries: for up to 5 seconds, every 250 ms, on another replica. A request
 *   that could not reach a replica is always retried. One that reached it
 *   and got no answer is retried for the verify and callback routes (verify
 *   only reads; a sign-in code is redeemed at most once, so a repeated
 *   callback is refused rather than counted twice), never for the gate, which
 *   charges the consumer when it answers.
 *
 * Every replica must have the same value: any replica may apply the Caddy
 * configuration.
 */
import { isIP } from "node:net";
import { formatDialAddress, parseHostPort } from "./caddy-utils";

export const DASHBOARD_UPSTREAMS_ENV = "DASHBOARD_UPSTREAMS";

/** The dashboard's health check: 200 on every replica that may serve (app/api/health/route.ts). */
export const DASHBOARD_HEALTH_URI = "/api/health";

/** Health checks of the dashboard handlers when there are several replicas (Caddy's JSON). */
export const DASHBOARD_HEALTH_CHECKS = {
  active: {
    uri: DASHBOARD_HEALTH_URI,
    interval: "10s",
    timeout: "5s",
    expect_status: 200,
  },
  passive: {
    fail_duration: "10s",
    max_fails: 3,
  },
} as const;

/** How long and how often a request is tried on another replica. */
export const DASHBOARD_TRY_DURATION = "5s";
export const DASHBOARD_TRY_INTERVAL = "250ms";

/**
 * A retry_match that never matches: Caddy then retries only requests that
 * never reached a replica (no connection, no healthy replica), never one a
 * replica may have acted on.
 */
const NO_RETRY_AFTER_SEND = [{ expression: "false" }];

const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_-]{1,63})*\.?$/;

export type ParsedDashboardUpstreams = {
  /** Dial addresses (host:port), in order, without duplicates. */
  upstreams: string[];
  /** 1-based positions of the entries that are not an address; their text is never repeated (it may hold anything). */
  invalidPositions: number[];
};

/** One entry as a dial address, or null. */
function parseEntry(entry: string): string | null {
  let value = entry.trim();
  if (/^http:\/\//i.test(value)) value = value.slice("http://".length);
  if (value.endsWith("/")) value = value.slice(0, -1);
  // Another scheme, a path, credentials, placeholders, spaces: not an address.
  if (!value || /[/@{}\s]/.test(value)) return null;
  const parsed = parseHostPort(value);
  if (!parsed) return null;
  const { host, port } = parsed;
  if (!/^\d{1,5}$/.test(port)) return null;
  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65535) return null;
  const bracketed = value.startsWith("[");
  if (bracketed ? isIP(host) !== 6 : !HOST_NAME.test(host)) return null;
  return formatDialAddress(host, String(portNumber));
}

export function parseDashboardUpstreams(value: string | null | undefined): ParsedDashboardUpstreams {
  const upstreams: string[] = [];
  const invalidPositions: number[] = [];
  if (!value || !value.trim()) return { upstreams, invalidPositions };
  value.split(",").forEach((entry, index) => {
    if (!entry.trim()) return;
    const dial = parseEntry(entry);
    if (dial === null) invalidPositions.push(index + 1);
    else if (!upstreams.includes(dial)) upstreams.push(dial);
  });
  return { upstreams, invalidPositions };
}

function invalidMessage(positions: number[]): string {
  const which = positions.length === 1 ? `entry ${positions[0]} is` : `entries ${positions.join(", ")} are`;
  return (
    `${DASHBOARD_UPSTREAMS_ENV}: ${which} not an address. ` +
    "List the dashboard replicas as host:port, separated by commas (for example web:3000,web-2:3000)."
  );
}

/** DASHBOARD_UPSTREAMS is not a list of addresses; the message names the entries by position only. */
export class DashboardUpstreamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardUpstreamsError";
  }
}

/** Start-up check (validateProductionConfig): throws when an entry is not an address. */
export function assertValidDashboardUpstreams(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const { invalidPositions } = parseDashboardUpstreams(env[DASHBOARD_UPSTREAMS_ENV]);
  if (invalidPositions.length > 0) throw new DashboardUpstreamsError(invalidMessage(invalidPositions));
}

const warned = new Set<string>();

/**
 * The configured replicas (empty when DASHBOARD_UPSTREAMS is unset). Entries
 * that are not addresses are left out with a warning; in production the
 * container does not start with them (assertValidDashboardUpstreams).
 */
export function configuredDashboardUpstreams(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const value = env[DASHBOARD_UPSTREAMS_ENV];
  const { upstreams, invalidPositions } = parseDashboardUpstreams(value);
  if (invalidPositions.length > 0 && value !== undefined && !warned.has(value)) {
    warned.add(value);
    console.warn(`[caddy] ${invalidMessage(invalidPositions)} They are left out.`);
  }
  return upstreams;
}

/**
 * The fields of a reverse_proxy handler that sends a subrequest to the
 * dashboard: its upstreams and, with several, the health checks and retries
 * above. `retryAfterSend: false` for routes that change state when they
 * answer (the gate).
 */
export function dashboardProxyFields(upstreams: readonly string[], options: { retryAfterSend: boolean }): Record<string, unknown> {
  const fields: Record<string, unknown> = { upstreams: upstreams.map((dial) => ({ dial })) };
  if (upstreams.length < 2) return fields;
  fields.health_checks = {
    active: { ...DASHBOARD_HEALTH_CHECKS.active },
    passive: { ...DASHBOARD_HEALTH_CHECKS.passive },
  };
  fields.load_balancing = {
    try_duration: DASHBOARD_TRY_DURATION,
    try_interval: DASHBOARD_TRY_INTERVAL,
    ...(options.retryAfterSend ? {} : { retry_match: NO_RETRY_AFTER_SEND.map((matcher) => ({ ...matcher })) }),
  };
  return fields;
}
