/**
 * Which traffic a query may read. ClickHouse stores each request's Host
 * header, not the proxy host that served it, so:
 *
 * - HostScope limits a caller to stored host names: null for every host,
 *   otherwise the names of their organisation (ee/multi-tenancy/analytics.ts).
 * - A proxy host's traffic is the stored names its domains serve: equal to a
 *   domain, or one label under a "*." domain (as Caddy matches), port, case
 *   and a trailing dot ignored. A name that is a domain of one host and
 *   matches another host's wildcard belongs to the first, as in Caddy.
 */
import type { Access } from '../permissions';
import { isDomainCoveredByWildcard } from '../cert-domain-match';
import { analyticsHostScope } from '@/ee/multi-tenancy/analytics';
import { HOST_NAME_SQL } from './dimensions';
import type { SqlFragment } from './filters';

/** Stored host names a caller may see; null for every host. */
export type HostScope = readonly string[] | null;

/** The analytics scope of `access` (its organisation's hosts, or every host). */
export async function analyticsScopeFor(access: Access): Promise<HostScope> {
  return analyticsHostScope(access);
}

/** WHERE fragment limiting rows to `scope`. */
export function scopeSql(scope: HostScope, param = 'p_scope'): SqlFragment {
  if (scope === null) return { sql: '1', params: {} };
  if (scope.length === 0) return { sql: '0', params: {} };
  return { sql: `host IN {${param}:Array(String)}`, params: { [param]: [...scope] } };
}

/** A domain as stored in a proxy host: lowercase, no trailing dot. */
export function normalizeDomain(domain: unknown): string {
  return String(domain ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** A stored Host value as a bare name (mirrors HOST_NAME_SQL). */
export function hostName(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  return value.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
}

export type ProxyHostDomains = { id: number; domains: readonly string[] };

/** Exact names and wildcard suffixes (".example.com" for "*.example.com") of some domains. */
export function domainMatcher(domains: readonly string[]): { exact: string[]; suffixes: string[] } {
  const exact = new Set<string>();
  const suffixes = new Set<string>();
  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    if (domain.startsWith('*.')) suffixes.add(domain.slice(1));
    else exact.add(domain);
  }
  return { exact: [...exact], suffixes: [...suffixes] };
}

/**
 * WHERE fragment: rows whose host name is one of `exact`, or exactly one
 * label under one of `suffixes`, and not one of `exclude`.
 */
export function domainSql(
  matcher: { exact: readonly string[]; suffixes: readonly string[] },
  exclude: readonly string[] = [],
  prefix = 'p_dom'
): SqlFragment {
  if (matcher.exact.length === 0 && matcher.suffixes.length === 0) return { sql: '0', params: {} };
  const name = HOST_NAME_SQL;
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  if (matcher.exact.length > 0) {
    parts.push(`${name} IN {${prefix}_exact:Array(String)}`);
    params[`${prefix}_exact`] = [...matcher.exact];
  }
  if (matcher.suffixes.length > 0) {
    parts.push(
      `arrayExists(s -> endsWith(${name}, s) AND length(${name}) > length(s) AND position(substring(${name}, 1, length(${name}) - length(s)), '.') = 0, {${prefix}_suffix:Array(String)})`
    );
    params[`${prefix}_suffix`] = [...matcher.suffixes];
  }
  let sql = `(${parts.join(' OR ')})`;
  if (exclude.length > 0) {
    sql = `(${sql} AND ${name} NOT IN {${prefix}_exclude:Array(String)})`;
    params[`${prefix}_exclude`] = [...exclude];
  }
  return { sql, params };
}

/**
 * The proxy host a stored host name belongs to: an exact domain first, then
 * a wildcard; null when none serves it.
 */
export function proxyHostForName(name: string, hosts: readonly ProxyHostDomains[]): number | null {
  const bare = hostName(name);
  if (!bare) return null;
  for (const host of hosts) {
    if (host.domains.some((domain) => normalizeDomain(domain) === bare)) return host.id;
  }
  for (const host of hosts) {
    const wildcards = host.domains.map(normalizeDomain).filter((domain) => domain.startsWith('*.'));
    if (wildcards.length > 0 && isDomainCoveredByWildcard(bare, wildcards)) return host.id;
  }
  return null;
}

/**
 * Exact domains of `others` that a wildcard of `host` would also match: their
 * traffic belongs to those hosts, so a summary of `host` leaves them out.
 */
export function exactDomainsTakenByOthers(host: ProxyHostDomains, others: readonly ProxyHostDomains[]): string[] {
  const wildcards = host.domains.map(normalizeDomain).filter((domain) => domain.startsWith('*.'));
  if (wildcards.length === 0) return [];
  const own = new Set(host.domains.map(normalizeDomain));
  const taken = new Set<string>();
  for (const other of others) {
    if (other.id === host.id) continue;
    for (const raw of other.domains) {
      const domain = normalizeDomain(raw);
      if (domain && !domain.startsWith('*.') && !own.has(domain) && isDomainCoveredByWildcard(domain, wildcards)) taken.add(domain);
    }
  }
  return [...taken];
}

/** Parses a proxy host's stored `domains` JSON. */
export function parseDomains(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map(normalizeDomain).filter(Boolean) : [];
  } catch {
    return [];
  }
}
