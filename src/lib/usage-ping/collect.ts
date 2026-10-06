/**
 * Where each value of the usage ping comes from (payload.ts says what is
 * sent). Everything here is read on this install only: counts of rows and
 * whether a feature is set up. No row's contents leave this file except as a
 * count or a yes/no, and payload.ts then turns the counts into ranges.
 *
 * A check that fails (a table that cannot be read, a setting that does not
 * parse) reports the feature as not in use rather than failing the ping.
 */
import { count, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  accessReviewCampaigns,
  accessReviewSchedules,
  alertRules,
  approvalPolicies,
  auditSinks,
  backupDestinations,
  complianceIncidents,
  complianceReports,
  customRoles,
  fleetEnvironments,
  l4ProxyHosts,
  ldapDirectories,
  monetizationHosts,
  proxyHosts,
  samlProviders,
  users,
} from "@/src/lib/db/schema";
import { APP_VERSION } from "@/src/lib/app-version";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { resolveEffectiveWaf } from "@/src/lib/caddy-waf";
import { resolveEffectiveRateLimitRules } from "@/src/lib/caddy-rate-limit";
import { getRateLimitSettings, getSetting, getWafSettings } from "@/src/lib/settings";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { getLicenseState, countManagedNodes } from "@/ee/licensing/store";
import { isHaEnabled } from "@/ee/high-availability/cluster/config";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { readScimSettings } from "@/ee/scim/store";
import { getHistorySettings } from "@/ee/config-history/settings";
import { getAiSettingsView } from "@/ee/ai/settings";
import { getAuditRetention } from "@/ee/audit/retention";
import { getBranding } from "@/ee/white-label/store";
import { parseStoredCertificateStorage } from "@/ee/high-availability/settings";
import { CERTIFICATE_STORAGE_SETTING_KEY } from "@/ee/high-availability/types";
import {
  COMMUNITY_FEATURES,
  PAID_FEATURES,
  type PaidFeatureField,
  type UsagePingEdition,
  type UsagePingFacts,
  type UsagePingRole,
} from "./payload";

type Check = () => Promise<boolean> | boolean;

async function safely(check: Check): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

async function hasRow(rows: Promise<unknown[]>): Promise<boolean> {
  return (await rows).length > 0;
}

async function rowCount(rows: Promise<Array<{ value: number }>>): Promise<number> {
  try {
    return (await rows)[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

/** Whether each paid feature is set up, never what it is set up with. */
const PAID_FEATURE_CHECKS: Record<PaidFeatureField, Check> = {
  sso_saml: () => hasRow(appDb.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.enabled, true)).limit(1)),
  sso_enforce: async () => (await readSsoEnforcement(appDb)).enabled,
  custom_roles: () => hasRow(appDb.select({ id: customRoles.id }).from(customRoles).limit(1)),
  audit_streaming: async () =>
    (await hasRow(appDb.select({ id: auditSinks.id }).from(auditSinks).where(eq(auditSinks.enabled, true)).limit(1))) ||
    (await getAuditRetention()).days > 0,
  alerting: () => hasRow(appDb.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.enabled, true)).limit(1)),
  config_history: async () => (await getHistorySettings()).enabled,
  scheduled_backups: () =>
    hasRow(appDb.select({ id: backupDestinations.id }).from(backupDestinations).where(eq(backupDestinations.enabled, true)).limit(1)),
  ai_analyst: async () => (await getAiSettingsView()).configured,
  approvals: () =>
    hasRow(appDb.select({ id: approvalPolicies.id }).from(approvalPolicies).where(eq(approvalPolicies.enabled, true)).limit(1)),
  compliance_reports: async () =>
    (await hasRow(appDb.select({ id: complianceReports.id }).from(complianceReports).limit(1))) ||
    (await hasRow(appDb.select({ id: complianceIncidents.id }).from(complianceIncidents).limit(1))),
  scim: async () => (await readScimSettings(appDb)).enabled,
  access_reviews: async () =>
    (await hasRow(appDb.select({ id: accessReviewCampaigns.id }).from(accessReviewCampaigns).limit(1))) ||
    (await hasRow(
      appDb.select({ id: accessReviewSchedules.id }).from(accessReviewSchedules).where(eq(accessReviewSchedules.enabled, true)).limit(1)
    )),
  ldap: () => hasRow(appDb.select({ id: ldapDirectories.id }).from(ldapDirectories).where(eq(ldapDirectories.enabled, true)).limit(1)),
  fleet: () => hasRow(appDb.select({ id: fleetEnvironments.id }).from(fleetEnvironments).limit(1)),
  high_availability: async () =>
    isHaEnabled() || parseStoredCertificateStorage(await getSetting<unknown>(CERTIFICATE_STORAGE_SETTING_KEY))?.backend === "redis",
  white_label: () => getBranding().source !== "default",
  api_monetization: () =>
    hasRow(
      appDb.select({ id: monetizationHosts.proxyHostId }).from(monetizationHosts).where(eq(monetizationHosts.enabled, true)).limit(1)
    ),
};

