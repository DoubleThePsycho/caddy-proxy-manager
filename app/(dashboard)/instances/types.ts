import type { SyncKeyPin } from "@/src/lib/instance-sync-key-pins";
import type { PullReplicaView } from "@/ee/fleet/types";
import type { PullAgentStatus } from "@/ee/fleet/pull-agent";

export type SyncKeyPinView = Pick<SyncKeyPin, "keyId" | "publicKey" | "pinnedAt" | "source">;

export type SyncKeyPinTarget = { instanceId: number } | { slaveUrl: string };

export type InstanceSyncProps = {
  mode: "standalone" | "master" | "slave";
  modeFromEnv: boolean;
  tokenFromEnv: boolean;
  slave: {
    hasToken: boolean;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    /** This instance's own sync key id, which the master pins. */
    syncKeyId: string;
    /** This instance's own sync public key (raw X25519, base64). */
    syncPublicKey: string;
    /** Set on a pull replica (INSTANCE_SYNC_MODE=pull): it polls its master instead of being pushed to. */
    pull?: PullAgentStatus | null;
  } | null;
  master: {
    instances: Array<{
      id: number;
      name: string;
      baseUrl: string;
      /** "pull": a pull replica (ee/fleet), which has no URL and is not pushed to. */
      syncMode?: "push" | "pull";
      enabled: boolean;
      lastSyncAt: string | null;
      lastSyncError: string | null;
      syncKeyPin: SyncKeyPinView | null;
    }>;
    envInstances: Array<{
      name: string;
      url: string;
      /** Set in INSTANCE_SLAVES; sync checks it instead of the stored pin. */
      syncKeyId?: string;
      /** Set in INSTANCE_SLAVES; sync checks it instead of the stored pin. */
      syncPublicKey?: string;
      syncKeyPin: SyncKeyPinView | null;
    }>;
    /** Pins of URLs no instance or INSTANCE_SLAVES entry syncs to. */
    orphanSyncKeyPins: Array<SyncKeyPinView & { url: string }>;
    /** Pull replicas (ee/fleet); null without fleet:read. */
    pullReplicas?: {
      replicas: PullReplicaView[];
      canManage: boolean;
    } | null;
  } | null;
};

export type ReplicaInstanceView = NonNullable<InstanceSyncProps["master"]>["instances"][number];

export type InstancesClientProps = {
  /** Null without instances:read (the page shows a notice instead). */
  instanceSync: InstanceSyncProps | null;
  /** instances:write */
  canWrite: boolean;
  /** fleet:read, for the breadcrumb's link. */
  canOpenFleet: boolean;
};
