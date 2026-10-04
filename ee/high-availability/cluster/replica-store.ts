// SPDX-License-Identifier: Elastic-2.0
/**
 * The cluster's object storage, besides what Litestream writes:
 *
 *   <path>/cluster.json          the replica pointer, a durable copy of the one in Redis or Valkey
 *   <path>/replicas/<id>/...     one directory per leader term, written by that leader's Litestream
 *
 * Each leader writes to a replica of its own (named after its fencing epoch),
 * so a former leader that comes back from a pause can only ever add to its
 * own, abandoned replica, never to the current one.
 *
 * Uses the S3 client of scheduled backups (ee/backups/s3.ts): its errors are
 * fixed text that is safe to show.
 */
import { S3Client, S3Error } from "@/ee/backups/s3";
import type { HaStorageConfig } from "./config";
import { REPLICA_ID, parsePointer, type ReplicaPointer } from "./lease-store";

const MAX_POINTER_BYTES = 4096;

/** The epoch a replica id was created in. */
export function replicaEpoch(replicaId: string): number {
  const match = REPLICA_ID.exec(replicaId);
  return match ? Number(match[1]) : 0;
}

export interface ReplicaStore {
  readPointer(): Promise<ReplicaPointer | null>;
  writePointer(pointer: ReplicaPointer): Promise<void>;
  /** Every replica directory in the bucket, oldest epoch first. */
  listReplicaIds(): Promise<string[]>;
  /** Whether the replica directory holds any object. */
  hasObjects(replicaId: string): Promise<boolean>;
  /** Deletes every object of a replica directory; returns how many. */
  deleteReplica(replicaId: string): Promise<number>;
}

export class S3ReplicaStore implements ReplicaStore {
  private readonly client: S3Client;

  constructor(
    private readonly storage: HaStorageConfig,
    client?: S3Client
  ) {
    this.client =
      client ??
      new S3Client(
        { endpoint: storage.apiEndpoint, region: storage.region, bucket: storage.bucket, pathStyle: storage.forcePathStyle },
        { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey }
      );
  }

  private get pointerKey(): string {
    return `${this.storage.path}/cluster.json`;
  }

  private replicaPrefix(replicaId?: string): string {
    return `${this.storage.path}/replicas/${replicaId ? `${replicaId}/` : ""}`;
  }

  async readPointer(): Promise<ReplicaPointer | null> {
    try {
      const { body } = await this.client.getObject(this.pointerKey, MAX_POINTER_BYTES);
      return parsePointer(body.toString("utf8"));
    } catch (error) {
      if (error instanceof S3Error && error.status === 404) return null;
      throw error;
    }
  }

  async writePointer(pointer: ReplicaPointer): Promise<void> {
    await this.client.putObject(this.pointerKey, Buffer.from(JSON.stringify(pointer)), { contentType: "application/json" });
  }

  async listReplicaIds(): Promise<string[]> {
    const prefix = this.replicaPrefix();
    const { objects } = await this.client.listObjects(prefix);
    const ids = new Set<string>();
    for (const object of objects) {
      const id = object.key.slice(prefix.length).split("/", 1)[0];
      if (REPLICA_ID.test(id)) ids.add(id);
    }
    return [...ids].sort((a, b) => replicaEpoch(a) - replicaEpoch(b) || a.localeCompare(b));
  }

  async hasObjects(replicaId: string): Promise<boolean> {
    const { objects } = await this.client.listObjects(this.replicaPrefix(replicaId));
    return objects.length > 0;
  }

  async deleteReplica(replicaId: string): Promise<number> {
    if (!REPLICA_ID.test(replicaId)) return 0;
    const { objects } = await this.client.listObjects(this.replicaPrefix(replicaId));
    for (const object of objects) await this.client.deleteObject(object.key);
    return objects.length;
  }
}
