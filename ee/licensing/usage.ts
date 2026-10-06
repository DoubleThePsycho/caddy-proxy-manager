// SPDX-License-Identifier: Elastic-2.0
/**
 * Which paid features are set up on this install, for the license page's
 * "On this install" column. Whether a feature is in use comes from the same
 * checks as the usage ping (src/lib/usage-ping/collect.ts), so the two never
 * disagree. A short detail ("2 firing", "3 environments") is added only for
 * viewers who may read that area: the license page is open to roles that
 * hold license:read alone.
 *
 * Read-only and best effort: a check that fails reports the feature as not
 * in use, and a detail that fails is left out.
 */
import { count, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  alertRuleStates,
  changeRequests,
  fleetEnvironments,
  ldapDirectories,
  monetizationHosts,
  samlProviders,
} from "@/src/lib/db/schema";
import { can, type Access, type Permission } from "@/src/lib/permissions";
import { readPaidFeaturesInUse } from "@/src/lib/usage-ping/collect";
import { FEATURES, type Feature } from "./features";

export type FeatureUsage = {
  /** Set up on this install; null where there is nothing to set up (air-gapped installs and LTS). */
  inUse: boolean | null;
  /** A short note next to "In use", e.g. "2 firing". */
  detail: string | null;
};

type Detail = { permission: Permission; read: () => Promise<string | null> };

async function countOf(rows: Promise<Array<{ value: number }>>): Promise<number> {
  return (await rows)[0]?.value ?? 0;
}

function plural(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

const DETAILS: Partial<Record<Feature, Detail>> = {
  alerting: {
    permission: "alerts:read",
    read: async () => {
      const firing = await countOf(appDb.select({ value: count() }).from(alertRuleStates).where(eq(alertRuleStates.status, "firing")));
      return firing > 0 ? `${firing} firing` : null;
    },
  },
  approvals: {
    permission: "approvals:read",
    read: async () => {
      const waiting = await countOf(appDb.select({ value: count() }).from(changeRequests).where(eq(changeRequests.status, "pending")));
      return waiting > 0 ? `${waiting} waiting` : null;
    },
  },
  sso_saml: {
    permission: "sso:read",
    read: async () =>
      plural(await countOf(appDb.select({ value: count() }).from(samlProviders).where(eq(samlProviders.enabled, true))), "provider", "providers"),
  },
  ldap: {
    permission: "ldap:read",
    read: async () =>
      plural(await countOf(appDb.select({ value: count() }).from(ldapDirectories).where(eq(ldapDirectories.enabled, true))), "directory", "directories"),
  },
  fleet: {
    permission: "fleet:read",
    read: async () => plural(await countOf(appDb.select({ value: count() }).from(fleetEnvironments)), "environment", "environments"),
  },
  api_monetization: {
    permission: "monetization:read",
    read: async () =>
      plural(await countOf(appDb.select({ value: count() }).from(monetizationHosts).where(eq(monetizationHosts.enabled, true))), "host", "hosts"),
  },
};

async function detailFor(feature: Feature, access: Access): Promise<string | null> {
  const detail = DETAILS[feature];
  if (!detail || !can(access, detail.permission)) return null;
  try {
    return await detail.read();
  } catch {
    return null;
  }
}

/** Each paid feature's use on this install, with details only from areas `access` may read. */
export async function getFeatureUsage(access: Access): Promise<Record<Feature, FeatureUsage>> {
  let inUse: Partial<Record<Feature, boolean>> = {};
  try {
    inUse = await readPaidFeaturesInUse();
  } catch {
    // Every feature reads as not in use.
  }
  const entries = await Promise.all(
    FEATURES.map(async (feature): Promise<[Feature, FeatureUsage]> => {
      if (feature === "air_gap") return [feature, { inUse: null, detail: null }];
      const used = inUse[feature] === true;
      return [feature, { inUse: used, detail: used ? await detailFor(feature, access) : null }];
    })
  );
  return Object.fromEntries(entries) as Record<Feature, FeatureUsage>;
}
