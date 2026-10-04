/**
 * The groups of the Settings page, in the order its group list shows them.
 * Shared by the page (app/(dashboard)/settings/SettingsClient.tsx, which adds
 * an icon per id) and the command palette's search (src/lib/search.ts).
 * `/settings?section=<id>` opens a group; the ids of the sections the page
 * had before its groups were merged keep working (SETTINGS_SECTION_ALIASES):
 * they open the group that took them in and scroll to their card.
 * Pure data, safe for the client.
 */
import type { Permission } from "./permissions";

export type SettingsSection = {
  id: string;
  name: string;
  desc: string;
  /** Other words people search for, on the page and in the command palette. */
  keywords: readonly string[];
  /** Needed on top of settings:read to see the group (the page shows a notice otherwise). */
  permission?: Permission;
  /** Listed on the page only: the command palette has its own entry for it. */
  paletteHidden?: boolean;
};

export type SettingsSectionGroup = {
  id: string;
  label: string;
  items: readonly SettingsSection[];
};

export const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroup[] = [
  {
    id: "system",
    label: "System",
    items: [
      {
        id: "general",
        name: "General",
        desc: "Primary domain, dashboard address and requests for unknown hosts",
        keywords: ["primary domain", "base url", "dashboard address", "default response", "unknown host", "catch-all", "direct ip", "404", "redirect", "abort", "444"],
      },
      {
        id: "acme",
        name: "Certificates and ACME",
        desc: "Let's Encrypt or your own CA, contact e-mail, DNS-01 providers and certificate storage",
        keywords: [
          "acme", "lets encrypt", "certificate authority", "directory", "step-ca", "internal ca", "pem", "contact email", "tls",
          "dns-01", "dns providers", "cloudflare", "route53", "hetzner", "wildcard", "resolvers", "nameserver", "challenge",
          "certificate storage", "redis", "valkey", "high availability", "cluster",
        ],
      },
      {
        id: "sync",
        name: "Instance sync",
        desc: "Standalone, master or replica",
        keywords: ["instance mode", "master", "replica", "slave", "instances", "sync token", "pull", "push", "nodes", "key pin"],
        permission: "instances:read",
      },
      {
        id: "high-availability",
        name: "High availability",
        desc: "The dashboard cluster and shared state: leader, standbys or PostgreSQL replicas, shared sessions and balances",
        keywords: [
          "high availability", "ha", "cluster", "leader", "standby", "failover", "lease", "litestream", "replication", "replica",
          "redis", "valkey", "s3", "object storage", "shared state", "forward auth sessions", "api balances",
          "postgresql", "postgres", "replicas", "nodes", "heartbeat",
        ],
        permission: "high_availability:read",
      },
      {
        id: "backups",
        name: "Backups",
        desc: "Scheduled, encrypted backups to your S3-compatible storage",
        keywords: ["backup", "s3", "restore", "schedule", "retention", "passphrase", "bucket"],
        permission: "backups:read",
      },
      {
        id: "usage-ping",
        name: "Usage ping",
        desc: "Anonymous usage statistics, off until an administrator says yes",
        keywords: ["usage", "telemetry", "statistics", "ping", "privacy", "anonymous", "install id"],
      },
    ],
  },
  {
    id: "networking",
    label: "Networking",
    items: [
      {
        id: "trusted-proxies",
        name: "Trusted proxies",
        desc: "The real client address behind a load balancer or CDN",
        keywords: ["proxy", "cloudflare", "real ip", "x-forwarded-for", "client ip", "cidr", "strict", "private_ranges"],
      },
      {
        id: "upstream-dns",
        name: "Upstream DNS pinning",
        desc: "Resolve upstream hostnames when the configuration is applied",
        keywords: ["upstream", "dns", "pinning", "resolve", "ipv4", "ipv6", "address family"],
      },
    ],
  },
  {
    id: "security",
    label: "Security defaults",
    items: [
      {
        id: "geoblock",
        name: "Geo blocking and GeoIP",
        desc: "GeoLite2 databases and default country rules",
        keywords: ["geo", "geoblock", "geoblocking", "country", "block", "geoip", "geolite2", "maxmind", "asn", "geoipupdate"],
      },
      {
        id: "rate-limit",
        name: "Rate limiting",
        desc: "Default request limits, and clients never limited",
        keywords: ["rate", "limit", "429", "throttle", "requests per minute", "exempt"],
      },
      {
        id: "error-pages",
        name: "Error pages",
        desc: "Fallback error responses for every host",
        keywords: ["error", "404", "502", "503", "504", "custom page", "html"],
      },
      {
        id: "forward-auth",
        name: "Forward auth defaults",
        desc: "Authentik and Authelia defaults for new proxy hosts",
        keywords: ["authentik", "authelia", "forward auth", "outpost", "sso"],
      },
      {
        id: "oauth",
        name: "OAuth providers",
        desc: "OpenID Connect providers for dashboard sign-in",
        keywords: ["oauth", "oidc", "openid", "sso", "sign-in", "provider"],
        permission: "sso:read",
      },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    items: [
      {
        id: "analytics",
        name: "Analytics and logs",
        desc: "ClickHouse retention, access log and Prometheus metrics",
        keywords: ["analytics", "clickhouse", "retention", "access log", "logging", "log", "json", "metrics", "prometheus", "monitoring", "port"],
      },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    items: [
      {
        id: "branding",
        name: "Branding",
        desc: "Product name, logos, colours and sign-in texts for your clients",
        keywords: ["branding", "white label", "white-label", "logo", "colours", "colors", "favicon"],
        paletteHidden: true,
      },
    ],
  },
];

/**
 * Cards inside a group that the command palette also finds on their own (the
 * sections the page had before), by their old ids. Each opens its group and
 * scrolls to the card whose element id is `anchor`.
 */
export type SettingsSectionAlias = {
  id: string;
  /** The group that holds the card. */
  section: string;
  /** Element id of the card. */
  anchor: string;
  name: string;
  desc: string;
  keywords: readonly string[];
  permission?: Permission;
};

export const SETTINGS_SECTION_ALIASES: readonly SettingsSectionAlias[] = [
  {
    id: "default-response",
    section: "general",
    anchor: "settings-unknown-hosts",
    name: "Requests for unknown hosts",
    desc: "The answer when no proxy host matches",
    keywords: ["default response", "unknown", "fallback", "direct ip", "catch-all"],
  },
  {
    id: "dns-providers",
    section: "acme",
    anchor: "settings-dns-providers",
    name: "DNS-01 providers",
    desc: "Provider credentials for ACME DNS-01",
    keywords: ["dns", "dns providers", "acme", "dns-01", "cloudflare", "route53", "wildcard"],
  },
  {
    id: "dns-resolvers",
    section: "acme",
    anchor: "settings-dns-resolvers",
    name: "DNS-01 resolvers",
    desc: "Your own resolvers for the DNS-01 check",
    keywords: ["dns", "dns resolvers", "resolver", "nameserver"],
  },
  {
    id: "certificate-storage",
    section: "acme",
    anchor: "settings-certificate-storage",
    name: "Certificate storage",
    desc: "Where Caddy nodes keep certificates: local, or shared Redis or Valkey",
    keywords: ["redis", "valkey", "storage", "high availability", "cluster"],
    permission: "high_availability:read",
  },
  {
    id: "shared-state",
    section: "high-availability",
    anchor: "settings-shared-state",
    name: "Shared state",
    desc: "Forward-auth sessions and API balances in Redis or Valkey for every web node",
    keywords: ["redis", "valkey", "high availability", "sessions", "balances", "standby", "leader"],
    permission: "high_availability:read",
  },
  {
    id: "authentik",
    section: "forward-auth",
    anchor: "settings-authentik",
    name: "Authentik defaults",
    desc: "Forward auth defaults for new proxy hosts",
    keywords: ["authentik", "forward auth", "outpost"],
  },
  {
    id: "metrics",
    section: "analytics",
    anchor: "settings-metrics",
    name: "Prometheus metrics",
    desc: "The metrics endpoint on its own port",
    keywords: ["metrics", "prometheus", "monitoring"],
  },
  {
    id: "logging",
    section: "analytics",
    anchor: "settings-access-log",
    name: "Access log",
    desc: "The HTTP access log of proxied requests",
    keywords: ["log", "access log", "logging"],
  },
];

type ListedSection = SettingsSection & { groupId: string; groupLabel: string };

const GROUP_SECTIONS: readonly ListedSection[] = SETTINGS_SECTION_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, groupId: group.id, groupLabel: group.label }))
);

