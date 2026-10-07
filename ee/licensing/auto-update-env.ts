// SPDX-License-Identifier: Elastic-2.0
/**
 * Environment switches of the license server's clients:
 *
 * - LICENSE_AUTO_UPDATE_DISABLED forbids automatic license updates
 *   (auto-update.ts) entirely: no renewed key is ever fetched and the
 *   setting cannot be turned on. Any value other than empty, "false", "0",
 *   "no" or "off" counts as set, so a typo errs on the side of not calling
 *   out. It does not affect the daily confirmation of online keys
 *   (online-check.ts), which nothing turns off: installs that must not call
 *   out use an offline key.
 * - LICENSE_SERVER_URL replaces the license server for both. It must be an
 *   https URL without credentials, query or fragment; an invalid value means
 *   nothing is sent (it never falls back to the default).
 */

export const DEFAULT_LICENSE_SERVER_URL = "https://license.ingres.si";

const OFF_VALUES = new Set(["", "false", "0", "no", "off"]);

type Env = Record<string, string | undefined>;

export function isLicenseAutoUpdateDisabledByEnv(env: Env = process.env): boolean {
  const value = env.LICENSE_AUTO_UPDATE_DISABLED;
  if (value === undefined) return false;
  return !OFF_VALUES.has(value.trim().toLowerCase());
}

export type LicenseServerEndpoint = { url: string; error: null } | { url: null; error: string };

/** The license server's base URL, without a trailing slash. */
export function resolveLicenseServer(env: Env = process.env): LicenseServerEndpoint {
  const raw = env.LICENSE_SERVER_URL?.trim();
  if (!raw) return { url: DEFAULT_LICENSE_SERVER_URL, error: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: null, error: "LICENSE_SERVER_URL is not a valid URL" };
  }
  if (parsed.protocol !== "https:") return { url: null, error: "LICENSE_SERVER_URL must be an https:// URL" };
  if (parsed.username || parsed.password) return { url: null, error: "LICENSE_SERVER_URL must not contain credentials" };
  if (parsed.search || parsed.hash || raw.includes("?") || raw.includes("#")) {
    return { url: null, error: "LICENSE_SERVER_URL must not contain a query or a fragment" };
  }
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, error: null };
}

/** Where the current key of `licenseId` is fetched from. */
export function currentLicenseUrl(base: string, licenseId: string): string {
  return `${base}/v1/licenses/${encodeURIComponent(licenseId)}/current`;
}

/** Where an online key's status is confirmed. */
export function licenseStatusUrl(base: string, licenseId: string): string {
  return `${base}/v1/licenses/${encodeURIComponent(licenseId)}/status`;
}
