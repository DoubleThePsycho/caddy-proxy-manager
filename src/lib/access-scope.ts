/**
 * Tag scopes and the other limits on what a non-administrator may do with
 * hosts and certificates (custom roles, ee/custom-roles). Routes and server
 * actions call these after requirePermission / requireApiPermission.
 *
 * - Proxy hosts and L4 proxy hosts: a scoped role sees and changes only hosts
 *   carrying one of its tags. A host outside the scope answers 404, exactly
 *   like a missing one. A scoped write may only add or remove the role's own
 *   tags and must leave at least one of them on the host, so creating a host
 *   requires one. Domains (and L4 listening ports) that a host outside the
 *   scope already uses are refused, so a team cannot take over another team's
 *   traffic.
 * - Certificates: a scoped role sees the certificates its in-scope proxy
 *   hosts use; it may change or delete one only when every host using it is
 *   in scope, and it cannot create certificates (a new certificate is used by
 *   no host yet). CA certificates, client certificates and mTLS roles are
 *   trust anchors for every host, so they need a certificates permission
 *   without a scope.
 * - Every non-administrator (scoped or not) is refused raw Caddy JSON on proxy
 *   hosts and upstreams on Caddy's admin API port, and may only reference a
 *   certificate, access list, CA/client certificate, mTLS role, user or group
 *   on a host if they can read it (or the host already references it).
 *
 * Administrators are never limited here.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { appDb } from "./db";
import { l4ProxyHosts, proxyHosts } from "./db/schema";
import { ApiClientError, ApiValidationError } from "./api-errors";
import { can, scopeTagsFor, tagsInScope, type Access, type ScopableArea } from "./permissions";
import { normalizeTags, parseStoredTags } from "./host-tags";
import { tagsMatchAny } from "./host-tag-filter";
import { normalizeProxyHostDomains } from "./proxy-host-domains";
import { isDomainCoveredByWildcard } from "./cert-domain-match";
import { extractL4ListenPort } from "./l4-reserved-ports";
import { getProxyHost, type MtlsConfig, type ProxyHost, type ProxyHostInput } from "./models/proxy-hosts";
import { getL4ProxyHost, type L4ProxyHost, type L4ProxyHostInput } from "./models/l4-proxy-hosts";

/** A refusal because of the caller's role (403); the message is safe to show. */
export class ScopeError extends ApiClientError {
  constructor(message: string) {
    super(message, 403);
    this.name = "ScopeError";
  }
}

/** The Caddy admin API port. Proxying to it would hand over the whole Caddy configuration. */
const CADDY_ADMIN_PORT = 2019;

// ── Proxy hosts and L4 proxy hosts ────────────────────────────────────

/** The proxy host, or null when it is missing or outside the caller's scope. */
export async function findProxyHostInScope(access: Access, id: number): Promise<ProxyHost | null> {
  const host = Number.isSafeInteger(id) && id > 0 ? await getProxyHost(id) : null;
  return host && tagsInScope(host.tags, scopeTagsFor(access, "proxy_hosts")) ? host : null;
}

/**
 * The proxy host; throws "Proxy host not found" (404 through apiErrorResponse,
 * exactly as for a missing host) when it is missing or outside the scope.
 */
export async function getProxyHostInScope(access: Access, id: number): Promise<ProxyHost> {
  const host = await findProxyHostInScope(access, id);
  if (!host) throw new Error("Proxy host not found");
  return host;
}

/** The L4 proxy host, or null when it is missing or outside the caller's scope. */
export async function findL4ProxyHostInScope(access: Access, id: number): Promise<L4ProxyHost | null> {
  const host = Number.isSafeInteger(id) && id > 0 ? await getL4ProxyHost(id) : null;
  return host && tagsInScope(host.tags, scopeTagsFor(access, "l4_proxy_hosts")) ? host : null;
}

