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
] as const;
export type Feature = (typeof FEATURES)[number];

export type FeatureInfo = {
  label: string;
  description: string;
  /** Cheapest edition that includes the feature. */
  edition: Edition;
};

export const FEATURE_INFO: Record<Feature, FeatureInfo> = {
  sso_saml: {
    label: "SAML single sign-on",
    description: "Sign in to the dashboard through a SAML 2.0 identity provider, with group-to-role mapping.",
    edition: "business",
  },
  sso_enforce: {
    label: "Enforced SSO",
    description: "Turn off password sign-in for everyone except named break-glass accounts.",
    edition: "business",
  },
  custom_roles: {
    label: "Custom roles",
    description: "Roles with fine-grained permissions, scoped to tagged hosts so teams can share one install.",
    edition: "business",
  },
  audit_streaming: {
    label: "Audit streaming and export",
    description: "Stream the audit log to a SIEM (syslog, webhook, Splunk HEC), export it, set retention and verify its hash chain.",
    edition: "business",
  },
  alerting: {
    label: "Alerting",
    description: "Alerts for certificates, upstreams, WAF spikes and sync failures to e-mail, Slack, Teams, PagerDuty, ntfy or a webhook.",
    edition: "homelab",
  },
  config_history: {
    label: "Configuration history and rollback",
    description: "A snapshot of the configuration on every change, with diffs and one-click rollback.",
    edition: "homelab",
  },
  scheduled_backups: {
    label: "Scheduled backups",
    description: "Encrypted configuration backups to your own S3-compatible storage on a schedule.",
    edition: "business",
  },
  ai_analyst: {
    label: "AI analyst",
    description: "Plain-language alert explanations, a daily security digest and WAF tuning suggestions, using your own model.",
    edition: "homelab",
  },
  approvals: {
    label: "Change approvals",
    description: "Four-eyes approval for changes to protected hosts, and change windows.",
    edition: "enterprise",
  },
  compliance_reports: {
    label: "Compliance reports",
    description: "Access reviews, change logs, certificate inventory and WAF/MFA coverage mapped to NIS2 and ISO 27001, and NIS2 incident notification drafts.",
    edition: "enterprise",
  },
  scim: {
    label: "SCIM provisioning",
    description: "Create, update and disable users and groups from your identity provider (Microsoft Entra ID, Okta and other SCIM 2.0 clients).",
    edition: "enterprise",
  },
  access_reviews: {
    label: "Access reviews",
    description: "Periodic access recertification: reviewers keep or revoke each user's roles, groups and API tokens, with a downloadable record.",
    edition: "enterprise",
  },
  ldap: {
    label: "LDAP / Active Directory",
    description: "Dashboard sign-in with LDAP or Active Directory accounts, with group-to-role mapping.",
    edition: "enterprise",
  },
  fleet: {
    label: "Fleet management",
    description: "Manage many nodes: environments, promotion, drift detection and canary rollout.",
    edition: "enterprise",
  },
  high_availability: {
    label: "High availability",
    description:
      "Shared certificate storage for Caddy nodes (Redis or Valkey): each certificate is ordered once and every node serves it. " +
      "A dashboard cluster: one leader and warm standbys, SQLite streamed to object storage with Litestream, automatic failover. " +
      "Shared state: forward-auth sessions and API balances in the same Redis or Valkey, so every web node serves them alike. " +
      "PostgreSQL replicas: several dashboard containers on one PostgreSQL database, each serving every request, one running the background jobs.",
    edition: "enterprise",
  },
  air_gap: {
    label: "Air-gapped installs",
    description: "Offline install bundle for hosts without Internet access. Long-term-support releases are planned, not announced yet.",
    edition: "enterprise",
  },
  multi_tenancy: {
    label: "Multi-tenancy",
    description: "Isolated organizations with their own admins, hosts and usage reports.",
    edition: "msp",
  },
  white_label: {
    label: "White-label",
    description: "Your own product name, logos, favicon, colours, sign-in texts and e-mail sender name, for your clients to see.",
    edition: "msp",
  },
  api_monetization: {
    label: "API monetization",
    description:
      "Charge your API's consumers per request through your Stripe account, enforced at the edge: prepaid, postpaid with a hard cap, or x402 through Stripe machine payments.",
    edition: "enterprise",
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

export function isEdition(value: unknown): value is Edition {
  return typeof value === "string" && (EDITIONS as readonly string[]).includes(value);
}

export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && (FEATURES as readonly string[]).includes(value);
}