/**
 * Whether each paid feature is set up on this install (the usage ping, and
 * the license page's "On this install" column). Never what it is set up with.
 */
export async function readPaidFeaturesInUse(): Promise<Record<PaidFeatureField, boolean>> {
  return Object.fromEntries(
    await Promise.all(PAID_FEATURES.map(async (feature) => [feature, await safely(PAID_FEATURE_CHECKS[feature])] as const))
  ) as Record<PaidFeatureField, boolean>;
}

type HostFeatures = { waf: boolean; forwardAuth: boolean; rateLimiting: boolean };

/** WAF, forward auth and rate limiting on any enabled proxy host, read through the proxy host model. */
async function hostFeatures(): Promise<HostFeatures> {
  const found: HostFeatures = { waf: false, forwardAuth: false, rateLimiting: false };
  try {
    const [hosts, globalWaf, globalRateLimit] = await Promise.all([listProxyHosts(), getWafSettings(), getRateLimitSettings()]);
    for (const host of hosts) {
      if (!host.enabled) continue;
      const effective = resolveEffectiveWaf(globalWaf, host.waf);
      if (effective && effective.mode !== "Off") found.waf = true;
      if (host.authentik?.enabled || host.forwardAuth?.enabled || host.ingressiForwardAuth?.enabled) found.forwardAuth = true;
      if (resolveEffectiveRateLimitRules(globalRateLimit, host.rateLimit).length > 0) found.rateLimiting = true;
      if (found.waf && found.forwardAuth && found.rateLimiting) break;
    }
    return found;
  } catch {
    return { waf: false, forwardAuth: false, rateLimiting: false };
  }
}

/** The licensed edition's name while a license is active or in its grace period; "community" otherwise. */
async function currentEdition(): Promise<UsagePingEdition> {
  try {
    const state = await getLicenseState();
    if ((state.status === "active" || state.status === "grace") && state.license) return state.license.edition;
  } catch {
    // Treated as unlicensed.
  }
  return "community";
}

/** Everything the payload is built from. Never called on a sync slave. */
export async function collectUsagePingFacts(role: UsagePingRole): Promise<UsagePingFacts> {
  const [proxyHostCount, l4HostCount, userCount, managedNodes, edition, hosts] = await Promise.all([
    rowCount(appDb.select({ value: count() }).from(proxyHosts)),
    rowCount(appDb.select({ value: count() }).from(l4ProxyHosts)),
    rowCount(appDb.select({ value: count() }).from(users).where(eq(users.status, "active"))),
    role === "master" ? countManagedNodes().catch(() => 1) : Promise.resolve(1),
    currentEdition(),
    hostFeatures(),
  ]);

  const community: Record<(typeof COMMUNITY_FEATURES)[number], boolean> = {
    waf: hosts.waf,
    forward_auth: hosts.forwardAuth,
    clickhouse_analytics: isAnalyticsEnabled(),
    rate_limiting: hosts.rateLimiting,
  };
  const paid = await readPaidFeaturesInUse();

  return {
    version: APP_VERSION,
    edition,
    role,
    counts: {
      proxy_hosts: proxyHostCount,
      l4_hosts: l4HostCount,
      users: userCount,
      // The dashboard's own node is not a replica.
      replicas: role === "master" ? Math.max(0, managedNodes - 1) : 0,
    },
    features: { ...community, ...paid } satisfies UsagePingFacts["features"],
    arch: process.arch,
  };
}
