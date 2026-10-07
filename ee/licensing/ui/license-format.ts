// SPDX-License-Identifier: Elastic-2.0
/**
 * Pure helpers of the license page: dates, the release line and what each
 * paid feature looks like on this install. Safe for the client.
 */
import { EDITION_FEATURES, EDITIONS, EDITION_LABELS, type Edition, type Feature } from "@/ee/licensing/features";
import type { LicenseFeatureView, LicenseView } from "@/ee/licensing/view";
import type { FeatureUsage } from "@/ee/licensing/usage";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GRACE_PERIOD_DAYS of ee/licensing/license.ts, which the client cannot
 * import (it verifies signatures with node:crypto); a test keeps them equal.
 */
export const GRACE_PERIOD_DAYS = 30;

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DAY_MONTH_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "31 Dec 2026" (UTC, like the key's own dates). */
export function formatDay(iso: string | Date): string {
  return DAY_FORMAT.format(typeof iso === "string" ? new Date(iso) : iso);
}

/** "1 Jan to 30 Jan 2027", or with both years when they differ. */
export function formatDayRange(from: Date, to: Date): string {
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  return `${sameYear ? DAY_MONTH_FORMAT.format(from) : DAY_FORMAT.format(from)} to ${DAY_FORMAT.format(to)}`;
}

/** Whole days from `now` to `iso`, rounded up; negative once it has passed. */
export function daysUntil(iso: string, now: string): number {
  return Math.ceil((Date.parse(iso) - Date.parse(now)) / DAY_MS);
}

export function plural(value: number, one: string, many: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

/** The day after `iso` (UTC). */
export function nextDay(iso: string): Date {
  return new Date(Date.parse(iso) + DAY_MS);
}

/** "2.0.3" → line "2.0"; a commit or "unknown" has no line. Leading "v" is ignored. */
export function releaseLine(version: string): { version: string; line: string | null } {
  const clean = version.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(clean);
  return { version: clean || "unknown", line: match ? `${match[1]}.${match[2]}` : null };
}

/** How a feature stands on this install, for the "On this install" column and its filters. */
export type InstallStatus = "use" | "idle" | "included" | "out";

export type FeatureRow = LicenseFeatureView & {
  install: InstallStatus;
  /** The note after the status, e.g. "2 firing" or "read-only". */
  detail: string | null;
};

/**
 * In use: set up here, whatever the license says (it keeps running; without
 * the license it is read-only). Not set up: the license includes it and it
 * can be set up now. Out: it cannot be set up (not in the edition, no valid
 * license, or the license is past its grace period).
 */
export function featureRows(license: LicenseView, usage: Partial<Record<Feature, FeatureUsage>>): FeatureRow[] {
  return license.features.map((feature) => {
    const used = usage[feature.id]?.inUse;
    if (used === true) {
      const notes = [usage[feature.id]?.detail ?? null, feature.configurable ? null : "read-only"].filter(Boolean);
      return { ...feature, install: "use", detail: notes.length > 0 ? notes.join(", ") : null };
    }
    if (feature.configurable) return { ...feature, install: used === null ? "included" : "idle", detail: null };
    return { ...feature, install: "out", detail: null };
  });
}

/** A key that verifies is installed, whatever its dates or confirmation (mirrors hasVerifiedKey of license.ts). */
export function isVerifiedStatus(status: LicenseView["status"]): boolean {
  return status !== "unlicensed" && status !== "invalid";
}

/** Why a feature cannot be set up: "Not in Enterprise", "License expired", "License revoked", "License in use elsewhere" or "Not licensed". */
export function outLabel(license: LicenseView): string {
  if (license.status === "expired") return "License expired";
  if (license.status === "revoked") return "License revoked";
  if (license.status === "unconfirmed") return "License not confirmed";
  if (license.status === "in_use") return "License in use elsewhere";
  if ((license.status === "active" || license.status === "grace") && license.editionLabel) return `Not in ${license.editionLabel}`;
  return "Not licensed";
}

/** The editions that include `feature`, cheapest first. */
export function editionsWith(feature: Feature): Edition[] {
  return EDITIONS.filter((edition) => EDITION_FEATURES[edition].includes(feature));
}

/** "Homelab and up", "Enterprise only": the heading of the features whose cheapest edition is `edition`. */
export function editionGroupLabel(edition: Edition, features: readonly Feature[]): string {
  const everywhere = EDITIONS.filter((candidate) => features.every((feature) => EDITION_FEATURES[candidate].includes(feature)));
  return everywhere.length <= 1 ? `${EDITION_LABELS[edition]} only` : `${EDITION_LABELS[edition]} and up`;
}
