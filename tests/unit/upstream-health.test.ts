import { describe, expect, it, vi } from 'vitest';
import { evaluateUpstreamHealth, getProxyHostHealth, healthCheckSettings, readCaddyUpstreamPool } from '@/src/lib/upstream-health';
import type { LoadBalancerConfig } from '@/src/lib/models/proxy-hosts';

function lb(extra: Partial<LoadBalancerConfig> = {}): LoadBalancerConfig {
  return {
    enabled: true,
    policy: 'round_robin',
    policyHeaderField: null,
    policyCookieName: null,
    policyCookieSecret: 'never-shown',
    tryDuration: null,
    tryInterval: null,
    retries: null,
    activeHealthCheck: null,
    passiveHealthCheck: null,
    ...extra,
  };
}

const passive = (failDuration: string | null, maxFails: number | null = null) =>
  lb({ passiveHealthCheck: { enabled: true, failDuration, maxFails, unhealthyStatus: null, unhealthyLatency: null } });

const host = (loadBalancer: LoadBalancerConfig | null, upstreams = ['http://app:8080', 'https://api:8443'], enabled = true) => ({
  id: 7,
  enabled,
  upstreams,
  loadBalancer,
});

describe('healthCheckSettings', () => {
  it('reports no checks without a load balancer', () => {
    expect(healthCheckSettings(null)).toEqual({ active: null, passive: null, loadBalancing: null });
    expect(healthCheckSettings(lb({ enabled: false }))).toEqual({ active: null, passive: null, loadBalancing: null });
  });

  it('knows passive checks count nothing without a fail duration', () => {
    expect(healthCheckSettings(passive('30s')).passive?.counting).toBe(true);
    expect(healthCheckSettings(passive(null)).passive?.counting).toBe(false);
    expect(healthCheckSettings(passive('0s')).passive?.counting).toBe(false);
  });

  it('never returns the cookie secret', () => {
    expect(JSON.stringify(healthCheckSettings(passive('30s')))).not.toContain('never-shown');
  });
});

describe('evaluateUpstreamHealth', () => {
  const pool = [
    { address: 'app:8080', numRequests: 2, fails: 0 },
    { address: 'api:8443', numRequests: 0, fails: 3 },
  ];

  it('matches upstreams to Caddy dial addresses', () => {
    const health = evaluateUpstreamHealth(host(passive('30s', 3)), pool, new Date('2026-10-03T00:00:00Z'));
    expect(health.upstreams).toEqual([
      { upstream: 'http://app:8080', dial: 'app:8080', tls: false, status: 'up', reported: true, fails: 0, requestsInFlight: 2 },
      { upstream: 'https://api:8443', dial: 'api:8443', tls: true, status: 'down', reported: true, fails: 3, requestsInFlight: 0 },
    ]);
    expect(health).toMatchObject({ proxyHostId: 7, caddyReachable: true, status: 'degraded', checkedAt: '2026-10-03T00:00:00.000Z' });
  });

  it('marks some failures below max fails as degraded', () => {
    expect(evaluateUpstreamHealth(host(passive('30s', 5)), pool).upstreams[1].status).toBe('degraded');
    expect(evaluateUpstreamHealth(host(passive('30s', 1), ['https://api:8443']), pool).status).toBe('down');
  });

  it('never calls an upstream up without passive checks', () => {
    const health = evaluateUpstreamHealth(host(null), pool);
    expect(health.upstreams.map((upstream) => upstream.status)).toEqual(['unchecked', 'degraded']);
    expect(evaluateUpstreamHealth(host(null, ['http://app:8080']), pool).status).toBe('unchecked');
  });

  it('is unknown when Caddy does not answer or does not report the address', () => {
    expect(evaluateUpstreamHealth(host(passive('30s')), null)).toMatchObject({ caddyReachable: false, status: 'unknown' });
    expect(evaluateUpstreamHealth(host(passive('30s'), ['other:1']), pool).upstreams[0]).toMatchObject({ status: 'unknown', reported: false, fails: null });
  });

  it('reports a disabled host as disabled', () => {
    expect(evaluateUpstreamHealth(host(passive('30s'), ['http://app:8080'], false), pool).status).toBe('disabled');
  });
});

describe('reading Caddy', () => {
  it('returns null when Caddy fails or is too slow', async () => {
    expect(await readCaddyUpstreamPool({ fetchUpstreams: () => Promise.reject(new Error('ECONNREFUSED')) })).toBeNull();
    const slow = () => new Promise<never>(() => undefined);
    expect(await readCaddyUpstreamPool({ fetchUpstreams: slow, timeoutMs: 10 })).toBeNull();
  });

  it('reads the pool through the given client', async () => {
    const fetchUpstreams = vi.fn().mockResolvedValue([{ address: 'app:8080', numRequests: 0, fails: 0 }]);
    const health = await getProxyHostHealth(host(passive('10s'), ['app:8080']), { fetchUpstreams });
    expect(fetchUpstreams).toHaveBeenCalledOnce();
    expect(health.status).toBe('up');
  });
});