/**
 * What the command palette lists: every group, then the cards it finds on
 * their own, labelled with the group that holds them.
 */
export const SETTINGS_SECTIONS: readonly ListedSection[] = [
  ...GROUP_SECTIONS.filter((section) => !section.paletteHidden),
  ...SETTINGS_SECTION_ALIASES.map((alias) => {
    const parent = GROUP_SECTIONS.find((section) => section.id === alias.section);
    return {
      id: alias.id,
      name: alias.name,
      desc: alias.desc,
      keywords: alias.keywords,
      permission: alias.permission ?? parent?.permission,
      groupId: parent?.groupId ?? "system",
      groupLabel: parent?.name ?? "Settings",
    };
  }),
];

/** A group of the page by its id. */
export function findSettingsSection(id: string): ListedSection | undefined {
  return GROUP_SECTIONS.find((section) => section.id === id);
}

/**
 * The group `id` opens (a group id, or the old id of a card), with the card
 * to scroll to; null for ids the page does not know.
 */
export function resolveSettingsSection(id: string): { section: ListedSection; anchor: string | null } | null {
  const section = findSettingsSection(id);
  if (section) return { section, anchor: null };
  const alias = SETTINGS_SECTION_ALIASES.find((entry) => entry.id === id);
  if (!alias) return null;
  const parent = findSettingsSection(alias.section);
  return parent ? { section: parent, anchor: alias.anchor } : null;
}

export function settingsSectionHref(id: string): string {
  return `/settings?section=${encodeURIComponent(id)}`;
}