/** The L4 proxy host; throws "L4 proxy host not found" (404) when missing or outside the scope. */
export async function getL4ProxyHostInScope(access: Access, id: number): Promise<L4ProxyHost> {
  const host = await findL4ProxyHostInScope(access, id);
  if (!host) throw new Error("L4 proxy host not found");
  return host;
}

/**
 * The tags a host gets from a write, or undefined to leave them as they are.
 * `existing` is the host's current tags (null when creating one). Unscoped
 * callers set whatever they send. A scoped caller may only add or remove tags
 * of its scope (other tags already on the host are kept), and the host must
 * keep at least one tag of the scope.
 */
export function tagsForWrite(
  access: Access,
  area: Extract<ScopableArea, "proxy_hosts" | "l4_proxy_hosts">,
  requested: unknown,
  existing: readonly string[] | null
): string[] | undefined {
  const scope = scopeTagsFor(access, area);
  if (scope === null) return requested === undefined ? undefined : normalizeTags(requested);
  const current = existing ?? [];
  const wanted = requested === undefined ? [...current] : normalizeTags(requested);
  const foreign = wanted.filter((tag) => !scope.includes(tag) && !current.includes(tag));
  if (foreign.length > 0) {
    throw new ScopeError(`You can only add your role's tags (${scope.join(", ")}), not ${foreign.join(", ")}`);
  }
  const kept = current.filter((tag) => !scope.includes(tag));
  const result = [...new Set([...kept, ...wanted.filter((tag) => scope.includes(tag))])].sort();
  if (!result.some((tag) => scope.includes(tag))) {
    throw new ApiValidationError(`The host needs at least one of your role's tags: ${scope.join(", ")}`);
  }
  return result;
}

function domainsOverlap(a: string, b: string): boolean {
  return a === b || isDomainCoveredByWildcard(a, [b]) || isDomainCoveredByWildcard(b, [a]);
}

/**
 * Refuses domains that a proxy host outside the caller's scope serves (equal,
 * or matched through a wildcard either way). Unscoped callers are not checked.
 */
export async function assertDomainsFreeOutsideScope(
  access: Access,
  domains: readonly string[] | undefined,
  exceptHostId: number | null
): Promise<void> {
  if (domains === undefined) return;
  const scope = scopeTagsFor(access, "proxy_hosts");
  if (scope === null) return;
  const wanted = normalizeProxyHostDomains([...domains]);
  const rows = await appDb.select({ id: proxyHosts.id, domains: proxyHosts.domains, tags: proxyHosts.tags }).from(proxyHosts);
  for (const row of rows) {
    if (row.id === exceptHostId || tagsInScope(parseStoredTags(row.tags), scope)) continue;
    let taken: string[] = [];
    try {
      taken = JSON.parse(row.domains) as string[];
    } catch {
      continue;
    }
    const clash = wanted.find((domain) => taken.some((other) => domainsOverlap(domain, String(other).toLowerCase())));
    if (clash) {
      throw new ScopeError(`The domain ${clash} is served by a host outside your role's scope`);
    }
  }
}

/** Refuses an L4 listening port (per protocol) that an L4 host outside the caller's scope uses. */
export async function assertListenPortFreeOutsideScope(
  access: Access,
  protocol: string | undefined,
  listenAddress: string | undefined,
  exceptHostId: number | null
): Promise<void> {
  const scope = scopeTagsFor(access, "l4_proxy_hosts");
  if (scope === null || listenAddress === undefined || protocol === undefined) return;
  const port = extractL4ListenPort(listenAddress);
  if (port === null) return; // The model refuses it with the reason.
  const rows = await appDb
    .select({ id: l4ProxyHosts.id, protocol: l4ProxyHosts.protocol, listenAddress: l4ProxyHosts.listenAddress, tags: l4ProxyHosts.tags })
    .from(l4ProxyHosts);
  for (const row of rows) {
    if (row.id === exceptHostId || tagsInScope(parseStoredTags(row.tags), scope)) continue;
    if (row.protocol === protocol && extractL4ListenPort(row.listenAddress) === port) {
      throw new ScopeError(`Port ${port}/${protocol} is used by an L4 host outside your role's scope`);
    }
  }
}

