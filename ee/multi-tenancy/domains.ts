// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: domains stay unique across organisations. All tenants share
 * one Caddy, which routes by host name and picks certificates by SNI, so a
 * name one tenant serves or holds a certificate for must never be served by
 * another: it would take over the other tenant's traffic, or have Caddy hand
 * out the other tenant's certificate (an imported certificate is loaded into
 * Caddy's certificate cache, where every name in it matches).
 *
 * The provider level counts as one tenant. Two names clash when they are
 * equal or one is a wildcard that covers the other (one label, as Caddy
 * matches). Imported certificates count with the names in their PEM as well
 * as the names stored for them. Names within one tenant are that tenant's
 * business and are not checked here.
 *
 * With no organisations every row is provider-level and nothing ever clashes.
 */
import { X509Certificate } from "node:crypto";
import { ne, sql } from "drizzle-orm";
import { certificates, proxyHosts } from "@/src/lib/db/schema";
import { ApiClientError } from "@/src/lib/api-errors";
import { isDomainCoveredByWildcard } from "@/src/lib/cert-domain-match";
import type { TenantReader } from "./store";

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/** The DNS names (and the common name, when there are none) of the leaf certificate in `pem`. */
export function certificatePemNames(pem: string | null | undefined): string[] {
  if (!pem) return [];
  const block = pem.match(CERTIFICATE_BLOCK)?.[0];
  if (!block) return [];
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(block);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const part of (certificate.subjectAltName ?? "").split(",")) {
    const entry = part.trim();
    if (entry.startsWith("DNS:")) names.push(entry.slice(4).trim().toLowerCase());
  }
  if (names.length === 0) {
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(certificate.subject)?.[1]?.trim().toLowerCase();
    if (cn) names.push(cn);
  }
  return [...new Set(names.filter(Boolean))];
}

function normalizeName(name: unknown): string {
  return String(name ?? "").trim().toLowerCase().replace(/\.$/, "");
}

export function namesClash(a: string, b: string): boolean {
  return a === b || isDomainCoveredByWildcard(a, [b]) || isDomainCoveredByWildcard(b, [a]);
}

function parseNames(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.map(normalizeName).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const tenantKey = (column: typeof proxyHosts.organizationId | typeof certificates.organizationId) => sql`coalesce(${column}, 0)`;

/**
 * Refuses (409) any of `names` that a proxy host or certificate of another
 * tenant than `organizationId` (null: the provider level) serves or holds.
 * `except` leaves out the row being changed.
 */
export async function assertNamesFreeAcrossOrganizations(
  reader: TenantReader,
  organizationId: number | null,
  names: readonly string[],
  except: { proxyHostId?: number | null; certificateId?: number | null } = {}
): Promise<void> {
  const wanted = [...new Set(names.map(normalizeName).filter(Boolean))];
  if (wanted.length === 0) return;
  const key = organizationId ?? 0;
  const taken: string[] = [];
  const hostRows = await reader
    .select({ id: proxyHosts.id, domains: proxyHosts.domains })
    .from(proxyHosts)
    .where(ne(tenantKey(proxyHosts.organizationId), key));
  for (const row of hostRows) {
    if (row.id === except.proxyHostId) continue;
    taken.push(...parseNames(row.domains));
  }
  const certificateRows = await reader
    .select({ id: certificates.id, type: certificates.type, domainNames: certificates.domainNames, certificatePem: certificates.certificatePem })
    .from(certificates)
    .where(ne(tenantKey(certificates.organizationId), key));
  for (const row of certificateRows) {
    if (row.id === except.certificateId) continue;
    taken.push(...parseNames(row.domainNames));
    if (row.type === "imported") taken.push(...certificatePemNames(row.certificatePem));
  }
  if (taken.length === 0) return;
  for (const name of wanted) {
    if (taken.some((other) => namesClash(name, other))) {
      throw new ApiClientError(`The domain ${name} is already in use`, 409);
    }
  }
}
