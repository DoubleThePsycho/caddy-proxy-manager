// SPDX-License-Identifier: Elastic-2.0
/**
 * The installed license, persisted in the settings table.
 *
 * Gating rule: a license only decides whether paid features can be set up or
 * changed. Nothing here is consulted on the request path: proxying, TLS, the
 * WAF, sign-in (SSO included) and every paid feature already configured keep
 * working with an expired, removed, invalid, revoked or unconfirmed key, or
 * one that is active on another install.
 *
 * An online key (v2) is evaluated with what the online check stored
 * (online-check-state.ts): the license server's latest statement for this
 * install and when the license was first seen here.
 */
import { clearSetting, getSetting, setSetting } from "@/src/lib/settings";
import { ApiClientError } from "@/src/lib/api-errors";
import { listInstances } from "@/src/lib/models/instances";
import { getEnvSlaveInstances } from "@/src/lib/instance-sync";
import { BRAND_NAME } from "@/src/lib/brand";
import { EDITION_LABELS, FEATURE_INFO, type Feature } from "./features";
import { canConfigure, evaluateLicense, LicenseKeyError, requiresOnlineCheck, type LicenseState } from "./license";
import { getTrustedLicenseKeys } from "./public-keys";
import { readLicenseCheck, readLicenseInstallId, recordFirstSeen, toCheckInput } from "./online-check-state";

export const LICENSE_SETTING_KEY = "license";

export class LicenseRequiredError extends ApiClientError {
  readonly feature: Feature;
  constructor(feature: Feature) {
    const info = FEATURE_INFO[feature];
    super(
      `${info.label} needs an active ${BRAND_NAME} ${EDITION_LABELS[info.edition]} license or higher`,
      403
    );
    this.name = "LicenseRequiredError";
    this.feature = feature;
  }
}

export async function getLicenseKey(): Promise<string | null> {
  const value = await getSetting<unknown>(LICENSE_SETTING_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function getLicenseState(now: Date = new Date()): Promise<LicenseState> {
  const [key, check, installId] = await Promise.all([getLicenseKey(), readLicenseCheck(), readLicenseInstallId()]);
  const state = evaluateLicense(key, getTrustedLicenseKeys(), now, toCheckInput(check, installId));
  // An online key installed before this release, or whose row was lost: its first days start now.
  if (state.license && requiresOnlineCheck(state.license) && !check.firstSeen[state.license.id]) {
    await recordFirstSeen(state.license.id, now);
  }
  return state;
}

export type LicenseKeyCheckResult = {
  /** The key's state if it were installed at `now`. */
  state: LicenseState;
  /** Installing it would succeed. */
  installable: boolean;
  /** Why it would be refused; safe to show. */
  error: string | null;
};

/**
 * Checks a key on this machine (signature, payload and dates) without storing
 * it: what installLicenseKey would do with it. Keys that are invalid or past
 * their grace period are not installable.
 */
export async function checkLicenseKey(key: string, now: Date = new Date()): Promise<LicenseKeyCheckResult> {
  const [check, installId] = await Promise.all([readLicenseCheck(), readLicenseInstallId()]);
  const state = evaluateLicense(key.trim(), getTrustedLicenseKeys(), now, toCheckInput(check, installId));
  if (state.status === "invalid" || state.status === "unlicensed") {
    return { state, installable: false, error: state.error ?? "The license key is not valid" };
  }
  if (state.status === "expired") {
    return { state, installable: false, error: `This license expired on ${state.license?.exp.slice(0, 10)}` };
  }
  return { state, installable: true, error: null };
}

/**
 * Verifies and stores a key. Keys that are invalid or past their grace
 * period are refused. An online key's first days start when it is first
 * installed; callers then run the online check (online-check.ts,
 * afterLicenseInstalled).
 */
export async function installLicenseKey(key: string, now: Date = new Date()): Promise<LicenseState> {
  const { state, installable, error } = await checkLicenseKey(key, now);
  if (!installable) {
    throw new ApiClientError(error ?? "The license key is not valid", 400);
  }
  if (state.license && requiresOnlineCheck(state.license)) await recordFirstSeen(state.license.id, now);
  await setSetting(LICENSE_SETTING_KEY, key.trim());
  return state;
}

export async function removeLicenseKey(): Promise<void> {
  await clearSetting(LICENSE_SETTING_KEY);
}

/** The license lets administrators set the feature up or change it. */
export async function isFeatureConfigurable(feature: Feature, now: Date = new Date()): Promise<boolean> {
  return canConfigure(await getLicenseState(now), feature);
}

/** Throws LicenseRequiredError (a 403 client error) unless the license lets administrators change `feature`. */
export async function requireFeature(feature: Feature, now: Date = new Date()): Promise<void> {
  if (!(await isFeatureConfigurable(feature, now))) {
    throw new LicenseRequiredError(feature);
  }
}

/** Nodes this dashboard manages: itself plus every enabled sync slave. */
export async function countManagedNodes(): Promise<number> {
  const instances = await listInstances();
  return 1 + instances.filter((instance) => instance.enabled).length + getEnvSlaveInstances().length;
}

export { LicenseKeyError };
