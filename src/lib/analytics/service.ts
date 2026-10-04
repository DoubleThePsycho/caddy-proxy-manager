/**
 * The analytics server functions for a caller: each resolves what the caller
 * may see (their organisation's hosts, and for per-host summaries the proxy
 * hosts their role reaches) and runs the query. Pages and the REST API
 * (app/api/v1/analytics) call these after their permission check.
 */
import { appDb } from '../db';
import { proxyHosts } from '../db/schema';
import type { Access } from '../permissions';
import { scopeTagsFor } from '../permissions';
import { listProxyHosts } from '../models/proxy-hosts';
import { findProxyHostInScope } from '../access-scope';
import { ApiClientError } from '../api-errors';
import { dashboardOrganizationFilter } from '@/ee/multi-tenancy/view';
import { queryHostDetail, queryHostSummaries, type HostDetailResult, type HostSummariesResult } from './hosts';
import type { ResolvedRange } from './range';
import { getTrafficSignals, type TrafficSignals } from './signals';
import { analyticsScopeFor, normalizeDomain, parseDomains, type HostScope, type ProxyHostDomains } from './scope';

export async function scopeFor(access: Access): Promise<HostScope> {
  return analyticsScopeFor(access);
}

/** Id and domains of every proxy host (routing is global, so ownership of a name needs all of them). */
export async function allProxyHostDomains(): Promise<ProxyHostDomains[]> {
  return (await appDb
    .select({ id: proxyHosts.id, domains: proxyHosts.domains })
    .from(proxyHosts))
    .map((row) => ({ id: row.id, domains: parseDomains(row.domains) }));
}

/** The proxy hosts `access` can see: its organisation (or organisation view) and its role's tag scope. */
export async function visibleProxyHostDomains(access: Access): Promise<ProxyHostDomains[]> {
  const hosts = await listProxyHosts(scopeTagsFor(access, 'proxy_hosts'), await dashboardOrganizationFilter(access));
  return hosts.map((host) => ({ id: host.id, domains: host.domains.map(normalizeDomain).filter(Boolean) }));
}

/** Summaries of the proxy hosts `access` can see, or of `ids` among them. */
export async function hostSummariesFor(access: Access, range: ResolvedRange, ids?: readonly number[]): Promise<HostSummariesResult> {
  const visible = await visibleProxyHostDomains(access);
  const wanted = ids ? visible.filter((host) => ids.includes(host.id)) : visible;
  return queryHostSummaries({ range, hosts: wanted, allHosts: await allProxyHostDomains() }, await scopeFor(access));
}

/** Summary of proxy host `id`; a 404 ApiClientError when it is missing or outside what `access` can see. */
export async function hostDetailFor(access: Access, id: number, range: ResolvedRange): Promise<HostDetailResult> {
  const host = await findProxyHostInScope(access, id);
  if (!host) throw new ApiClientError('Proxy host not found', 404);
  const domains = { id: host.id, domains: host.domains.map(normalizeDomain).filter(Boolean) };
  return queryHostDetail({ range, host: domains, allHosts: await allProxyHostDomains() }, await scopeFor(access));
}

/** The overview's traffic signals for what `access` can see. */
export async function trafficSignalsFor(access: Access): Promise<TrafficSignals> {
  return getTrafficSignals(await scopeFor(access), await allProxyHostDomains());
}
