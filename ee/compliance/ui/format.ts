// SPDX-License-Identifier: Elastic-2.0
/**
 * Small formatting helpers of the compliance page. Pure; safe on the server
 * and the client.
 */
import type { StatusTone } from "@/components/ui/StatusDot";
import type { ControlStatus } from "../control-status";
import type { Classification, NotificationStatus } from "../incident-register";
import type { RestoreOutcome, RestoreSource } from "../restore-tests";
import type { ReportScheduleView } from "../schedules";
import type { ComplianceFramework, FindingCounts } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const FRAMEWORK_INFO: Record<ComplianceFramework, { label: string; name: string; note: string; refHeading: string }> = {
  nis2: {
    label: "NIS2",
    name: "NIS2, Directive (EU) 2022/2555",
    note: "In Italy D.Lgs. 138/2024; notifications go to CSIRT Italia at ACN",
    refHeading: "NIS2 article",
  },
  iso27001: {
    label: "ISO/IEC 27001",
    name: "ISO/IEC 27001:2022, Annex A",
    note: "Review the mapping against your statement of applicability",
    refHeading: "ISO/IEC 27001 control",
  },
};

export const CONTROL_TONE: Record<ControlStatus, StatusTone> = { met: "ok", attention: "warn", not_met: "bad", unknown: "off" };

export const WEEKDAY_LABELS: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/** Mondays first, as a calendar week reads. */
export const WEEKDAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/** e.g. "Monthly on day 1 at 06:00 (Europe/Rome)", "Every Monday at 06:00 (UTC)". */
export function describeScheduleTiming(schedule: Pick<ReportScheduleView, "frequency" | "weekday" | "dayOfMonth" | "time" | "timeZone">): string {
  const at = `at ${schedule.time} (${schedule.timeZone})`;
  if (schedule.frequency === "weekly") return `Every ${WEEKDAY_LABELS[schedule.weekday ?? "monday"] ?? "Monday"} ${at}`;
  return `Monthly on day ${schedule.dayOfMonth ?? 1} ${at}`;
}

/** "in 29 days", "in 5 hours", "in 12 minutes", "now"; for a time after `now`. */
export function untilText(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 60_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(ms / DAY_MS);
  return `in ${days} days`;
}

/** "5 minutes", "3 hours", "4 days" between two instants. */
export function durationText(fromIso: string, toIso: string): string {
  const ms = Math.max(0, Date.parse(toIso) - Date.parse(fromIso));
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(ms / DAY_MS)} days`;
}

/** "1 to 30 Sep 2026" for a UTC period (the end is inclusive). */
export function periodText(period: { from: string; to: string }): string {
  const from = new Date(period.from);
  const to = new Date(period.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";
  const day = (date: Date, withMonth: boolean, withYear: boolean) =>
    date.toLocaleDateString("en-GB", { day: "numeric", ...(withMonth ? { month: "short" } : {}), ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  const sameMonth = sameYear && from.getUTCMonth() === to.getUTCMonth();
  return `${day(from, !sameMonth, !sameYear)} to ${day(to, true, true)}`;
}

export type FindingPart = { severity: "high" | "medium" | "low"; count: number };

/** The findings worth listing, most severe first; empty when there are none. */
export function findingParts(counts: FindingCounts): FindingPart[] {
  return (["high", "medium", "low"] as const).filter((severity) => counts[severity] > 0).map((severity) => ({ severity, count: counts[severity] }));
}

export const FINDING_TEXT: Record<FindingPart["severity"], string> = { high: "text-bad", medium: "text-warn", low: "text-muted-foreground" };

export const RESTORE_SOURCE_LABELS: Record<RestoreSource, string> = {
  backup: "Scheduled backup",
  snapshot: "Configuration version",
  export: "Export file",
  other: "Other",
};

export const RESTORE_OUTCOME_LABELS: Record<RestoreOutcome, string> = { success: "Restored", partial: "Partly restored", failed: "Failed" };
export const RESTORE_OUTCOME_TONE: Record<RestoreOutcome, StatusTone> = { success: "ok", partial: "warn", failed: "bad" };

export const CLASSIFICATION_BADGE: Record<Classification, "muted" | "outline" | "destructive"> = {
  undetermined: "muted",
  not_significant: "outline",
  significant: "destructive",
};

export const NOTIFICATION_TONE: Record<NotificationStatus, string> = {
  undetermined: "text-muted-foreground",
  not_required: "text-muted-foreground",
  required: "text-warn",
  submitted: "text-foreground",
};

/** Two letters for an avatar: "Alice Admin" → "AA", "j.moretti" → "JM". */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[1][0]}`).toUpperCase();
}
