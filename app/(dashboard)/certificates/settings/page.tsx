import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getAcmeSettings, getDnsProviderSettings, getDnsSettings, getGeneralSettings } from "@/src/lib/settings";
import { DNS_PROVIDERS, redactDnsProviderSettingsForApi } from "@/src/lib/dns-providers";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { getCertificateStorageView } from "@/ee/high-availability/service";
import { loadReplicaOverrides } from "../../settings/load";
import CertificateSettingsClient from "./CertificateSettingsClient";

export const metadata = { title: "Certificate settings" };

export default async function CertificateSettingsPage() {
  const { access } = await requirePermission("settings:read");
  // Certificate storage is its own permission area (ee/high-availability).
  const canStorage = can(access, "high_availability:read");
  const [acme, general, dnsProvider, dns, replica, storageView] = await Promise.all([
    getAcmeSettings(),
    getGeneralSettings(),
    getDnsProviderSettings(),
    getDnsSettings(),
    loadReplicaOverrides({ general: "general", acme: "acme", dnsProvider: "dns_provider", dns: "dns" }),
    canStorage ? getCertificateStorageView() : Promise.resolve(null),
  ]);

  return (
    <CertificateSettingsClient
      acme={acme}
      general={general}
      dnsProvider={dnsProvider ? redactDnsProviderSettingsForApi(dnsProvider) : null}
      dnsProviderDefinitions={DNS_PROVIDERS}
      dns={dns}
      isSlave={replica.isSlave}
      overrides={replica.overrides}
      certificateStorage={
        storageView
          ? {
              view: storageView,
              canWrite: can(access, "high_availability:write"),
              editionLabel: EDITION_LABELS[FEATURE_INFO.high_availability.edition],
            }
          : null
      }
      canSave={can(access, "settings:write")}
      canOpenCertificates={can(access, "certificates:read")}
    />
  );
}
