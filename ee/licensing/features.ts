// SPDX-License-Identifier: Elastic-2.0
/**
 * Paid features and the editions that include them.
 *
 * Everything that is not listed here is Community and is never gated. A
 * feature listed here only gates *new* functionality: nothing that shipped
 * free before the paid editions existed may be moved behind a license.
 */

export const EDITIONS = ["homelab", "business", "enterprise", "msp"] as const;
export type Edition = (typeof EDITIONS)[number];

export const FEATURES = [
  "sso_saml",
  "sso_enforce",
  "custom_roles",
  "audit_streaming",
  "alerting",
  "config_history",
  "scheduled_backups",
  "ai_analyst",
  "approvals",
  "compliance_reports",
  "scim",
  "access_reviews",
  "ldap",
  "fleet",
  "high_availability",
  "air_gap",
  "multi_tenancy",
  "white_label",
  "api_monetization",
  "virtual_patching",
] as const;
export type Feature = (typeof FEATURES)[number];

export type FeatureInfo = {
  label: string;
  description: string;
  /** Cheapest edition that includes the feature. */
  edition: Edition;
  /** False while the feature is on the roadmap but not shipped yet. */
  available: boolean;
};

export const FEATURE_INFO: Record<Feature, FeatureInfo> = {
  sso_saml: {
    label: "SAML single sign-on",
    description: "Sign in to the dashboard through a SAML 2.0 identity provider, with group-to-role mapping.",
    edition: "business",
    available: true,
  },
  sso_enforce: {
    label: "Enforced SSO",
    description: "Turn off password sign-in for everyone except named break-glass accounts.",
    edition: "business",
    available: true,
  },
  custom_roles: {
    label: "Custom roles",
    description: "Roles with fine-grained permissions, scoped to tagged hosts so teams can share one install.",
    edition: "business",
    available: true,
  },
  audit_streaming: {
    label: "Audit streaming and export",
    description: "Stream the audit log to a SIEM (syslog, webhook, Splunk HEC), export it, set retention and verify its hash chain.",
    edition: "business",
    available: true,
  },
  alerting: {
    label: "Alerting",
    description: "Alerts for certificates, upstreams, WAF spikes and sync failures to e-mail, Slack, Teams, PagerDuty, ntfy or a webhook.",
    edition: "homelab",
    available: true,
  },
  config_history: {
    label: "Configuration history and rollback",
    description: "A snapshot of the configuration on every change, with diffs and one-click rollback.",
    edition: "homelab",
    available: true,
  },
  scheduled_backups: {
    label: "Scheduled backups",
    description: "Encrypted configuration backups to your own S3-compatible storage on a schedule.",
    edition: "business",
    available: true,
  },
  ai_analyst: {
    label: "AI analyst",
    description: "Plain-language alert explanations, a daily security digest and WAF tuning suggestions, using your own model.",
    edition: "homelab",
    available: true,
  },
  approvals: {
    label: "Change approvals",
    description: "Four-eyes approval for changes to protected hosts, and change windows.",
    edition: "enterprise",
    available: true,
  },
  compliance_reports: {
    label: "Compliance reports",
    description: "Access reviews, change logs, certificate inventory and WAF/MFA coverage mapped to NIS2 and ISO 27001, and NIS2 incident notification drafts.",
    edition: "enterprise",
    available: true,
  },
  scim: {
    label: "SCIM provisioning",
    description: "Create, update and disable users and groups from your identity provider (Microsoft Entra ID, Okta and other SCIM 2.0 clients).",
    edition: "enterprise",
    available: true,
  },
  access_reviews: {
    label: "Access reviews",
    description: "Periodic access recertification: reviewers keep or revoke each user's roles, groups and API tokens, with a downloadable record.",
    edition: "enterprise",
    available: true,
  },
  ldap: {
    label: "LDAP / Active Directory",
    description: "Dashboard sign-in with LDAP or Active Directory accounts, with group-to-role mapping.",
    edition: "enterprise",
    available: true,
  },
  fleet: {
    label: "Fleet management",
    description: "Manage many nodes: environments, promotion, drift detection and canary rollout.",
    edition: "enterprise",
    available: true,
  },
  high_availability: {
    label: "High availability",
    description:
      "Shared certificate storage for Caddy nodes (Redis or Valkey): each certificate is ordered once and every node serves it. " +
      "A dashboard cluster: one leader and warm standbys, SQLite streamed to object storage with Litestream, automatic failover. " +
      "Shared state: forward-auth sessions and API balances in the same Redis or Valkey, so every web node serves them alike. " +
      "PostgreSQL replicas: several dashboard containers on one PostgreSQL database, each serving every request, one running the background jobs.",
    edition: "enterprise",
    available: true,
  },
  air_gap: {
    label: "Air-gapped installs",
    description: "Offline install bundle for hosts without Internet access. Long-term-support releases are planned, not announced yet.",
    edition: "enterprise",
    available: true,
  },
  multi_tenancy: {
    label: "Multi-tenancy",
    description: "Isolated organizations with their own admins, hosts and usage reports.",
    edition: "msp",
    available: true,
  },
  white_label: {
    label: "White-label",
    description: "Your own product name, logos, favicon, colours, sign-in texts and e-mail sender name, for your clients to see.",
    edition: "msp",
    available: true,
  },
  api_monetization: {
    label: "API monetization",
    description:
      "Charge your API's consumers per request through your Stripe account, enforced at the edge: prepaid, postpaid with a hard cap, or x402 through Stripe machine payments.",
    edition: "enterprise",
    available: true,
  },
  virtual_patching: {
    label: "Virtual patching",
    description: "WAF rules for newly published CVEs from a signed feed, fetched daily or imported offline, each in detection or blocking mode.",
    edition: "enterprise",
    // Coming soon: the code ships switched off (ee/docs/virtual-patching.md).
    available: false,
  },
};

