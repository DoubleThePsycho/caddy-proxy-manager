import { X509Certificate } from 'node:crypto';
import { requirePermission } from '@/src/lib/auth';
import { can, scopeTagsFor, tenantOf } from '@/src/lib/permissions';
import { dashboardOrganizationFilter } from '@/ee/multi-tenancy/view';
import CertificatesClient from './CertificatesClient';
import { listCaCertificates, type CaCertificate } from '@/src/lib/models/ca-certificates';
import { listIssuedClientCertificates, type IssuedClientCertificate } from '@/src/lib/models/issued-client-certificates';
import { buildRoleCertIdMap, listMtlsRoles, type MtlsRole } from '@/src/lib/models/mtls-roles';
import { listProxyHosts, type ProxyHost } from '@/src/lib/models/proxy-hosts';
import { buildCertificateOverview } from '@/src/lib/certificate-overview';
import { getGeneralSettings } from '@/src/lib/settings';
import { trustAnchorUsage, type HostRef } from './trust';

export type { CaCertificate };
export type { IssuedClientCertificate };
export type { MtlsRole };

export type CaCertificateView = CaCertificate & {
  issuedCerts: IssuedClientCertificate[];
  /** End of the CA certificate's validity (ISO 8601), null when its PEM cannot be read. */
  validTo: string | null;
  /** Proxy hosts whose mTLS trusts this CA or certificates it issued. */
  trustedBy: HostRef[];
};

export type IssuedClientCertificateView = IssuedClientCertificate & {
  caName: string | null;
  /** Names of the mTLS roles the certificate belongs to. */
  roles: string[];
};

export type MtlsRoleView = MtlsRole & {
  /** Ids of the active certificates in the role. */
  certificateIds: number[];
  /** Proxy hosts whose mTLS requires the role. */
  requiredBy: HostRef[];
};

/** What the import/edit drawer needs of an imported certificate. */
export type ImportedCertView = { id: number; name: string; domains: string[] };

export type CertificatesTab = 'certificates' | 'authorities' | 'client';

interface PageProps {
  searchParams: Promise<{ tab?: string }>;
}

function pemValidTo(pem: string): string | null {
  try {
    return new Date(new X509Certificate(pem).validTo).toISOString();
  } catch {
    return null;
  }
}

export default async function CertificatesPage({ searchParams }: PageProps) {
  const { access } = await requirePermission('certificates:read');
  // A tag scope limits the certificate list to the certificates and ACME hosts
  // of in-scope proxy hosts; CA/client certificates and mTLS roles serve every
  // host and stay hidden (see src/lib/access-scope.ts). An organisation user
  // sees their organisation only, and none of the provider's trust anchors; a
  // provider-level user the organisation they picked (ee/multi-tenancy).
  const scope = scopeTagsFor(access, 'certificates');
  const organizationId = await dashboardOrganizationFilter(access);
  const hideTrustAnchors = scope !== null || tenantOf(access) !== null;
  const settingsReadable = can(access, 'settings:read') && tenantOf(access) === null;
  const { tab } = await searchParams;

  const [overview, caCerts, issuedClientCerts, roles, roleCertIds, hosts, general] = await Promise.all([
    buildCertificateOverview(access, organizationId),
    hideTrustAnchors ? Promise.resolve([] as CaCertificate[]) : listCaCertificates(),
    hideTrustAnchors ? Promise.resolve([] as IssuedClientCertificate[]) : listIssuedClientCertificates(),
    hideTrustAnchors ? Promise.resolve([] as MtlsRole[]) : listMtlsRoles().catch(() => [] as MtlsRole[]),
    hideTrustAnchors
      ? Promise.resolve(new Map<number, Set<number>>())
      : buildRoleCertIdMap().catch(() => new Map<number, Set<number>>()),
    // CAs and roles serve every host, so "trusted by" looks at every organisation's hosts.
    hideTrustAnchors ? Promise.resolve([] as ProxyHost[]) : listProxyHosts(null, undefined),
    settingsReadable ? getGeneralSettings() : Promise.resolve(null),
  ]);

  const usage = trustAnchorUsage(hosts, issuedClientCerts, roleCertIds);
  const caNames = new Map(caCerts.map((ca) => [ca.id, ca.name]));
  const roleNamesByCert = new Map<number, string[]>();
  for (const role of roles) {
    for (const certId of roleCertIds.get(role.id) ?? []) {
      roleNamesByCert.set(certId, [...(roleNamesByCert.get(certId) ?? []), role.name]);
    }
  }

  const caCertificates: CaCertificateView[] = caCerts.map((ca) => ({
    ...ca,
    issuedCerts: issuedClientCerts.filter((cert) => cert.caCertificateId === ca.id),
    validTo: pemValidTo(ca.certificatePem),
    trustedBy: usage.caTrustedBy.get(ca.id) ?? [],
  }));
  const clientCertificates: IssuedClientCertificateView[] = issuedClientCerts.map((cert) => ({
    ...cert,
    caName: caNames.get(cert.caCertificateId) ?? null,
    roles: roleNamesByCert.get(cert.id) ?? [],
  }));
  const mtlsRoles: MtlsRoleView[] = roles.map((role) => ({
    ...role,
    certificateIds: [...(roleCertIds.get(role.id) ?? [])],
    requiredBy: usage.roleRequiredBy.get(role.id) ?? [],
  }));

  const canWrite = can(access, 'certificates:write');

  return (
    <CertificatesClient
      overview={overview}
      caCertificates={caCertificates}
      clientCertificates={clientCertificates}
      mtlsRoles={mtlsRoles}
      showTrustAnchors={!hideTrustAnchors}
      canWrite={canWrite}
      canCreateCertificate={canWrite && scope === null}
      canReadSettings={settingsReadable}
      acmeEmail={general?.acmeEmail?.trim() || null}
      initialTab={!hideTrustAnchors && (tab === 'authorities' || tab === 'client') ? tab : 'certificates'}
    />
  );
}
