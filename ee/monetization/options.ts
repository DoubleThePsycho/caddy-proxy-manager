// SPDX-License-Identifier: Elastic-2.0
/**
 * Install-wide options of API monetization (settings key
 * "monetization_options"): how long hourly usage history is kept, and how
 * sync replicas and pull replicas serve monetized hosts.
 *
 * Neither option goes to replicas as a setting: the ledger is the master's
 * alone (its retention is the master's job), and the replica mode decides
 * what the master puts in the sync payload (replica-sync.ts).
 *
 * Licensing: changing the options needs "api_monetization", except turning
 * replica serving off. Reading never does.
 *
 * Permissions: the route guard is monetization:write; the replica options
 * decide what the master sends its replicas and where they send their
 * allowance credential, so changing them needs instances:write as well
 * (checked here, as fleet checks fleet:promote on top of its guard).
 */
import { logAuditEvent } from "@/src/lib/audit";
import { config } from "@/src/lib/config";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { can, type Access } from "@/src/lib/permissions";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { requireFeature } from "@/ee/licensing/store";
import { parseInteger, rejectUnknownKeys, requireRecord } from "./http";
import { isHttpSyncAllowed } from "@/src/lib/instance-sync-http";
import { isGateUrlAllowed } from "./replica-index";
import { readSettingRow, writeSettingRow } from "./settings";
import { FEATURE, REPLICA_MODES, type MonetizationOptionsView, type ReplicaMode } from "./types";

export const OPTIONS_SETTING_KEY = "monetization_options";
export const DEFAULT_USAGE_RETENTION_MONTHS = 13;
export const MIN_USAGE_RETENTION_MONTHS = 1;
export const MAX_USAGE_RETENTION_MONTHS = 120;

export type StoredOptions = {
  usageRetentionMonths?: number;
  replicas?: { mode?: ReplicaMode; gateUrl?: string | null };
};

export type MonetizationOptions = {
  usageRetentionMonths: number;
  replicaMode: ReplicaMode;
  /** Where replicas reach this master's gate in allowance mode; null: BASE_URL. */
  replicaGateUrl: string | null;
};

function readMode(value: unknown): ReplicaMode {
  return (REPLICA_MODES as readonly unknown[]).includes(value) ? (value as ReplicaMode) : "off";
}

export function readOptions(stored: StoredOptions | null): MonetizationOptions {
  const months = stored?.usageRetentionMonths;
  return {
    usageRetentionMonths:
      typeof months === "number" && Number.isInteger(months) && months >= MIN_USAGE_RETENTION_MONTHS && months <= MAX_USAGE_RETENTION_MONTHS
        ? months
        : DEFAULT_USAGE_RETENTION_MONTHS,
    replicaMode: readMode(stored?.replicas?.mode),
    replicaGateUrl: typeof stored?.replicas?.gateUrl === "string" && stored.replicas.gateUrl ? stored.replicas.gateUrl : null,
  };
}

export async function getMonetizationOptions(): Promise<MonetizationOptions> {
  return readOptions(await readSettingRow<StoredOptions>(OPTIONS_SETTING_KEY));
}

/** The URL replicas call this master's gate at (allowance mode). */
export function replicaGateBaseUrl(options: Pick<MonetizationOptions, "replicaGateUrl">): string {
  return (options.replicaGateUrl ?? config.baseUrl).replace(/\/+$/, "");
}

function parseGateUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const invalid = "replicas.gateUrl must be an https URL without credentials, query or fragment (http only with INSTANCE_SYNC_ALLOW_HTTP=true)";
  if (typeof value !== "string" || value.length > 2048) throw new ApiValidationError(invalid);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiValidationError(invalid);
  }
  if (url.username || url.password || !isGateUrlAllowed(url.href, isHttpSyncAllowed())) throw new ApiValidationError(invalid);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Why a replica mode cannot be used now, or null. Allowance mode sends the
 * replicas' allowance credential to the gate URL (BASE_URL unless set), which
 * must therefore be https (http only with INSTANCE_SYNC_ALLOW_HTTP, as for
 * the sync); shared mode needs this master's shared state.
 */
