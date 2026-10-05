// SPDX-License-Identifier: Elastic-2.0
/**
 * The open-core boundary (ee/README.md, "Where paid code lives"). Every line
 * of paid functionality lives under ee/ (Elastic License 2.0); everything
 * else is MIT. Next.js only finds pages and route handlers under app/, so a
 * paid page or route keeps a file there that only re-exports its
 * implementation from ee/ (a shim: `export { GET, POST } from "@/ee/…"`, or
 * `export { default, metadata } from "@/ee/…"`, plus literal segment config
 * such as `export const dynamic = "force-dynamic"`, which Next.js reads from
 * the route file itself).
 *
 * tests/unit/license-boundary.test.ts checks that every file under the
 * prefixes below is such a shim, that every source file under ee/ carries the
 * Elastic-2.0 SPDX header, and that core code outside app/ that imports ee/
 * is listed in CORE_EE_HOOKS.
 */
import type { Feature } from "./licensing/features";

export type PaidRouteGroup = {
  /** The ee/ module the files route to. */
  module: string;
  /** The paid features it implements; none for the License page and API, which manage the key itself. */
  features: readonly Feature[];
  /** Files, or directories ending in "/", under app/ that only route to `module`. */
  prefixes: readonly string[];
};

export const PAID_ROUTES: readonly PaidRouteGroup[] = [
  {
    module: "ee/access-reviews",
    features: ["access_reviews"],
    prefixes: [
      "app/(dashboard)/access-reviews/",
      "app/(dashboard)/my-reviews/",
      "app/api/v1/access-review-assignments/",
      "app/api/v1/access-review-schedules/",
      "app/api/v1/access-reviews/",
    ],
  },
  {
    module: "ee/ai",
    features: ["ai_analyst"],
    prefixes: ["app/api/v1/ai/", "app/api/v1/analytics/questions/", "app/api/v1/waf/tuning-suggestions/"],
  },
  {
    module: "ee/alerting",
    features: ["alerting"],
    prefixes: ["app/(dashboard)/alerts/", "app/api/v1/alert-channels/", "app/api/v1/alert-events/", "app/api/v1/alert-rules/"],
  },
  {
    module: "ee/approvals",
    features: ["approvals"],
    prefixes: ["app/(dashboard)/approvals/", "app/api/v1/approval-policies/", "app/api/v1/change-requests/"],
  },
  {
    module: "ee/audit",
    features: ["audit_streaming"],
    prefixes: [
      "app/(dashboard)/audit-log/streaming/",
      "app/api/v1/audit-sinks/",
      "app/api/v1/audit-log/export/",
      "app/api/v1/audit-log/retention/",
      "app/api/v1/audit-log/verify/",
    ],
  },
  {
    module: "ee/backups",
    features: ["scheduled_backups"],
    prefixes: ["app/api/v1/backup-destinations/", "app/api/v1/backup-runs/"],
  },
  {
    module: "ee/compliance",
    features: ["compliance_reports"],
    prefixes: ["app/(dashboard)/compliance/", "app/print/compliance/", "app/api/v1/compliance/"],
  },
  {
    module: "ee/config-history",
    features: ["config_history"],
    prefixes: ["app/(dashboard)/history/", "app/api/v1/config-history/"],
  },
  {
    module: "ee/custom-roles",
    features: ["custom_roles"],
    prefixes: ["app/api/v1/roles/", "app/api/v1/permissions/"],
  },
  {
    module: "ee/fleet",
    features: ["fleet"],
    prefixes: ["app/(dashboard)/fleet/", "app/api/v1/fleet/", "app/api/instances/pull/"],
  },
  {
    module: "ee/high-availability",
    features: ["high_availability"],
    prefixes: ["app/api/v1/high-availability/", "app/api/v1/cluster/"],
  },
  {
    module: "ee/ldap",
    features: ["ldap"],
    prefixes: ["app/(dashboard)/ldap/", "app/api/v1/ldap-directories/"],
  },
  {
    module: "ee/licensing",
    features: [],
    prefixes: ["app/(dashboard)/license/", "app/api/v1/license/"],
  },
  {
    module: "ee/monetization",
    features: ["api_monetization"],
    prefixes: ["app/(dashboard)/api-monetization/", "app/api-portal/", "app/api/monetization/", "app/api/v1/monetization/"],
  },
  {
    module: "ee/multi-tenancy",
    features: ["multi_tenancy"],
    prefixes: ["app/(dashboard)/organizations/", "app/(dashboard)/usage/", "app/api/v1/organizations/", "app/api/v1/usage-reports/"],
  },
  {
    module: "ee/saml",
    features: ["sso_saml"],
    prefixes: ["app/(dashboard)/saml/", "app/api/v1/saml-providers/"],
  },
  {
    module: "ee/scim",
    features: ["scim"],
    prefixes: ["app/(dashboard)/scim/", "app/api/v1/scim/", "app/scim/"],
  },
  {
    module: "ee/sso",
    features: ["sso_enforce"],
    prefixes: ["app/(dashboard)/sso/", "app/api/v1/sso/"],
  },
  {
    module: "ee/white-label",
    features: ["white_label"],
    prefixes: ["app/(dashboard)/branding/", "app/api/v1/branding/", "app/api/branding/"],
  },
];