const HOMELAB: readonly Feature[] = ["alerting", "config_history", "ai_analyst"];

const BUSINESS: readonly Feature[] = [
  ...HOMELAB,
  "sso_saml",
  "sso_enforce",
  "custom_roles",
  "audit_streaming",
  "scheduled_backups",
];

const ENTERPRISE: readonly Feature[] = [
  ...BUSINESS,
  "approvals",
  "compliance_reports",
  "scim",
  "access_reviews",
  "ldap",
  "fleet",
  "high_availability",
  "air_gap",
  "api_monetization",
  "virtual_patching",
];

const MSP: readonly Feature[] = [...BUSINESS, "multi_tenancy", "white_label"];

export const EDITION_FEATURES: Record<Edition, readonly Feature[]> = {
  homelab: HOMELAB,
  business: BUSINESS,
  enterprise: ENTERPRISE,
  msp: MSP,
};

export const EDITION_LABELS: Record<Edition, string> = {
  homelab: "Homelab",
  business: "Business",
  enterprise: "Enterprise",
  msp: "MSP",
};

/** Features switched on or off by tests (setFeatureAvailableForTests). */
const availabilityOverrides = new Map<Feature, boolean>();

/**
 * Whether the feature ships in this release (FEATURE_INFO `available`). A
 * feature that does not cannot be set up, whatever the license: the License
 * page lists it as coming soon and requireFeature refuses it.
 */
export function isFeatureAvailable(feature: Feature): boolean {
  return availabilityOverrides.get(feature) ?? FEATURE_INFO[feature].available;
}

/** Lets tests run the code of a feature that is not available yet; null restores FEATURE_INFO. Refused outside tests. */
export function setFeatureAvailableForTests(feature: Feature, available: boolean | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Feature availability can only be changed in tests");
  }
  if (available === null) availabilityOverrides.delete(feature);
  else availabilityOverrides.set(feature, available);
}

export function isEdition(value: unknown): value is Edition {
  return typeof value === "string" && (EDITIONS as readonly string[]).includes(value);
}

export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && (FEATURES as readonly string[]).includes(value);
}