export async function replicaModeProblem(options: Pick<MonetizationOptions, "replicaMode" | "replicaGateUrl">): Promise<string | null> {
  if (options.replicaMode === "allowance") {
    return isGateUrlAllowed(replicaGateBaseUrl(options), isHttpSyncAllowed())
      ? null
      : "The gate URL for replicas must use https: set it here, or set BASE_URL to an https URL (http only with INSTANCE_SYNC_ALLOW_HTTP=true)";
  }
  if (options.replicaMode !== "shared") return null;
  const { resolveSharedState } = await import("@/ee/high-availability/shared-state/connection");
  const resolved = await resolveSharedState();
  if (resolved.status === "on") return null;
  return resolved.status === "error"
    ? resolved.message
    : "Shared state is off: turn on high availability shared state (Redis or Valkey) so replicas charge the same balances";
}

export async function getMonetizationOptionsView(given?: MonetizationOptions): Promise<MonetizationOptionsView> {
  const options = given ?? (await getMonetizationOptions());
  return {
    usageRetentionMonths: options.usageRetentionMonths,
    replicas: { mode: options.replicaMode, gateUrl: options.replicaGateUrl, problem: await replicaModeProblem(options) },
    analyticsAvailable: isAnalyticsEnabled(),
  };
}

/**
 * {usageRetentionMonths?, replicas?: {mode?, gateUrl?}}. Turning replica
 * serving off needs no license; everything else does. Changing the replica
 * mode sends the configuration to the replicas again.
 */
export async function saveMonetizationOptions(body: unknown, actorUserId: number, access: Access): Promise<MonetizationOptionsView> {
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["usageRetentionMonths", "replicas"]);
  if (record.replicas !== undefined && !can(access, "instances:write")) {
    throw new ApiClientError(
      "Changing how replicas serve monetized hosts needs the instances:write permission as well: it decides what replicas receive and where they send their credential",
      403
    );
  }
  const previous = await getMonetizationOptions();
  const next: MonetizationOptions = { ...previous };
  if (record.usageRetentionMonths !== undefined) {
    next.usageRetentionMonths = parseInteger(record.usageRetentionMonths, "usageRetentionMonths", MIN_USAGE_RETENTION_MONTHS, MAX_USAGE_RETENTION_MONTHS);
  }
  if (record.replicas !== undefined) {
    const replicas = requireRecord(record.replicas);
    rejectUnknownKeys(replicas, ["mode", "gateUrl"]);
    if (replicas.mode !== undefined) {
      if (!(REPLICA_MODES as readonly unknown[]).includes(replicas.mode)) throw new ApiValidationError(`replicas.mode must be one of ${REPLICA_MODES.join(", ")}`);
      next.replicaMode = replicas.mode as ReplicaMode;
    }
    if (replicas.gateUrl !== undefined) next.replicaGateUrl = parseGateUrl(replicas.gateUrl);
  }
  const onlyTurnsReplicasOff =
    next.replicaMode === "off" &&
    next.usageRetentionMonths === previous.usageRetentionMonths &&
    next.replicaGateUrl === previous.replicaGateUrl;
  if (!onlyTurnsReplicasOff) await requireFeature(FEATURE);
  if (next.replicaMode !== "off" && (next.replicaMode !== previous.replicaMode || next.replicaGateUrl !== previous.replicaGateUrl)) {
    const problem = await replicaModeProblem(next);
    if (problem) throw new ApiValidationError(problem);
  }
  const stored: StoredOptions = {
    usageRetentionMonths: next.usageRetentionMonths,
    replicas: { mode: next.replicaMode, gateUrl: next.replicaGateUrl },
  };
  await writeSettingRow(OPTIONS_SETTING_KEY, stored);
  await logAuditEvent({
    userId: actorUserId,
    action: "update",
    entityType: "monetization_options",
    summary: "Updated the options of API monetization",
    data: { usageRetentionMonths: next.usageRetentionMonths, replicaMode: next.replicaMode, replicaGateUrl: next.replicaGateUrl },
  });
  if (next.replicaMode !== previous.replicaMode || next.replicaGateUrl !== previous.replicaGateUrl) {
    const { announceReplicaIndexChange } = await import("./replica-sync");
    announceReplicaIndexChange();
  }
  return await getMonetizationOptionsView(next);
}
