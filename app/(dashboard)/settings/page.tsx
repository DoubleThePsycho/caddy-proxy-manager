import SettingsClient from "./SettingsClient";
import { getGeneralSettings, getAcmeSettings, getAuthentikSettings, getForwardAuthSettings, getMetricsSettings, getLoggingSettings, getDnsSettings, getDnsProviderSettings, getSetting, getUpstreamDnsResolutionSettings, getGeoBlockSettings, getErrorPagesSettings, getTrustedProxiesSettings, getDefaultResponseSettings, getRateLimitSettings } from "@/src/lib/settings";
import { getInstanceMode, getSlaveLastSync, getSlaveMasterToken, isInstanceModeFromEnv, isSyncTokenFromEnv, getEnvSlaveInstances } from "@/src/lib/instance-sync";
import { toEnvSlaveInstanceView } from "@/src/lib/instance-sync-view";
import { listInstances, listSyncKeyPinsWithSlaves, withSyncKeyPins } from "@/src/lib/models/instances";
import { getSyncPublicKey } from "@/src/lib/sync-crypto";
import { listOAuthProviders } from "@/src/lib/models/oauth-providers";
import { DNS_PROVIDERS } from "@/src/lib/dns-providers";
import { config } from "@/src/lib/config";
import { requirePermission } from "@/src/lib/auth";
import { can, tenantOf, type Access } from "@/src/lib/permissions";
import { redactDnsProviderSettingsForApi } from "@/src/lib/dns-providers";
import { getUsagePingView } from "@/src/lib/usage-ping/store";
import { isPullReplicaMode } from "@/ee/fleet/pull-config";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listPullReplicas } from "@/ee/fleet/pull-replicas";
import { getPullAgentStatus } from "@/ee/fleet/pull-agent";
import { FEATURE as FLEET_FEATURE } from "@/ee/fleet/types";
import { getCertificateStorageView } from "@/ee/high-availability/service";
import { getClusterView } from "@/ee/high-availability/cluster/view";
import { getSharedStateView } from "@/ee/high-availability/shared-state/service";
import { getGeoIpDatabases } from "@/src/lib/geoip-status";
import { getRetentionDays, isAnalyticsEnabled, querySummary, queryWafCount } from "@/src/lib/clickhouse/client";
import { listBackupDestinations } from "@/ee/backups/destinations";
import { FEATURE as BACKUPS_FEATURE } from "@/ee/backups/types";
import type { AnalyticsStatusView, BackupsSummaryView, BrandingSummaryView } from "./types";

/** How long the page waits for ClickHouse's totals before showing it without them. */
const ANALYTICS_TOTALS_TIMEOUT_MS = 2500;

/**
 * ClickHouse as configured by the environment, with traffic totals over the
 * retention window for roles that may read analytics across every host.
 */
async function analyticsStatus(access: Access): Promise<AnalyticsStatusView> {
  const enabled = isAnalyticsEnabled();
  const retentionDays = getRetentionDays();
  const view: AnalyticsStatusView = {
    enabled,
    retentionDays,
    retentionFromEnv: Boolean(process.env.CLICKHOUSE_RETENTION_DAYS?.trim()),
    totals: null,
    totalsError: null,
  };
  // Instance-wide totals: never for organisation users, whose analytics are limited to their own hosts.
  if (!enabled || !can(access, "analytics:read") || tenantOf(access) !== null) return view;
  const to = Math.floor(Date.now() / 1000);
  const from = to - retentionDays * 86_400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [summary, wafEvents] = await Promise.race([
      Promise.all([querySummary(from, to, []), queryWafCount(from, to)]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ANALYTICS_TOTALS_TIMEOUT_MS);
      }),
    ]);
    view.totals = { requests: summary.totalRequests, wafEvents, bytes: summary.bytesServed, uniqueAddresses: summary.uniqueIps };
  } catch (error) {
    view.totalsError =
      error instanceof Error && error.message === "timeout" ? "Did not answer within a few seconds" : "Not reachable from the dashboard";
  } finally {
    if (timer) clearTimeout(timer);
  }
  return view;
}

