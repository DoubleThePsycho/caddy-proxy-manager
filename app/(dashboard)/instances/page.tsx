import { requirePermission } from "@/src/lib/auth";
import { can, type Access } from "@/src/lib/permissions";
import {
  getEnvSlaveInstances,
  getInstanceMode,
  getSlaveLastSync,
  getSlaveMasterToken,
  isInstanceModeFromEnv,
  isSyncTokenFromEnv,
} from "@/src/lib/instance-sync";
import { toEnvSlaveInstanceView } from "@/src/lib/instance-sync-view";
import { listInstances, listSyncKeyPinsWithSlaves, withSyncKeyPins } from "@/src/lib/models/instances";
import { getSyncPublicKey } from "@/src/lib/sync-crypto";
import { isPullReplicaMode } from "@/ee/fleet/pull-config";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listPullReplicas } from "@/ee/fleet/pull-replicas";
import { getPullAgentStatus } from "@/ee/fleet/pull-agent";
import { FEATURE as FLEET_FEATURE } from "@/ee/fleet/types";
import InstancesClient from "./InstancesClient";
import type { InstanceSyncProps } from "./types";

export const metadata = { title: "Instance sync" };

/** The instance sync state the page shows; the caller holds instances:read. */
async function loadInstanceSync(access: Access): Promise<InstanceSyncProps> {
  const mode = await getInstanceMode();
  const base = { mode, modeFromEnv: isInstanceModeFromEnv(), tokenFromEnv: isSyncTokenFromEnv() };

  if (mode === "slave") {
    const [token, lastSync] = await Promise.all([getSlaveMasterToken(), getSlaveLastSync()]);
    const own = getSyncPublicKey();
    return {
      ...base,
      master: null,
      slave: {
        hasToken: Boolean(token),
        lastSyncAt: lastSync?.at ?? null,
        lastSyncError: lastSync?.error ?? null,
        syncKeyId: own.keyId,
        syncPublicKey: own.publicKey.toString("base64"),
        pull: isPullReplicaMode() ? getPullAgentStatus() : null,
      },
    };
  }
  if (mode !== "master") return { ...base, master: null, slave: null };

  const [instances, envInstances, pins] = await Promise.all([
    listInstances(),
    withSyncKeyPins(getEnvSlaveInstances().map(toEnvSlaveInstanceView)),
    listSyncKeyPinsWithSlaves(),
  ]);
  // Pins of URLs no slave syncs to any more (for example an INSTANCE_SLAVES
  // entry that was removed); a slave added at such a URL inherits the pin.
  const orphanSyncKeyPins = pins
    .filter((pin) => pin.slaves.length === 0)
    .map(({ url, keyId, publicKey, pinnedAt, source }) => ({ url, keyId, publicKey, pinnedAt, source }));
  const master: NonNullable<InstanceSyncProps["master"]> = { instances, envInstances, orphanSyncKeyPins };
  // Pull replicas (ee/fleet): listed with fleet:read, managed with fleet:replicas.
  // Shown when there are some, or the license allows adding them.
  if (can(access, "fleet:read")) {
    const [replicas, configurable] = await Promise.all([listPullReplicas(), isFeatureConfigurable(FLEET_FEATURE)]);
    if (replicas.length > 0 || configurable) {
      master.pullReplicas = {
        replicas,
        canManage: can(access, "fleet:replicas"),
        configurable,
        editionLabel: EDITION_LABELS[FEATURE_INFO[FLEET_FEATURE].edition],
      };
    }
  }
  return { ...base, slave: null, master };
}

export default async function InstancesPage() {
  const { access } = await requirePermission("settings:read");
  // Instance sync is its own permission area, as on the REST API.
  const instanceSync = can(access, "instances:read") ? await loadInstanceSync(access) : null;
  return (
    <InstancesClient instanceSync={instanceSync} canWrite={can(access, "instances:write")} canOpenFleet={can(access, "fleet:read")} />
  );
}