/** Every app/ prefix of PAID_ROUTES. */
export const PAID_ROUTE_PREFIXES: readonly string[] = PAID_ROUTES.flatMap((group) => group.prefixes);

/** Paid features without a page or route of their own, and where they live. */
export const PAID_FEATURES_WITHOUT_ROUTES: Partial<Record<Feature, string>> = {
  air_gap: "ee/scripts/airgap-bundle.sh and ee/docs/air-gapped.md, ee/docs/lts.md",
};

/**
 * Core files outside app/ that import ee/: small hooks through which core
 * code reads paid state or lets a paid feature take part, never paid logic of
 * their own. A new entry needs a reason a reviewer can check.
 */
export const CORE_EE_HOOKS: Readonly<Record<string, string>> = {
  "proxy.ts": "High availability: a standby's 503, the request-path routes it still serves, and a refused replica's 503.",
  "src/components/auth/AuthBrand.tsx": "White-label: the product name and logo on the sign-in pages.",
  "src/components/l4-proxy-hosts/L4HostDialogs.tsx": "Change approvals: the notice that a protected host's change needs approval.",
  "src/components/mfa/BackupCodesPanel.tsx": "White-label: the product name in the backup codes file.",
  "src/components/proxy-hosts/editor/AccessSection.tsx": "White-label: the product name in help text.",
  "src/components/proxy-hosts/editor/HostEditor.tsx": "Change approvals: whether a policy covers the host being edited.",
  "src/components/proxy-hosts/editor/ReviewPanel.tsx": "Change approvals: the type of a change preview.",
  "src/components/proxy-hosts/editor/types.ts": "Change approvals: the type of a host's approval context.",
  "src/components/proxy-hosts/HostDialogs.tsx": "Change approvals: the notice that a protected host's change needs approval.",
  "src/instrumentation.ts": "Starts the background jobs of paid features (schedulers, workers, the pull agent, the leader watchdog).",
  "src/lib/access-list-overview.ts": "Multi-tenancy: the type of an organization filter.",
  "src/lib/access-lists-openapi.ts": "Multi-tenancy: the organization filter parameter in the OpenAPI document.",
  "src/lib/access-scope.ts": "Multi-tenancy: keeps an organization's writes inside the organization.",
  "src/lib/analytics/scope.ts": "Multi-tenancy: limits analytics to an organization's hosts.",
  "src/lib/analytics/service.ts": "Multi-tenancy: the organization the dashboard shows.",
  "src/lib/api-auth.ts": "Custom roles: the permissions of a token's owner.",
  "src/lib/attention/index.ts": "Registers the overview's \"needs attention\" providers of paid features.",
  "src/lib/audit-chain.ts": "Configuration history: links an audit event to the versions it made.",
  "src/lib/audit-log-view.ts": "Configuration history: the type of the diff shown with an audit event.",
  "src/lib/audit.ts": "Multi-tenancy: the organization an audit event belongs to.",
  "src/lib/auth-server.ts": "SAML, LDAP, SCIM, enforced SSO and multi-tenancy: their Better Auth plugins and sign-in checks.",
  "src/lib/auth.ts": "Custom roles and multi-tenancy: a session's permissions and its organization's state.",
  "src/lib/background-jobs.ts": "High availability: which node of a cluster runs the jobs.",
  "src/lib/caddy.ts": "Config history, API monetization and certificate storage: their parts of the Caddy configuration.",
  "src/lib/certificate-overview-openapi.ts": "Multi-tenancy: the organization filter parameter in the OpenAPI document.",
  "src/lib/certificate-overview.ts": "Multi-tenancy: limits the certificate overview to an organization.",
  "src/lib/cluster-nodes.ts": "High availability: the license rule for a new PostgreSQL replica and its refusal.",
  "src/lib/config-content.ts": "High availability: encrypts certificate storage secrets in exported configuration.",
  "src/lib/config-replace.ts": "Change approvals, high availability and licensing: checks before a configuration import replaces everything.",
  "src/lib/db/startup.ts": "High availability: refuses the SQLite cluster with a PostgreSQL database.",
  "src/lib/forward-auth-state.ts": "High availability: forward-auth sessions in shared state.",
  "src/lib/identity-health.ts": "LDAP: the health of directories for the sign-in overview.",
  "src/lib/identity-overview-openapi.ts": "Multi-tenancy: the organization filter parameter in the OpenAPI document.",
  "src/lib/init-db.ts": "Enforced SSO: keeps a break-glass account when the first administrator is created.",
  "src/lib/instance-sync-status.ts": "Fleet: the fingerprint token of a pull replica.",
  "src/lib/instance-sync-validation.ts": "White-label and API monetization: their parts of a sync payload.",
  "src/lib/instance-sync.ts": "Fleet, white-label, API monetization and certificate storage: their parts of instance sync.",
  "src/lib/log-parser.ts": "API monetization: credits failed answers from the access log.",
  "src/lib/mfa-auth.ts": "LDAP, SAML and white-label: directory passwords and sign-in paths under MFA, the product name.",
  "src/lib/mfa.ts": "LDAP and enforced SSO: which accounts sign in with a directory or are break-glass.",
  "src/lib/models/access-lists.ts": "Multi-tenancy: organization scoping of access lists.",
  "src/lib/models/api-tokens.ts": "Custom roles and multi-tenancy: a token owner's permissions and organization.",
  "src/lib/models/audit.ts": "Multi-tenancy: organization scoping of audit events.",
  "src/lib/models/certificates.ts": "Multi-tenancy: organization scoping of certificates.",
  "src/lib/models/forward-auth.ts": "Multi-tenancy: organization scoping of forward-auth grants.",
  "src/lib/models/groups.ts": "Multi-tenancy: organization scoping of groups.",
  "src/lib/models/instances.ts": "Fleet: forgets a deleted instance's fleet state.",
  "src/lib/models/l4-proxy-hosts.ts": "Change approvals, multi-tenancy and white-label: guards on L4 host changes, the product name.",
  "src/lib/models/mtls-access-rules.ts": "Multi-tenancy: organization scoping of mTLS rules.",
  "src/lib/models/proxy-hosts.ts": "Change approvals, API monetization, multi-tenancy and white-label: guards on host changes, the product name.",
  "src/lib/models/user.ts": "Enforced SSO and multi-tenancy: break-glass accounts and organization scoping of users.",
  "src/lib/models/waf-exclusions.ts": "Change approvals: guards on WAF exclusions of protected hosts.",
  "src/lib/nav-summary.ts": "Sidebar counters of paid pages, the edition and the environment.",
  "src/lib/overview.ts": "The overview's fleet nodes and edition.",
  "src/lib/passkey-auth.ts": "White-label: the product name as the passkey relying party.",
  "src/lib/passkeys.ts": "Enforced SSO: whether passkeys may still be used.",
  "src/lib/proxy-host-changes.ts": "Change approvals and multi-tenancy: gates a host change and picks its organization.",
  "src/lib/proxy-host-detail.ts": "Alerting, configuration history and multi-tenancy: the host page's alert rules, versions and organization.",
  "src/lib/proxy-host-insights.ts": "Multi-tenancy: the type of an organization filter.",
  "src/lib/search.ts": "Multi-tenancy and white-label: search results of the organization, the product name.",
  "src/lib/secret-rotation.ts": "High availability: re-encrypts certificate storage secrets.",
  "src/lib/setup-checklist.ts": "Licensing: whether a paid step can be set up.",
  "src/lib/sign-in-activity.ts": "LDAP and SAML: names their sign-in paths in the activity log.",
  "src/lib/sign-in-overview.ts": "SAML, LDAP, SCIM and enforced SSO: their entries on the sign-in overview.",
  "src/lib/startup-caches.ts": "White-label, API monetization and shared state: loads their caches at start-up.",
  "src/lib/usage-ping/collect.ts": "Which paid features are set up, for the usage ping.",
  "src/lib/usage-ping/payload.ts": "Licensing: the editions and features the usage ping may name.",
  "src/lib/users-overview.ts": "Custom roles, LDAP, SCIM, enforced SSO and multi-tenancy: the users overview's sources and roles.",
};
