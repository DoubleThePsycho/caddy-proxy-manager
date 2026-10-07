// SPDX-License-Identifier: Elastic-2.0
/**
 * Drift detection: ask each slave which configuration it runs and compare
 * the fingerprint it reports with the one of the master's last push to it
 * (see src/lib/instance-sync-fingerprint.ts and instance-sync-status.ts).
 *
 * States: in sync; drifted (another configuration, or the synced one changed
 * on the slave itself); unreachable; older version (the slave runs a release
 * that cannot report, so its configuration is unknown rather than an error);
 * unknown (nothing to compare yet). Checking never changes a slave: putting
 * a drifted instance back is a manual re-sync.
 *
 * A pull replica is not asked: its last report (sent with every poll, see
 * pull-server.ts) stands in for the status reply, and "unreachable" means it
 * has not checked in for MISSED_POLLS poll intervals.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { fleetInstances, instances } from "@/src/lib/db/schema";
import { fetchInstanceSyncStatus, getInstanceMode, type InstanceStatusResult } from "@/src/lib/instance-sync";
import { listFleetInstances } from "./environments";
import { MISSED_POLLS, checkInState, getPullReplicaRow, readPullReport } from "./pull-replicas";
import type { DriftStatus, FleetInstanceView } from "./types";

/** Instances checked at once. */
const CHECK_CONCURRENCY = 4;

type InstanceRow = typeof instances.$inferSelect;

export type DriftResult = {
  status: DriftStatus;
  detail: string | null;
  reportedFingerprint: string | null;
  reportedVersion: string | null;
  localChanges: boolean | null;
};

/**
 * A pull replica's status from its last report, in the form of a status
 * reply; "never" before its first check-in.
 */
async function pullReplicaStatus(instance: InstanceRow, now: Date): Promise<InstanceStatusResult | "never"> {
  const pull = await getPullReplicaRow(instance.id);
  const checkIn = checkInState(pull, now);
  if (checkIn === "never") return "never";
  if (checkIn === "missed") {
    return { reachable: false, error: `It has not checked in for ${MISSED_POLLS} poll intervals (last check-in ${pull!.lastSeenAt})` };
  }
  const report = readPullReport(pull);
  return report ? { reachable: true, status: report.status } : { reachable: false, error: "It sent no valid status report" };
}

/** Ask one instance which configuration it runs (a pull replica: read its last report) and store the verdict. */
export async function checkInstanceDrift(instance: InstanceRow, now: Date = new Date()): Promise<DriftResult> {
  const reply = instance.syncMode === "pull" ? await pullReplicaStatus(instance, now) : await fetchInstanceSyncStatus(instance);
  const [row] = await appDb.select().from(fleetInstances).where(eq(fleetInstances.instanceId, instance.id)).limit(1);

  let result: DriftResult;
  if (reply === "never") {
    result = {
      status: "unknown",
      detail: "The pull replica has not checked in yet",
      reportedFingerprint: null,
      reportedVersion: null,
      localChanges: null,
    };
  } else if (!reply.reachable) {
    result = { status: "unreachable", detail: reply.error, reportedFingerprint: null, reportedVersion: null, localChanges: null };
  } else if (!reply.status) {
    result = {
      status: "older_version",
      detail: "The instance runs an older release that cannot report which configuration it runs",
      reportedFingerprint: null,
      reportedVersion: null,
      localChanges: null,
    };
  } else {
    const status = reply.status;
    const reported = { reportedFingerprint: status.fingerprint, reportedVersion: status.appVersion, localChanges: status.localChanges };
    if (!row?.pushedFingerprint) {
      result = { status: "unknown", detail: "Nothing was pushed to it since fleet tracking started; re-sync it to start tracking", ...reported };
    } else if (status.fingerprint === null) {
      result = {
        status: "unknown",
        detail: "The instance has recorded no sync since it was upgraded; it reports one after the next sync",
        ...reported,
      };
    } else if (status.fingerprint !== row.pushedFingerprint) {
      result = { status: "drifted", detail: "It runs another configuration than the one this master last pushed to it", ...reported };
    } else if (status.localChanges === true) {
      result = {
        status: "drifted",
        detail: "Its synced configuration changed since the last sync it applied (edited on the instance, or a sync Caddy rejected there)",
        ...reported,
      };
    } else {
      result = {
        status: "in_sync",
        detail:
          status.localChanges === null
            ? "Local changes cannot be checked until the next sync (the instance was upgraded or its sync token changed)"
            : null,
        ...reported,
      };
    }
  }

  const at = now.toISOString();
  const since = result.status === "drifted" ? (row?.driftStatus === "drifted" && row.driftSince ? row.driftSince : at) : null;
  const values = {
    driftStatus: result.status,
    driftCheckedAt: at,
    driftSince: since,
    driftDetail: result.detail,
    reportedFingerprint: result.reportedFingerprint,
    reportedVersion: result.reportedVersion,
    localChanges: result.localChanges,
    updatedAt: nowIso(),
  };
  await appDb
    .insert(fleetInstances)
    .values({ instanceId: instance.id, ...values })
    .onConflictDoUpdate({ target: fleetInstances.instanceId, set: values });
  return result;
}

/** Check every enabled instance, a few at a time. Only on a master. Returns the instances afterwards. */
export async function runDriftChecks(options: { now?: Date } = {}): Promise<FleetInstanceView[]> {
  if ((await getInstanceMode()) === "master") {
    const rows = await appDb.select().from(instances).where(eq(instances.enabled, true));
    for (let index = 0; index < rows.length; index += CHECK_CONCURRENCY) {
      await Promise.all(
        rows.slice(index, index + CHECK_CONCURRENCY).map((row) =>
          checkInstanceDrift(row, options.now).catch((error) => {
            console.warn(`[fleet] Drift check of instance ${row.id} failed:`, error instanceof Error ? error.name : typeof error);
          })
        )
      );
    }
  }
  return listFleetInstances();
}