export default async function SettingsPage({
  searchParams,
}: { searchParams?: Promise<{ section?: string | string[] }> } = {}) {
  const { access } = await requirePermission("settings:read");
  const section = (await searchParams)?.section;
  // Instance sync, OAuth providers and certificate storage are their own permission areas.
  const canSync = can(access, "instances:read");
  const canOauth = can(access, "sso:read");
  const canCertificateStorage = can(access, "high_availability:read");
  const canBackups = can(access, "backups:read");

  // Check if configuration is from environment variables
  const modeFromEnv = isInstanceModeFromEnv();
  const tokenFromEnv = isSyncTokenFromEnv();

  const [general, acme, dnsProvider, authentik, forwardAuth, metrics, logging, dns, upstreamDnsResolution, instanceMode, globalGeoBlock, globalErrorPages, trustedProxies, defaultResponse, oauthProviders, globalRateLimit] = await Promise.all([
    getGeneralSettings(),
    getAcmeSettings(),
    getDnsProviderSettings(),
    getAuthentikSettings(),
    getForwardAuthSettings(),
    getMetricsSettings(),
    getLoggingSettings(),
    getDnsSettings(),
    getUpstreamDnsResolutionSettings(),
    getInstanceMode(),
    getGeoBlockSettings(),
    getErrorPagesSettings(),
    getTrustedProxiesSettings(),
    getDefaultResponseSettings(),
    canOauth ? listOAuthProviders() : Promise.resolve([]),
    getRateLimitSettings(),
  ]);
  const [usagePing, analytics, backupDestinations, backupsConfigurable, brandingLicensed] = await Promise.all([
    getUsagePingView(),
    analyticsStatus(access),
    canBackups ? listBackupDestinations() : Promise.resolve([]),
    isFeatureConfigurable(BACKUPS_FEATURE),
    isFeatureConfigurable("white_label"),
  ]);
  // Destination views carry no secrets (hasSecretAccessKey / hasPassphrase only).
  const backups: BackupsSummaryView = {
    allowed: canBackups,
    configurable: backupsConfigurable,
    editionLabel: EDITION_LABELS[FEATURE_INFO[BACKUPS_FEATURE].edition],
    destinations: backupDestinations,
  };
  const branding: BrandingSummaryView = {
    licensed: brandingLicensed,
    canRead: can(access, "branding:read"),
    editionLabel: EDITION_LABELS[FEATURE_INFO.white_label.edition],
  };
  const certificateStorage = canCertificateStorage
    ? {
        view: await getCertificateStorageView(),
        canWrite: can(access, "high_availability:write"),
        editionLabel: EDITION_LABELS[FEATURE_INFO.high_availability.edition],
        sharedState: await getSharedStateView(),
      }
    : null;
  const cluster = canCertificateStorage
    ? { view: await getClusterView(), editionLabel: EDITION_LABELS[FEATURE_INFO.high_availability.edition] }
    : null;

  const [overrideGeneral, overrideAcme, overrideDnsProvider, overrideAuthentik, overrideForwardAuth, overrideMetrics, overrideLogging, overrideDns, overrideUpstreamDnsResolution, overrideTrustedProxies, overrideDefaultResponse] =
    instanceMode === "slave"
      ? await Promise.all([
          getSetting("general"),
          getSetting("acme"),
          getSetting("dns_provider"),
          getSetting("authentik"),
          getSetting("forward_auth"),
          getSetting("metrics"),
          getSetting("logging"),
          getSetting("dns"),
          getSetting("upstream_dns_resolution"),
          getSetting("trusted_proxies"),
          getSetting("default_response")
        ])
      : [null, null, null, null, null, null, null, null, null, null, null];

  const [slaveToken, slaveLastSync] = instanceMode === "slave" && canSync
    ? await Promise.all([getSlaveMasterToken(), getSlaveLastSync()])
    : [null, null];

  const instances = instanceMode === "master" && canSync ? await listInstances() : [];
  const envInstances = instanceMode === "master" && canSync
    ? await withSyncKeyPins(getEnvSlaveInstances().map(toEnvSlaveInstanceView))
    : [];
  // Pins of URLs no slave syncs to any more (for example an INSTANCE_SLAVES
  // entry that was removed); a slave added at such a URL inherits the pin.
  const orphanSyncKeyPins = instanceMode === "master" && canSync
    ? (await listSyncKeyPinsWithSlaves())
      .filter((pin) => pin.slaves.length === 0)
      .map(({ url, keyId, publicKey, pinnedAt, source }) => ({ url, keyId, publicKey, pinnedAt, source }))
    : [];
  // Set exactly in slave mode.
  const ownSyncKey = instanceMode === "slave" && canSync ? getSyncPublicKey() : null;
  // Pull replicas (ee/fleet): listed with fleet:read, managed with fleet:replicas.
  // Shown when there are some, or the license allows adding them.
  let pullReplicas: { replicas: Awaited<ReturnType<typeof listPullReplicas>>; canManage: boolean; configurable: boolean; editionLabel: string } | undefined;
  if (instanceMode === "master" && canSync && can(access, "fleet:read")) {
    const [replicas, configurable] = await Promise.all([listPullReplicas(), isFeatureConfigurable(FLEET_FEATURE)]);
    if (replicas.length > 0 || configurable) {
      pullReplicas = {
        replicas,
        canManage: can(access, "fleet:replicas"),
        configurable,
        editionLabel: EDITION_LABELS[FEATURE_INFO[FLEET_FEATURE].edition],
      };
    }
  }

  return (
    <SettingsClient
      general={general}
      acme={acme}
      dnsProvider={dnsProvider ? redactDnsProviderSettingsForApi(dnsProvider) : null}
      dnsProviderDefinitions={DNS_PROVIDERS}
      authentik={authentik}
      forwardAuth={forwardAuth}
      metrics={metrics}
      logging={logging}
      dns={dns}
      upstreamDnsResolution={upstreamDnsResolution}
      trustedProxies={trustedProxies}
      defaultResponse={defaultResponse}
      globalGeoBlock={globalGeoBlock}
      globalErrorPages={globalErrorPages}
      globalRateLimit={globalRateLimit}
      oauthProviders={oauthProviders}
      baseUrl={config.baseUrl}
      usagePing={usagePing}
      canWriteSettings={can(access, "settings:write")}
      canWriteInstances={can(access, "instances:write")}
      geoip={getGeoIpDatabases()}
      analytics={analytics}
      backups={backups}
      branding={branding}
      links={{
        history: can(access, "config_history:read"),
        certificates: can(access, "certificates:read"),
        fleet: can(access, "fleet:read"),
      }}
      initialSection={typeof section === "string" ? section : undefined}
      restricted={{ sync: !canSync, oauth: !canOauth, certificateStorage: !canCertificateStorage }}
      certificateStorage={certificateStorage}
      cluster={cluster}
      instanceSync={{
        mode: instanceMode,
        modeFromEnv,
        tokenFromEnv,
        overrides: {
          general: overrideGeneral !== null,
          acme: overrideAcme !== null,
          dnsProvider: overrideDnsProvider !== null,
          authentik: overrideAuthentik !== null,
          forwardAuth: overrideForwardAuth !== null,
          metrics: overrideMetrics !== null,
          logging: overrideLogging !== null,
          dns: overrideDns !== null,
          upstreamDnsResolution: overrideUpstreamDnsResolution !== null,
          trustedProxies: overrideTrustedProxies !== null,
          defaultResponse: overrideDefaultResponse !== null
        },
        slave: ownSyncKey ? {
          hasToken: Boolean(slaveToken),
          lastSyncAt: slaveLastSync?.at ?? null,
          lastSyncError: slaveLastSync?.error ?? null,
          syncKeyId: ownSyncKey.keyId,
          syncPublicKey: ownSyncKey.publicKey.toString("base64"),
          pull: isPullReplicaMode() ? getPullAgentStatus() : null
        } : null,
        master: instanceMode === "master" && canSync
          ? { instances, envInstances, orphanSyncKeyPins, ...(pullReplicas ? { pullReplicas } : {}) }
          : null
      }}
    />
  );
}
