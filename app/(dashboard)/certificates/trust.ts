/**
 * Which proxy hosts rely on a certificate authority or an mTLS role: the
 * "Trusted by" and "required by" of the certificates page.
 */
import type { MtlsConfig } from "@/src/lib/models/proxy-hosts";

export type HostRef = { id: number; name: string; domain: string | null };

type HostLike = { id: number; name: string; domains: string[]; mtls: MtlsConfig | null };
type IssuedLike = { id: number; caCertificateId: number; revokedAt: string | null };

/**
 * A host trusts a CA when its mTLS names the CA (older hosts), one of the
 * CA's issued certificates, or a role holding one of them. A host requires a
 * role when its mTLS names the role.
 */
export function trustAnchorUsage(
  hosts: readonly HostLike[],
  issuedCerts: readonly IssuedLike[],
  roleCertIds: ReadonlyMap<number, ReadonlySet<number>>
): { caTrustedBy: Map<number, HostRef[]>; roleRequiredBy: Map<number, HostRef[]> } {
  const caOfCert = new Map(issuedCerts.map((cert) => [cert.id, cert.caCertificateId]));
  const caTrustedBy = new Map<number, HostRef[]>();
  const roleRequiredBy = new Map<number, HostRef[]>();
  const add = (map: Map<number, HostRef[]>, key: number, host: HostLike) => {
    const list = map.get(key) ?? [];
    if (!list.some((h) => h.id === host.id)) list.push({ id: host.id, name: host.name, domain: host.domains[0] ?? null });
    map.set(key, list);
  };

  for (const host of hosts) {
    const mtls = host.mtls;
    if (!mtls?.enabled) continue;
    const cas = new Set<number>(mtls.ca_certificate_ids ?? []);
    for (const certId of mtls.trusted_client_cert_ids ?? []) {
      const ca = caOfCert.get(certId);
      if (ca !== undefined) cas.add(ca);
    }
    for (const roleId of mtls.trusted_role_ids ?? []) {
      add(roleRequiredBy, roleId, host);
      for (const certId of roleCertIds.get(roleId) ?? []) {
        const ca = caOfCert.get(certId);
        if (ca !== undefined) cas.add(ca);
      }
    }
    for (const ca of cas) add(caTrustedBy, ca, host);
  }
  return { caTrustedBy, roleRequiredBy };
}
