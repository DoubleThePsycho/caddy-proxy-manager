// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: what an organisation user may set on a proxy host. Every
 * tenant shares one Caddy, so a host field that reaches beyond the host
 * itself could break isolation:
 *
 *   - custom reverse-proxy JSON and custom pre-handlers JSON inject raw
 *     Caddy configuration;
 *   - raw WAF directives (waf.custom_directives) inject Coraza SecLang, which
 *     can read and write files and change the engine;
 *   - mTLS trusts CA and client certificates, which belong to the provider;
 *   - custom DNS resolvers decide what an allowed upstream name resolves to;
 *   - upstreams (also location-rule upstreams and the forward-auth and
 *     Authentik servers) are limited to the organisation's allowed upstreams
 *     (upstreams.ts), and health checks never probe Caddy's admin API port.
 *
 * Organisation users cannot set or change any of them; keeping what the
 * provider set, or clearing a raw field, is fine. Checked by the routes and
 * actions (src/lib/access-scope.ts) and again by the model for every write
 * made by an organisation user, whatever the path (REST, dashboard, change
 * approvals).
 */
import { appDb } from "@/src/lib/db";
import type { ProxyHost, ProxyHostInput } from "@/src/lib/models/proxy-hosts";
import { readOrganization } from "./store";
import { actorOrganizationId, assertActorReaches, organizationForNewRow, TenantError } from "./scope";
import { assertUpstreamsAllowed } from "./upstreams";
import { assertHostReferencesInTenant } from "./guard";
import { assertNamesFreeAcrossOrganizations } from "./domains";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True when `next` sets a non-empty value other than `current` (clearing is not setting). */
function setsNewValue(next: unknown, current: unknown): boolean {
  if (next === undefined) return false;
  const value = text(next);
  return value.length > 0 && value !== text(current);
}

function ids(values: readonly number[] | null | undefined): number[] {
  return [...new Set(values ?? [])].sort((a, b) => a - b);
}

function mtlsKey(value: ProxyHostInput["mtls"] | ProxyHost["mtls"] | undefined): string | null {
  if (!value || value.enabled === false) return null;
  return JSON.stringify([
    ids(value.trusted_client_cert_ids),
    ids(value.trusted_role_ids),
    ids(value.ca_certificate_ids),
    [...(value.protected_paths ?? [])].sort(),
    [...(value.excluded_paths ?? [])].sort(),
  ]);
}

function resolverKey(value: ProxyHostInput["dnsResolver"] | ProxyHost["dnsResolver"] | undefined): string | null {
  if (!value || value.enabled === false) return null;
  const resolvers = (value.resolvers ?? []).map(text).filter(Boolean);
  const fallbacks = (value.fallbacks ?? []).map(text).filter(Boolean);
  if (resolvers.length === 0 && fallbacks.length === 0) return null;
  return JSON.stringify([[...resolvers].sort(), [...fallbacks].sort()]);
}

function locationUpstreams(rules: readonly { upstreams?: readonly string[] | null }[] | null | undefined): string[] {
  return (rules ?? []).flatMap((rule) => [...(rule?.upstreams ?? [])]);
}

/**
 * Refuses (403) a proxy host write by a user of organisation `organizationId`
 * that sets anything listed above. `existing` is null when creating.
 */
export async function assertOrganizationHostInput(
  organizationId: number,
  input: Partial<ProxyHostInput>,
  existing: ProxyHost | null
): Promise<void> {
  if (
    setsNewValue(input.customReverseProxyJson, existing?.customReverseProxyJson) ||
    setsNewValue(input.customPreHandlersJson, existing?.customPreHandlersJson)
  ) {
    throw new TenantError("Organisation users cannot set custom Caddy JSON on a proxy host");
  }
  if (input.waf && setsNewValue(input.waf.custom_directives, existing?.waf?.custom_directives)) {
    throw new TenantError("Organisation users cannot set custom WAF directives");
  }
  if (input.mtls !== undefined && mtlsKey(input.mtls) !== mtlsKey(existing?.mtls)) {
    throw new TenantError("mTLS on a proxy host is managed by your provider");
  }
  if (input.dnsResolver !== undefined && resolverKey(input.dnsResolver) !== resolverKey(existing?.dnsResolver)) {
    throw new TenantError("Custom DNS resolvers are managed by your provider");
  }

  const patterns = (await readOrganization(appDb, organizationId))?.allowedUpstreams ?? [];
  assertUpstreamsAllowed(patterns, input.upstreams ?? [], existing?.upstreams ?? []);
  assertUpstreamsAllowed(patterns, locationUpstreams(input.locationRules), locationUpstreams(existing?.locationRules));
  if (input.authentik) {
    assertUpstreamsAllowed(patterns, [input.authentik.outpostUpstream], [existing?.authentik?.outpostUpstream]);
  }
  if (input.forwardAuth) {
    assertUpstreamsAllowed(patterns, [input.forwardAuth.authUpstream], [existing?.forwardAuth?.authUpstream]);
  }
  // Health checks may probe another port of an allowed upstream, never Caddy's admin API.
  const healthPort = input.loadBalancer?.activeHealthCheck?.port;
  if (healthPort === 2019 && existing?.loadBalancer?.activeHealthCheck?.port !== 2019) {
    throw new TenantError("Port 2019 (Caddy's admin API) is not available to organisations");
  }
}

/**
 * The model's checks before a proxy host is created by `actorUserId`; returns
 * the organisation the host belongs to (organizationForNewRow). Domains must
 * be free across organisations and references must be of the host's own
 * organisation, for every writer.
 */
export async function checkProxyHostCreate(
  actorUserId: number,
  input: Partial<ProxyHostInput> & { organizationId?: unknown },
  domains: readonly string[]
): Promise<number | null> {
  const organizationId = await organizationForNewRow(actorUserId, input.organizationId);
  const actor = await actorOrganizationId(actorUserId);
  if (actor !== null) await assertOrganizationHostInput(actor, input, null);
  await assertHostReferencesInTenant(appDb, organizationId, { certificateId: input.certificateId, accessListId: input.accessListId }, actor);
  await assertNamesFreeAcrossOrganizations(appDb, organizationId, domains);
  return organizationId;
}

/** The model's checks before `actorUserId` changes proxy host `existing`. */
export async function checkProxyHostUpdate(
  actorUserId: number,
  existing: ProxyHost,
  input: Partial<ProxyHostInput>,
  domains: readonly string[] | null
): Promise<void> {
  await assertActorReaches(actorUserId, existing.organizationId, "Proxy host not found");
  const actor = await actorOrganizationId(actorUserId);
  if (actor !== null) await assertOrganizationHostInput(actor, input, existing);
  await assertHostReferencesInTenant(
    appDb,
    existing.organizationId,
    {
      certificateId: input.certificateId !== undefined && input.certificateId !== existing.certificateId ? input.certificateId : undefined,
      accessListId: input.accessListId !== undefined && input.accessListId !== existing.accessListId ? input.accessListId : undefined,
    },
    actor
  );
  if (domains) await assertNamesFreeAcrossOrganizations(appDb, existing.organizationId, domains, { proxyHostId: existing.id });
}
