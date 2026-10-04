import type {
  AcmeSettings,
  AuthentikSettings,
  DefaultResponseSettings,
  DnsSettings,
  ErrorPagesSettings,
  ForwardAuthSettings,
  GeneralSettings,
  GeoBlockSettings,
  LoggingSettings,
  MetricsSettings,
  RateLimitSettings,
  TrustedProxiesSettings,
  UpstreamDnsResolutionSettings,
} from "@/lib/settings";
import type { DnsProviderApiStatus, DnsProviderDefinition } from "@/src/lib/dns-providers";
import type { SyncKeyPin } from "@/src/lib/instance-sync-key-pins";
import type { OAuthProviderView } from "@/src/lib/oauth-provider-view";
import type { UsagePingView } from "@/src/lib/usage-ping/store";
import type { GeoIpDatabaseView } from "@/src/lib/geoip-status";
import type { PullReplicaView } from "@/ee/fleet/types";
import type { PullAgentStatus } from "@/ee/fleet/pull-agent";
import type { CertificateStorageView } from "@/ee/high-availability/types";
import type { ClusterView } from "@/ee/high-availability/cluster/types";
import type { SharedStateView } from "@/ee/high-availability/shared-state/types";
import type { BackupsSummaryView } from "@/ee/backups/ui/BackupsSummaryGroup";
import type { BrandingSummaryView } from "@/ee/white-label/ui/BrandingSummaryGroup";

export type SyncKeyPinView = Pick<SyncKeyPin, "keyId" | "publicKey" | "pinnedAt" | "source">;

export type SyncKeyPinTarget = { instanceId: number } | { slaveUrl: string };

export type InstanceSyncProps = {
  mode: "standalone" | "master" | "slave";
  modeFromEnv: boolean;
  tokenFromEnv: boolean;
  overrides: {
    general: boolean;
    acme: boolean;
    dnsProvider: boolean;
    authentik: boolean;
    forwardAuth: boolean;
    metrics: boolean;
    logging: boolean;
    dns: boolean;
    upstreamDnsResolution: boolean;
    trustedProxies: boolean;
    defaultResponse: boolean;
  };
  slave: {
    hasToken: boolean;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    /** This instance's own sync key id, which the master pins. */
    syncKeyId: string;
    /** This instance's own sync public key (raw X25519, base64). */
    syncPublicKey: string;
    /** Set on a pull replica (INSTANCE_SYNC_MODE=pull): it polls its master instead of being pushed to. */
    pull?: PullAgentStatus | null;
  } | null;
  master: {
    instances: Array<{
      id: number;
      name: string;
      baseUrl: string;
      /** "pull": a pull replica (ee/fleet), which has no URL and is not pushed to. */
      syncMode?: "push" | "pull";
      enabled: boolean;
      lastSyncAt: string | null;
      lastSyncError: string | null;
      syncKeyPin: SyncKeyPinView | null;
    }>;
    envInstances: Array<{
      name: string;
      url: string;
      /** Set in INSTANCE_SLAVES; sync checks it instead of the stored pin. */
      syncKeyId?: string;
      /** Set in INSTANCE_SLAVES; sync checks it instead of the stored pin. */
      syncPublicKey?: string;
      syncKeyPin: SyncKeyPinView | null;
    }>;
    /** Pins of URLs no instance or INSTANCE_SLAVES entry syncs to. */
    orphanSyncKeyPins: Array<SyncKeyPinView & { url: string }>;
    /** Pull replicas (ee/fleet); null without fleet:read. */
    pullReplicas?: {
      replicas: PullReplicaView[];
      canManage: boolean;
      configurable: boolean;
      editionLabel: string;
    } | null;
  } | null;
};

export type ReplicaInstanceView = NonNullable<InstanceSyncProps["master"]>["instances"][number];

/** ClickHouse as this install uses it, and its totals over the retention window. */
export type AnalyticsStatusView = {
  /** CLICKHOUSE_PASSWORD is set, so traffic analytics run. */
  enabled: boolean;
  retentionDays: number;
  /** CLICKHOUSE_RETENTION_DAYS is set (otherwise the default applies). */
  retentionFromEnv: boolean;
  /** Totals over the retention window; null without analytics:read, or when ClickHouse did not answer. */
  totals: { requests: number; wafEvents: number; bytes: number; uniqueAddresses: number } | null;
  /** Why the totals are missing although analytics run (ClickHouse unreachable or slow). */
  totalsError: string | null;
};

export type { BackupsSummaryView, BrandingSummaryView };

export type SettingsClientProps = {
  general: GeneralSettings | null;
  acme: AcmeSettings | null;
  dnsProvider: DnsProviderApiStatus | null;
  dnsProviderDefinitions: DnsProviderDefinition[];
  authentik: AuthentikSettings | null;
  forwardAuth: ForwardAuthSettings | null;
  metrics: MetricsSettings | null;
  logging: LoggingSettings | null;
  dns: DnsSettings | null;
  upstreamDnsResolution: UpstreamDnsResolutionSettings | null;
  trustedProxies: TrustedProxiesSettings | null;
  defaultResponse: DefaultResponseSettings | null;
  globalGeoBlock?: GeoBlockSettings | null;
  globalErrorPages?: ErrorPagesSettings | null;
  globalRateLimit?: RateLimitSettings | null;
  oauthProviders: OAuthProviderView[];
  baseUrl: string;
  usagePing: UsagePingView;
  /** settings:write: saving any group but instance sync. */
  canWriteSettings: boolean;
  /** instances:write: saving instance sync. Defaults to canWriteSettings. */
  canWriteInstances?: boolean;
  /** Group to open first (?section=), a group id or the old id of one of its cards. */
  initialSection?: string;
  /** Groups the user's role cannot see (custom roles without instances:read, sso:read or high_availability:read). */
  restricted?: { sync: boolean; oauth: boolean; certificateStorage?: boolean };
  /**
   * Certificate storage and shared state (ee/high-availability), which uses
   * the same Redis or Valkey; null without high_availability:read.
   */
  certificateStorage?: { view: CertificateStorageView; canWrite: boolean; editionLabel: string; sharedState?: SharedStateView } | null;
  /** The dashboard cluster (ee/high-availability/cluster); null without high_availability:read. */
  cluster?: { view: ClusterView; editionLabel: string } | null;
  instanceSync: InstanceSyncProps;
  /** GeoLite2 databases on this install. */
  geoip?: GeoIpDatabaseView[];
  analytics?: AnalyticsStatusView;
  backups?: BackupsSummaryView;
  branding?: BrandingSummaryView;
  /** Links shown to roles that can open their pages. */
  links?: { history: boolean; certificates: boolean; fleet: boolean };
};
