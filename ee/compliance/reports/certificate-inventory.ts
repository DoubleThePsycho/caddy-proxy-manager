// SPDX-License-Identifier: Elastic-2.0
/**
 * Certificate inventory: TLS server certificates (imported, ACME-managed and
 * the automatic HTTPS of hosts without a certificate), CA certificates and
 * issued client certificates, as of generation time, with certificate
 * changes during the period.
 *
 * Only public certificate data is read and reported (subject, issuer, SANs,
 * key type, validity, fingerprint). Private keys are never decrypted or
 * included; whether one is stored is reported as a yes/no.
 */
import { X509Certificate } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { caCertificates, certificates, issuedClientCertificates, l4ProxyHosts, proxyHosts } from "@/src/lib/db/schema";
import { getAcmeSettings, getDnsProviderSettings } from "@/src/lib/settings";
import { isDomainCoveredByCert } from "@/src/lib/cert-domain-match";
import {
  auditEventSection,
  auditEventsInPeriod,
  clean,
  columns,
  DAY_MS,
  finding,
  iso,
  keyValueSection,
  parseStringArray,
  section,
  sortFindings,
  summaryItem,
  type BuildContext,
  type BuiltReport,
} from "./shared";
import type { ReportCell, ReportFinding } from "../types";
import { asc } from "@/src/lib/db/ops";

export const EXPIRY_WARNING_DAYS = 30;
const MAX_CERTIFICATE_CHANGES = 2000;
const CERTIFICATE_ENTITY_TYPES = ["certificate", "ca_certificate", "issued_client_certificate", "mtls_role", "mtls_certificate_role"];

const CURVES: Record<string, string> = { prime256v1: "P-256", secp384r1: "P-384", secp521r1: "P-521" };

export type PemInfo = {
  subject: string;
  issuer: string;
  sans: string[];
  keyType: string | null;
  serialNumber: string;
  fingerprintSha256: string;
  validFrom: string;
  validTo: string;
};

function distinguishedName(value: string | undefined): string {
  return clean((value ?? "").split("\n").filter(Boolean).join(", "), 400);
}

/** Public facts of a PEM certificate, or null when it cannot be parsed. Never touches a private key. */
export function describePem(pem: string | null | undefined): PemInfo | null {
  if (!pem) return null;
  try {
    const cert = new X509Certificate(pem);
    const key = cert.publicKey;
    const details = key.asymmetricKeyDetails ?? {};
    let keyType: string | null = null;
    switch (key.asymmetricKeyType) {
      case "rsa":
      case "rsa-pss":
        keyType = details.modulusLength ? `RSA ${details.modulusLength}` : "RSA";
        break;
      case "ec":
        keyType = `ECDSA ${details.namedCurve ? CURVES[details.namedCurve] ?? details.namedCurve : ""}`.trim();
        break;
      case "ed25519":
        keyType = "Ed25519";
        break;
      case "ed448":
        keyType = "Ed448";
        break;
      default:
        keyType = key.asymmetricKeyType ? String(key.asymmetricKeyType) : null;
    }
    const sans = (cert.subjectAltName ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry.startsWith("DNS:") ? entry.slice(4) : entry.startsWith("IP Address:") ? `IP ${entry.slice(11)}` : entry))
      .map((entry) => clean(entry, 253));
    return {
      subject: distinguishedName(cert.subject),
      issuer: distinguishedName(cert.issuer),
      sans,
      keyType,
      serialNumber: clean(cert.serialNumber, 128),
      fingerprintSha256: clean(cert.fingerprint256, 128),
      validFrom: new Date(cert.validFrom).toISOString(),
      validTo: new Date(cert.validTo).toISOString(),
    };
  } catch {
    return null;
  }
}

type ExpiryState = { status: string; daysLeft: number | null };

