/**
 * The health of a proxy host's upstreams as Caddy sees it, for the host's
 * page and GET /api/v1/proxy-hosts/{id}/health.
 *
 * Read from Caddy's admin API (GET /reverse_proxy/upstreams, through the
 * client in caddy-upstreams.ts, which the "upstream failing" alert in
 * ee/alerting also uses). Caddy reports, per dial address, the requests in flight and the
 * failures its *passive* health checks counted within their fail duration.
 * It does not report the result of active health checks, and it counts no
 * failures for hosts without a passive fail duration, so an upstream of such
 * a host is "unchecked", never "up". Caddy keeps one entry per address for
 * every host dialling it, so the counts are shared by hosts with the same
 * upstream.
 */
import { parseUpstreamTarget } from "./caddy-utils";
import { fetchCaddyUpstreams, type CaddyUpstream } from "./caddy-upstreams";
import type { LoadBalancerConfig } from "./models/proxy-hosts";

export const UPSTREAM_STATUSES = ["up", "degraded", "down", "unchecked", "unknown", "disabled"] as const;
export type UpstreamStatus = (typeof UPSTREAM_STATUSES)[number];

export type UpstreamHealth = {
  /** As configured on the host, e.g. "http://app:3000". */
  upstream: string;
  /** The address Caddy dials ("app:3000"). */
  dial: string;
  /** Caddy talks TLS to it. */
  tls: boolean;
  /**
   * up: passive checks count failures and found none. degraded: some recent
   * failures. down: as many failures as the host allows, so Caddy stops
   * sending it requests. unchecked: no passive checks count failures for it.
   * unknown: Caddy did not answer or does not report the address. disabled:
   * the host is disabled.
   */
  status: UpstreamStatus;
  /** Caddy reported the address. */
  reported: boolean;
  /** Failures counted within the fail duration; null when not reported. */
  fails: number | null;
  /** Requests in flight; null when not reported. */
  requestsInFlight: number | null;
};

export type HealthCheckSettings = {
  /** Active checks: Caddy requests a path on each upstream on an interval. */
  active: { path: string | null; port: number | null; interval: string | null; timeout: string | null; expectStatus: number | null } | null;
  /**
   * Passive checks: Caddy counts failed requests. `counting` is false when no
   * fail duration is set, which leaves Caddy counting nothing.
   */
  passive: {
    failDuration: string | null;
    maxFails: number | null;
    unhealthyStatus: number[] | null;
    unhealthyLatency: string | null;
    counting: boolean;
  } | null;
  /** Load balancing across several upstreams; null when it is off. */
  loadBalancing: { policy: string; retries: number | null; tryDuration: string | null } | null;
};

export type ProxyHostHealth = {
  proxyHostId: number;
  checkedAt: string;
  /** Whether Caddy's admin API answered. */
  caddyReachable: boolean;
  /** The host as a whole: down when every upstream is down, degraded when one is, and so on. */
  status: UpstreamStatus;
  healthChecks: HealthCheckSettings;
  upstreams: UpstreamHealth[];
};

type HealthHost = { id: number; enabled: boolean; upstreams: readonly string[]; loadBalancer: LoadBalancerConfig | null };

/** Caddy's default for passive max_fails. */
const DEFAULT_MAX_FAILS = 1;
const DEFAULT_TIMEOUT_MS = 2500;

export function healthCheckSettings(loadBalancer: LoadBalancerConfig | null): HealthCheckSettings {
  if (!loadBalancer?.enabled) return { active: null, passive: null, loadBalancing: null };
  const active = loadBalancer.activeHealthCheck?.enabled ? loadBalancer.activeHealthCheck : null;
  const passive = loadBalancer.passiveHealthCheck?.enabled ? loadBalancer.passiveHealthCheck : null;
  return {
    active: active
      ? { path: active.uri, port: active.port, interval: active.interval, timeout: active.timeout, expectStatus: active.status }
      : null,
    passive: passive
      ? {
          failDuration: passive.failDuration,
          maxFails: passive.maxFails,
          unhealthyStatus: passive.unhealthyStatus,
          unhealthyLatency: passive.unhealthyLatency,
          counting: Boolean(passive.failDuration && passive.failDuration !== "0" && !/^0+(ms|s|m|h)?$/.test(passive.failDuration)),
        }
      : null,
    loadBalancing: { policy: loadBalancer.policy, retries: loadBalancer.retries, tryDuration: loadBalancer.tryDuration },
  };
}

function overallStatus(statuses: readonly UpstreamStatus[]): UpstreamStatus {
  if (statuses.length === 0) return "unknown";
  if (statuses.every((status) => status === "disabled")) return "disabled";
  if (statuses.every((status) => status === "down")) return "down";
  if (statuses.some((status) => status === "down" || status === "degraded")) return "degraded";
  if (statuses.some((status) => status === "unknown")) return "unknown";
  if (statuses.every((status) => status === "up")) return "up";
  return "unchecked";
}

/** The health of `host`'s upstreams from Caddy's pool (`pool` null: Caddy did not answer). */
export function evaluateUpstreamHealth(host: HealthHost, pool: readonly CaddyUpstream[] | null, now = new Date()): ProxyHostHealth {
  const healthChecks = healthCheckSettings(host.loadBalancer);
  const counting = healthChecks.passive?.counting ?? false;
  const maxFails = Math.max(1, healthChecks.passive?.maxFails ?? DEFAULT_MAX_FAILS);
  const byAddress = new Map((pool ?? []).map((entry) => [entry.address, entry]));
  const upstreams = host.upstreams.map((upstream): UpstreamHealth => {
    const target = parseUpstreamTarget(upstream);
    const entry = byAddress.get(target.dial);
    const base = { upstream, dial: target.dial, tls: target.scheme === "https" };
    if (!host.enabled) return { ...base, status: "disabled", reported: Boolean(entry), fails: entry?.fails ?? null, requestsInFlight: entry?.numRequests ?? null };
    if (!entry) return { ...base, status: "unknown", reported: false, fails: null, requestsInFlight: null };
    let status: UpstreamStatus;
    if (counting) status = entry.fails >= maxFails ? "down" : entry.fails > 0 ? "degraded" : "up";
    else status = entry.fails > 0 ? "degraded" : "unchecked";
    return { ...base, status, reported: true, fails: entry.fails, requestsInFlight: entry.numRequests };
  });
  return {
    proxyHostId: host.id,
    checkedAt: now.toISOString(),
    caddyReachable: pool !== null,
    status: overallStatus(upstreams.map((upstream) => upstream.status)),
    healthChecks,
    upstreams,
  };
}

/**
 * Reads Caddy's upstream pool, waiting at most `timeoutMs`; null when Caddy
 * does not answer in time or the answer is unusable (never "healthy").
 */
export async function readCaddyUpstreamPool(
  options: { timeoutMs?: number; fetchUpstreams?: () => Promise<CaddyUpstream[]> } = {}
): Promise<CaddyUpstream[] | null> {
  const fetchUpstreams = options.fetchUpstreams ?? fetchCaddyUpstreams;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetchUpstreams().catch(() => null), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The health of `host`'s upstreams, read from Caddy now. */
export async function getProxyHostHealth(
  host: HealthHost,
  options: { timeoutMs?: number; fetchUpstreams?: () => Promise<CaddyUpstream[]> } = {}
): Promise<ProxyHostHealth> {
  return evaluateUpstreamHealth(host, await readCaddyUpstreamPool(options));
}