function upstreamPort(upstream: string): number | null {
  let rest = upstream.trim();
  const scheme = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (scheme) rest = rest.slice(scheme[0].length);
  rest = rest.split("/")[0] ?? "";
  const match = rest.match(/:(\d{1,5})$/);
  return match ? Number(match[1]) : null;
}

function assertNoAdminApiUpstream(upstreams: readonly string[] | null | undefined): void {
  for (const upstream of upstreams ?? []) {
    if (typeof upstream === "string" && upstreamPort(upstream) === CADDY_ADMIN_PORT) {
      throw new ScopeError(`Only administrators can proxy to port ${CADDY_ADMIN_PORT} (Caddy's admin API)`);
    }
  }
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a?.trim() || null) === (b?.trim() || null);
}

function sameIds(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  const left = [...new Set(a ?? [])].sort((x, y) => x - y);
  const right = [...new Set(b ?? [])].sort((x, y) => x - y);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mtlsReferencesChanged(next: MtlsConfig | null | undefined, previous: MtlsConfig | null | undefined): boolean {
  if (next === undefined) return false;
  return (
    !sameIds(next?.trusted_client_cert_ids, previous?.trusted_client_cert_ids) ||
    !sameIds(next?.trusted_role_ids, previous?.trusted_role_ids) ||
    !sameIds(next?.ca_certificate_ids, previous?.ca_certificate_ids)
  );
}

/**
 * Checks a proxy host write by a non-administrator: no raw Caddy JSON, no
 * upstream on the admin API port, and only references the caller can read
 * (or that the host already has). `existing` is null when creating.
 */
export async function assertProxyHostWriteAllowed(
  access: Access,
  input: Partial<ProxyHostInput>,
  existing: ProxyHost | null
): Promise<void> {
  if (access.isAdmin) return;
  if (
    (input.customReverseProxyJson !== undefined && !sameText(input.customReverseProxyJson, existing?.customReverseProxyJson)) ||
    (input.customPreHandlersJson !== undefined && !sameText(input.customPreHandlersJson, existing?.customPreHandlersJson))
  ) {
    throw new ScopeError("Only administrators can set custom Caddy JSON on a proxy host");
  }
  assertNoAdminApiUpstream(input.upstreams);
  for (const rule of input.locationRules ?? []) assertNoAdminApiUpstream(rule?.upstreams);

  const certificateId = input.certificateId;
  if (certificateId !== undefined && certificateId !== null && certificateId !== existing?.certificateId) {
    const visible = can(access, "certificates:read") && (await certificateVisible(access, certificateId));
    if (!visible) throw new ScopeError("You cannot use this certificate");
  }
  const accessListId = input.accessListId;
  if (accessListId !== undefined && accessListId !== null && accessListId !== existing?.accessListId) {
    if (!can(access, "access_lists:read")) throw new ScopeError("Using an access list needs the access_lists:read permission");
  }
  if (mtlsReferencesChanged(input.mtls, existing?.mtls)) {
    if (!can(access, "certificates:read") || scopeTagsFor(access, "certificates") !== null) {
      throw new ScopeError("Changing trusted client certificates needs certificate permissions without a tag scope");
    }
  }
}

/**
 * Checks mTLS access-rule references (mTLS roles and client certificates) set
 * by a non-administrator: changing them needs certificate permissions without
 * a tag scope, like the trust anchors themselves.
 */
export function assertMtlsRuleReferencesAllowed(
  access: Access,
  next: { allowedRoleIds?: readonly number[]; allowedCertIds?: readonly number[] },
  current: { allowedRoleIds: readonly number[]; allowedCertIds: readonly number[] } | null
): void {
  if (access.isAdmin) return;
  const changed =
    (next.allowedRoleIds !== undefined && !sameIds(next.allowedRoleIds, current?.allowedRoleIds ?? [])) ||
    (next.allowedCertIds !== undefined && !sameIds(next.allowedCertIds, current?.allowedCertIds ?? []));
  if (changed && (!can(access, "certificates:read") || scopeTagsFor(access, "certificates") !== null)) {
    throw new ScopeError("Choosing mTLS roles or client certificates needs certificate permissions without a tag scope");
  }
}

/** Checks forward-auth access (users and groups allowed through a host) set by a non-administrator. */
export async function assertForwardAuthAccessAllowed(
  access: Access,
  next: { userIds?: readonly number[]; groupIds?: readonly number[] },
  current: { userIds: readonly number[]; groupIds: readonly number[] }
): Promise<void> {
  if (access.isAdmin) return;
  if (next.userIds !== undefined && !sameIds(next.userIds, current.userIds) && !can(access, "users:read")) {
    throw new ScopeError("Choosing users for forward auth needs the users:read permission");
  }
  if (next.groupIds !== undefined && !sameIds(next.groupIds, current.groupIds) && !can(access, "groups:read")) {
    throw new ScopeError("Choosing groups for forward auth needs the groups:read permission");
  }
}

/** Checks an L4 host write by a non-administrator: no upstream on the admin API port. */
export function assertL4WriteAllowed(access: Access, input: Partial<L4ProxyHostInput>): void {
  if (access.isAdmin) return;
  assertNoAdminApiUpstream(input.upstreams);
}

// ── Certificates ──────────────────────────────────────────────────────

/** Ids of the certificates the caller's tag scope covers, or null for all of them. */
export async function certificateIdsInScope(access: Access): Promise<Set<number> | null> {
  const scope = scopeTagsFor(access, "certificates");
  if (scope === null) return null;
  const rows = await appDb
    .select({ certificateId: proxyHosts.certificateId })
    .from(proxyHosts)
    .where(and(isNotNull(proxyHosts.certificateId), tagsMatchAny(proxyHosts.tags, scope)));
  return new Set(rows.map((row) => row.certificateId!));
}

async function certificateVisible(access: Access, certificateId: number): Promise<boolean> {
  const ids = await certificateIdsInScope(access);
  return ids === null || ids.has(certificateId);
}

/** 404 unless the certificate is in the caller's scope. */
export async function assertCertificateReadable(access: Access, certificateId: number): Promise<void> {
  if (!(await certificateVisible(access, certificateId))) {
    throw new Error("Certificate not found");
  }
}

/**
 * Refuses changing or deleting a certificate unless every proxy host using it
 * is in the caller's scope (404 when none is, like a missing certificate).
 */
export async function assertCertificateWritable(access: Access, certificateId: number): Promise<void> {
  const scope = scopeTagsFor(access, "certificates");
  if (scope === null) return;
  const rows = await appDb
    .select({ tags: proxyHosts.tags })
    .from(proxyHosts)
    .where(eq(proxyHosts.certificateId, certificateId));
  const inScope = rows.filter((row) => tagsInScope(parseStoredTags(row.tags), scope)).length;
  if (inScope === 0) throw new Error("Certificate not found");
  if (inScope < rows.length) {
    throw new ScopeError("This certificate is also used by hosts outside your role's scope");
  }
}

/** Refuses creating a certificate under a tag scope: a new certificate belongs to no host yet. */
export function assertCanCreateCertificate(access: Access): void {
  if (scopeTagsFor(access, "certificates") !== null) {
    throw new ScopeError("A role with a tag scope cannot create certificates; ask an administrator");
  }
}

/**
 * CA certificates, client certificates and mTLS roles serve every host, so a
 * certificates permission limited by a tag scope does not reach them.
 */
export function assertUnscopedCertificates(access: Access): void {
  if (scopeTagsFor(access, "certificates") !== null) {
    throw new ScopeError(
      "CA certificates, client certificates and mTLS roles need certificate permissions without a tag scope"
    );
  }
}