function expiryState(validTo: string | null, now: Date): ExpiryState {
  if (!validTo) return { status: "unknown", daysLeft: null };
  const ms = Date.parse(validTo) - now.getTime();
  const daysLeft = Math.floor(ms / DAY_MS);
  if (ms <= 0) return { status: "expired", daysLeft };
  if (daysLeft < EXPIRY_WARNING_DAYS) return { status: "expiring", daysLeft };
  return { status: "valid", daysLeft };
}

function hostLabel(host: { name: string; domains: string[]; enabled: boolean }): string {
  return `${clean(host.name, 120)} (${host.domains.slice(0, 5).map((domain) => clean(domain, 253)).join(", ")}${host.domains.length > 5 ? ", …" : ""})${host.enabled ? "" : " [disabled]"}`;
}

export async function buildCertificateInventory(context: BuildContext): Promise<BuiltReport> {
  const { now } = context;
  const [acme, dnsProviders] = await Promise.all([getAcmeSettings(), getDnsProviderSettings()]);
  let acmeIssuer = "Let's Encrypt (ACME)";
  const customCa = acme?.caUrl?.trim();
  if (customCa) {
    try {
      acmeIssuer = `Custom ACME CA (${new URL(customCa).host})`;
    } catch {
      acmeIssuer = "Custom ACME CA";
    }
  }
  const defaultChallenge = dnsProviders?.default ? `DNS-01 (${clean(dnsProviders.default, 64)})` : "HTTP-01 / TLS-ALPN-01";

  const hosts = (await appDb
    .select({ id: proxyHosts.id, name: proxyHosts.name, domains: proxyHosts.domains, certificateId: proxyHosts.certificateId, enabled: proxyHosts.enabled })
    .from(proxyHosts)
    .orderBy(asc(proxyHosts.name), asc(proxyHosts.id)))
    .map((host) => ({ ...host, domains: parseStringArray(host.domains) }));
  const certRows = await appDb.select().from(certificates).orderBy(asc(certificates.id));

  const findings: ReportFinding[] = [];
  const usage = new Map<number, string[]>();
  for (const host of hosts) {
    if (host.certificateId !== null) usage.set(host.certificateId, [...(usage.get(host.certificateId) ?? []), hostLabel(host)]);
  }

  // Imported certificates also serve hosts without a certificate whose names they cover (as on the Certificates page).
  const parsed = new Map<number, PemInfo | null>();
  for (const cert of certRows) parsed.set(cert.id, describePem(cert.certificatePem));
  const automaticHosts: typeof hosts = [];
  for (const host of hosts) {
    // Caddy requests no certificate for a disabled host.
    if (host.certificateId !== null || host.domains.length === 0 || !host.enabled) continue;
    const covering = certRows.find((cert) => {
      if (cert.type !== "imported") return false;
      const names = parsed.get(cert.id)?.sans.length ? parsed.get(cert.id)!.sans : parseStringArray(cert.domainNames);
      return host.domains.every((domain) => isDomainCoveredByCert(domain, names));
    });
    if (covering) usage.set(covering.id, [...(usage.get(covering.id) ?? []), `${hostLabel(host)} [covered by name]`]);
    else automaticHosts.push(host);
  }

  let expired = 0;
  let expiring = 0;
  const serverRows: Record<string, ReportCell>[] = [];
  for (const cert of certRows) {
    const info = parsed.get(cert.id) ?? null;
    const domains = parseStringArray(cert.domainNames).map((domain) => clean(domain, 253));
    const usedBy = usage.get(cert.id) ?? [];
    const imported = cert.type === "imported";
    const flags: string[] = [];
    let state: ExpiryState = { status: imported ? "unknown" : "managed by Caddy", daysLeft: null };
    if (info) state = expiryState(info.validTo, now);
    const label = `Certificate "${clean(cert.name, 120)}"`;
    if (imported && !info) {
      flags.push("unparseable");
      findings.push(finding("low", "certificate_unparseable", `certificate:${cert.id}`, `${label} is stored but could not be read as an X.509 certificate.`));
    }
    if (state.status === "expired") {
      expired += 1;
      flags.push("expired");
      findings.push(
        finding(usedBy.length > 0 ? "high" : "medium", "certificate_expired", `certificate:${cert.id}`, `${label} expired on ${info!.validTo.slice(0, 10)}${usedBy.length > 0 ? ` and is used by ${usedBy.length} host(s)` : ""}.`)
      );
    } else if (state.status === "expiring") {
      expiring += 1;
      flags.push("expiring");
      findings.push(finding("medium", "certificate_expiring", `certificate:${cert.id}`, `${label} expires on ${info!.validTo.slice(0, 10)} (in ${state.daysLeft} days).`));
    }
    if (usedBy.length === 0) {
      flags.push("unused");
      findings.push(
        finding(
          "info",
          "certificate_unused",
          `certificate:${cert.id}`,
          imported ? `${label} is not used by any proxy host.` : `${label} is not used by any proxy host, so Caddy does not request it.`
        )
      );
    }
    const providerOptions = (() => {
      try {
        const value = cert.providerOptions ? JSON.parse(cert.providerOptions) : null;
        return value && typeof value === "object" && typeof value.provider === "string" ? clean(value.provider, 64) : null;
      } catch {
        return null;
      }
    })();
    serverRows.push({
      kind: imported ? "imported" : "managed (ACME)",
      id: cert.id,
      name: clean(cert.name, 120),
      subject: info?.subject ?? null,
      issuer: info?.issuer ?? (imported ? null : acmeIssuer),
      names: info?.sans.length ? info.sans : domains,
      keyType: info?.keyType ?? (imported ? null : "chosen by Caddy"),
      serialNumber: info?.serialNumber ?? null,
      fingerprintSha256: info?.fingerprintSha256 ?? null,
      validFrom: info?.validFrom ?? null,
      validTo: info?.validTo ?? null,
      daysLeft: state.daysLeft,
      status: state.status,
      renewal: imported ? "manual (import a renewed certificate)" : `automatic, ${providerOptions ? `DNS-01 (${providerOptions})` : defaultChallenge}`,
      privateKeyStored: cert.privateKeyPem !== null && cert.privateKeyPem !== "",
      usedBy,
      flags,
    });
  }
  for (const host of automaticHosts) {
    serverRows.push({
      kind: "automatic HTTPS (ACME)",
      id: null,
      name: `Host "${clean(host.name, 120)}"`,
      subject: null,
      issuer: acmeIssuer,
      names: host.domains.map((domain) => clean(domain, 253)),
      keyType: "chosen by Caddy",
      serialNumber: null,
      fingerprintSha256: null,
      validFrom: null,
      validTo: null,
      daysLeft: null,
      status: "managed by Caddy",
      renewal: `automatic, ${defaultChallenge}`,
      privateKeyStored: false,
      usedBy: [hostLabel(host)],
      flags: [],
    });
  }

  const caRows = await appDb.select().from(caCertificates).orderBy(asc(caCertificates.id));
  const caNames = new Map(caRows.map((ca) => [ca.id, clean(ca.name, 120)]));
  const issued = await appDb.select().from(issuedClientCertificates).orderBy(asc(issuedClientCertificates.id));
  const caTable = caRows.map((ca) => {
    const info = describePem(ca.certificatePem);
    const state = info ? expiryState(info.validTo, now) : { status: "unknown", daysLeft: null };
    const flags: string[] = [];
    const children = issued.filter((cert) => cert.caCertificateId === ca.id);
    const label = `CA certificate "${clean(ca.name, 120)}"`;
    if (state.status === "expired") {
      expired += 1;
      flags.push("expired");
      findings.push(finding("high", "ca_certificate_expired", `ca_certificate:${ca.id}`, `${label} expired on ${info!.validTo.slice(0, 10)}; client certificates it issued no longer verify.`));
    } else if (state.status === "expiring") {
      expiring += 1;
      flags.push("expiring");
      findings.push(finding("medium", "ca_certificate_expiring", `ca_certificate:${ca.id}`, `${label} expires on ${info!.validTo.slice(0, 10)} (in ${state.daysLeft} days).`));
    }
    return {
      id: ca.id,
      name: clean(ca.name, 120),
      subject: info?.subject ?? null,
      issuer: info?.issuer ?? null,
      keyType: info?.keyType ?? null,
      serialNumber: info?.serialNumber ?? null,
      fingerprintSha256: info?.fingerprintSha256 ?? null,
      validFrom: info?.validFrom ?? null,
      validTo: info?.validTo ?? null,
      daysLeft: state.daysLeft,
      status: state.status,
      canIssue: ca.privateKeyPem !== null && ca.privateKeyPem !== "",
      issuedActive: children.filter((cert) => cert.revokedAt === null && Date.parse(cert.validTo) > now.getTime()).length,
      issuedRevoked: children.filter((cert) => cert.revokedAt !== null).length,
      flags,
    };
  });

  let clientExpired = 0;
  const clientTable = issued.map((cert) => {
    const info = describePem(cert.certificatePem);
    const revoked = cert.revokedAt !== null;
    const state = revoked ? { status: "revoked", daysLeft: null } : expiryState(iso(cert.validTo), now);
    const flags: string[] = [];
    if (!revoked && state.status === "expired") {
      clientExpired += 1;
      flags.push("expired");
    } else if (!revoked && state.status === "expiring") {
      flags.push("expiring");
      findings.push(
        finding("low", "client_certificate_expiring", `client_certificate:${cert.id}`, `Client certificate "${clean(cert.commonName, 120)}" expires on ${String(iso(cert.validTo)).slice(0, 10)} (in ${state.daysLeft} days).`)
      );
    }
    return {
      id: cert.id,
      commonName: clean(cert.commonName, 120),
      ca: caNames.get(cert.caCertificateId) ?? `CA #${cert.caCertificateId}`,
      keyType: info?.keyType ?? null,
      serialNumber: clean(cert.serialNumber, 128),
      fingerprintSha256: clean(cert.fingerprintSha256, 128),
      validFrom: iso(cert.validFrom),
      validTo: iso(cert.validTo),
      daysLeft: state.daysLeft,
      status: state.status,
      revokedAt: iso(cert.revokedAt),
      flags,
    };
  });
  if (clientExpired > 0) {
    findings.push(finding("info", "client_certificates_expired", "client_certificates", `${clientExpired} issued client certificate(s) have expired without being revoked; revoke them to keep the list clean.`));
  }

  const tlsL4 = (await appDb.select({ id: l4ProxyHosts.id }).from(l4ProxyHosts).where(eq(l4ProxyHosts.tlsTermination, true))).length;
  const changes = await auditEventsInPeriod(context.period, { entityTypes: CERTIFICATE_ENTITY_TYPES, limit: MAX_CERTIFICATE_CHANGES });
  const withPem = (await appDb.select({ id: certificates.id }).from(certificates).where(isNotNull(certificates.certificatePem))).length;

  return {
    summary: [
      summaryItem("serverCertificates", "TLS server certificates (imported and managed)", certRows.length),
      summaryItem("imported", "Imported certificates", certRows.filter((cert) => cert.type === "imported").length),
      summaryItem("managed", "Managed (ACME) certificates", certRows.filter((cert) => cert.type !== "imported").length),
      summaryItem("automaticHosts", "Hosts on automatic HTTPS", automaticHosts.length),
      summaryItem("caCertificates", "CA certificates", caRows.length),
      summaryItem("clientCertificates", "Issued client certificates", issued.length),
      summaryItem("activeClientCertificates", "Active client certificates", clientTable.filter((cert) => cert.status === "valid" || cert.status === "expiring").length),
      summaryItem("expired", "Expired server or CA certificates", expired),
      summaryItem("expiring", `Server or CA certificates expiring within ${EXPIRY_WARNING_DAYS} days`, expiring),
      summaryItem("acmeIssuer", "ACME certificate authority", acmeIssuer),
      summaryItem("certificateChangesInPeriod", "Certificate changes in the period", changes.total),
    ],
    findings: sortFindings(findings),
    sections: [
      section(
        "server_certificates",
        "TLS server certificates",
        "Imported certificates, certificates managed by Caddy through ACME, and hosts without a certificate, for which Caddy obtains one automatically.",
        columns([
          ["kind", "Kind"],
          ["id", "Id"],
          ["name", "Name"],
          ["subject", "Subject"],
          ["issuer", "Issuer"],
          ["names", "Subject alternative names / domains"],
          ["keyType", "Key type"],
          ["serialNumber", "Serial number"],
          ["fingerprintSha256", "SHA-256 fingerprint"],
          ["validFrom", "Valid from (UTC)"],
          ["validTo", "Valid to (UTC)"],
          ["daysLeft", "Days left"],
          ["status", "Status"],
          ["renewal", "Renewal"],
          ["privateKeyStored", "Private key stored"],
          ["usedBy", "Used by"],
          ["flags", "Flags"],
        ]),
        serverRows
      ),
      section(
        "ca_certificates",
        "CA certificates (mTLS)",
        "Certificate authorities trusted for client certificates. A CA whose private key is stored can issue client certificates here.",
        columns([
          ["id", "Id"],
          ["name", "Name"],
          ["subject", "Subject"],
          ["issuer", "Issuer"],
          ["keyType", "Key type"],
          ["serialNumber", "Serial number"],
          ["fingerprintSha256", "SHA-256 fingerprint"],
          ["validFrom", "Valid from (UTC)"],
          ["validTo", "Valid to (UTC)"],
          ["daysLeft", "Days left"],
          ["status", "Status"],
          ["canIssue", "Private key stored (can issue)"],
          ["issuedActive", "Active client certificates"],
          ["issuedRevoked", "Revoked client certificates"],
          ["flags", "Flags"],
        ]),
        caTable
      ),
      section(
        "client_certificates",
        "Issued client certificates",
        null,
        columns([
          ["id", "Id"],
          ["commonName", "Common name"],
          ["ca", "Issuing CA"],
          ["keyType", "Key type"],
          ["serialNumber", "Serial number"],
          ["fingerprintSha256", "SHA-256 fingerprint"],
          ["validFrom", "Valid from (UTC)"],
          ["validTo", "Valid to (UTC)"],
          ["daysLeft", "Days left"],
          ["status", "Status"],
          ["revokedAt", "Revoked (UTC)"],
          ["flags", "Flags"],
        ]),
        clientTable
      ),
      keyValueSection("acme", "Automatic certificates", "How Caddy obtains and renews managed certificates.", [
        ["Certificate authority", acmeIssuer],
        ["Default challenge", defaultChallenge],
        ["Certificates with their PEM stored in the dashboard", withPem],
        ["L4 hosts terminating TLS", tlsL4],
      ]),
      auditEventSection(
        "certificate_changes",
        "Certificate changes in the period",
        "Audit events about certificates, CA certificates, client certificates and mTLS roles.",
        changes,
        MAX_CERTIFICATE_CHANGES
      ),
    ],
    notes: [
      `Certificates are flagged as expiring when fewer than ${EXPIRY_WARNING_DAYS} days are left.`,
      "Certificates managed by Caddy (ACME and automatic HTTPS) are stored by Caddy, not by the dashboard, so their serial number, key type and expiry are not shown; Caddy renews them automatically before they expire (by default when a third of their lifetime is left).",
      "L4 hosts that terminate TLS use the certificates loaded in Caddy (those listed above).",
      "Private keys are never included. \"Private key stored\" only says whether the dashboard holds one (encrypted).",
    ],
  };
}
