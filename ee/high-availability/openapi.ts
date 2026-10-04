// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the high availability endpoints (shared
 * certificate storage and the dashboard cluster), spread into
 * app/api/v1/openapi.json/route.ts.
 */
import { NODE_ROLES } from "./cluster/types";
import { DEFAULT_KEY_PREFIX, REDIS_MODES, STORAGE_ENV_PREFIX, STORAGE_LIMITS, STORAGE_TEST_STEPS } from "./types";

const TAG = "High availability";

export const HIGH_AVAILABILITY_OPENAPI_TAG = {
  name: TAG,
  description:
    "Shared certificate storage for the Caddy nodes (Enterprise edition, feature high_availability): Redis or Valkey instead of " +
    "each Caddy's own /data, so every node serves the same certificates, each is ordered once, and any node answers ACME " +
    "challenges. Enabling or changing shared storage needs the license; switching back to local storage, removing the setting, " +
    "reading and testing never do, and configured storage keeps working when the license lapses. Secrets are never returned. " +
    "A sync slave uses the master's setting (409 on changes there). The dashboard cluster (one leader, warm standbys, " +
    "SQLite replicated with Litestream) is configured with environment variables only; its endpoint reads its state. " +
    "On PostgreSQL several web replicas share one database and one of them leads the background jobs: " +
    "/api/v1/cluster/nodes lists them. " +
    "Shared state (phase 3) keeps the web nodes' forward-auth sessions and API monetization balances on the same server: " +
    "/api/v1/high-availability/shared-state.",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "409": { $ref: "#/components/responses/Conflict" },
    "502": {
      description: "Caddy did not accept the storage (for example it could not reach or sign in to the server); the previous setting was put back",
      content: json(ref("Error")),
    },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};

const envName = (description: string) => ({
  type: ["string", "null"],
  pattern: `^${STORAGE_ENV_PREFIX}[A-Z0-9_]{1,64}$`,
  description,
});

const secretInput = (description: string) => ({
  type: ["string", "null"],
  description: `${description} A string sets it, null removes it, "" or leaving it out keeps the stored one. Never returned.`,
});

export const HIGH_AVAILABILITY_OPENAPI_PATHS = {
  "/api/v1/high-availability/storage": {
    get: {
      tags: [TAG],
      summary: "Get the certificate storage",
      description: "Permission high_availability:read. Available without a license. Secrets are reported as hasPassword/hasEncryptionKey or the variable they are read from.",
      operationId: "getCertificateStorage",
      responses: { "200": { description: "Certificate storage", content: json(ref("CertificateStorage")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Set the certificate storage",
      description:
        "Permission high_availability:write (administrator-level). backend redis turns shared storage on; backend local turns it off and keeps " +
        "the redis settings for later unless redis is null. Leaving redis out keeps the stored redis settings. Enabling or changing shared " +
        "storage needs the high_availability feature (403 otherwise); going back to local storage does not. A stored password must be " +
        "entered again when the addresses, mode or TLS settings change. The configuration is applied at once: when Caddy cannot use the " +
        "storage the previous setting is put back (502). Switching storage makes Caddy look for certificates in the new storage; import " +
        "the existing ones first (see migration) or they are ordered again, which counts against the CA's rate limits.",
      operationId: "setCertificateStorage",
      requestBody: { required: true, content: json(ref("CertificateStorageInput")) },
      responses: {
        "200": { description: "Saved and applied", content: json(ref("CertificateStorage")) },
        ...errors("400", "401", "403", "409", "502"),
      },
    },
    delete: {
      tags: [TAG],
      summary: "Remove the certificate storage setting",
      description:
        "Permission high_availability:write. Back to local storage, and the redis settings are forgotten. Never needs a license. On a sync " +
        "slave it removes a setting of the slave's own, if any, so the master's applies.",
      operationId: "removeCertificateStorage",
      responses: { "200": { description: "Removed", content: json(ref("CertificateStorage")) }, ...errors("401", "403", "502") },
    },
  },
  "/api/v1/high-availability/storage/test": {
    post: {
      tags: [TAG],
      summary: "Test the certificate storage",
      description:
        "Permission high_availability:write. Connects from this instance's web container (through the Sentinels in sentinel mode), signs in, " +
        "selects the database, then writes, reads back and deletes a key under the key prefix. Without a body it tests the storage in " +
        "effect; with {redis} it tests those settings, using the stored secrets for the ones left out. Changes nothing and needs no " +
        "license. A secret read from an environment variable on the Caddy nodes cannot be used here: the result is then complete: false.",
      operationId: "testCertificateStorage",
      requestBody: { required: false, content: json(ref("CertificateStorageTestInput")) },
      responses: { "200": { description: "Test result", content: json(ref("CertificateStorageTestResult")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/high-availability/cluster": {
    get: {
      tags: [TAG],
      summary: "Get the dashboard cluster",
      description:
        "Permission high_availability:read. Available without a license. The dashboard cluster as the node answering sees it (only the " +
        "leader serves the API; a standby answers 503): this node's role, the lease holder and its fencing epoch, when Litestream last " +
        "confirmed the replica up to date, the last restore, the nodes' own reports and the configuration from the environment. " +
        "Secrets are never returned (hasPassword only). enabled is false when HA_ENABLED is not set.",
      operationId: "getHighAvailabilityCluster",
      responses: { "200": { description: "Cluster", content: json(ref("HighAvailabilityCluster")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/cluster/nodes": {
    get: {
      tags: [TAG],
      summary: "List the PostgreSQL replicas",
      description:
        "Permission high_availability:read. Available without a license. The web replicas sharing one PostgreSQL database, as " +
        "the replica answering sees them: which one it is, which one leads the background jobs (elected with an advisory lock), " +
        "every replica's last heartbeat, version and schema, and the replica's own leader election state. A replica silent for " +
        "goneAfterSeconds is gone; it is removed after pruneAfterDays. Every replica serves the API, so any of them answers. " +
        "On SQLite enabled is false and nodes is empty.",
      operationId: "listClusterNodes",
      responses: { "200": { description: "Replicas", content: json(ref("ClusterNodes")) }, ...errors("401", "403") },
    },
  },
};

const tlsInput = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: false },
    insecureSkipVerify: { type: "boolean", default: false, description: "Do not verify the server's certificate. Not with caPem." },
    caPem: { type: ["string", "null"], description: `PEM certificates to trust instead of the system's, at most ${STORAGE_LIMITS.caPem / 1024} KB.` },
  },
  additionalProperties: false,
};

const restoreRecord = {
  type: ["object", "null"],
  description: "The last promotion of the node: what its database was restored from.",
  properties: {
    at: { type: "string", format: "date-time" },
    ok: { type: "boolean" },
    source: {
      type: ["string", "null"],
      enum: ["replica", "bootstrap", "local", null],
      description: "replica: the newest replica; bootstrap: the cluster was set up from this node's database; local: HA_RECOVER_FROM_LOCAL.",
    },
    replicaId: { type: ["string", "null"] },
    durationMs: { type: "integer" },
    error: { type: ["string", "null"] },
  },
};

const followStatus = {
  type: ["object", "null"],
  description: "A standby's warm copy of the database (litestream restore -f).",
  properties: {
    replicaId: { type: ["string", "null"] },
    ready: { type: "boolean" },
    error: { type: ["string", "null"] },
  },
};

const dateTime = { type: "string", format: "date-time" };
const nullableDateTime = { type: ["string", "null"], format: "date-time" };

export const HIGH_AVAILABILITY_OPENAPI_SCHEMAS = {
  ClusterNodes: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "The dashboard runs on PostgreSQL (replicas are possible)." },
      configurable: {
        type: "boolean",
        description: "The license includes high availability: a new replica may join next to a running one (checked once, when it joins).",
      },
      nodeId: { type: ["string", "null"], description: "The replica answering; null before it registered and on SQLite." },
      role: {
        type: ["string", "null"],
        enum: ["leader", "follower", "refused", "joining", null],
        description: "The replica answering. refused: it was not admitted (another replica runs and the license lacks high availability).",
      },
      refusal: { type: ["string", "null"], description: "Why the replica answering was not admitted." },
      leaderNodeId: { type: ["string", "null"], description: "The live replica that leads the background jobs, as the replicas last reported." },
      election: {
        type: ["object", "null"],
        description: "The leader election as the replica answering sees it.",
        properties: {
          state: { type: "string", enum: ["off", "connecting", "follower", "leader", "stopped"] },
          leader: { type: "boolean" },
          leaderSince: nullableDateTime,
          lastHeartbeatAt: { ...nullableDateTime, description: "The last check that confirmed the lock, while it leads." },
          terms: { type: "integer", description: "How many times this process became the leader." },
          lastError: { type: ["string", "null"], description: "Fixed text: why the election connection was last given up." },
          lastErrorAt: nullableDateTime,
        },
      },
      liveReplicas: { type: "integer" },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "INGRESSI_NODE_ID, or the id kept in the replica's data volume." },
            hostname: { type: "string", description: "A label only." },
            version: { type: "string" },
            schemaVersion: { type: "string", description: "The newest migration the replica's version knows." },
            firstSeenAt: dateTime,
            startedAt: dateTime,
            lastHeartbeatAt: dateTime,
            stoppedAt: nullableDateTime,
            status: { type: "string", enum: ["live", "stopped", "gone"] },
            leader: { type: "boolean" },
            leaderSince: nullableDateTime,
            thisNode: { type: "boolean" },
          },
        },
      },
      heartbeatSeconds: { type: "integer" },
      goneAfterSeconds: { type: "integer" },
      pruneAfterDays: { type: "integer" },
    },
  },
  HighAvailabilityCluster: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "HA_ENABLED is set on the node answering." },
      configurable: { type: "boolean", description: "The license includes high availability (setting a cluster up needs it; a running one never checks)." },
      error: { type: ["string", "null"], description: "The configuration or the supervisor's status cannot be read." },
      node: {
        type: ["object", "null"],
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: [...NODE_ROLES] },
          startedAt: { type: "string", format: "date-time" },
          statusUpdatedAt: { type: "string", format: "date-time" },
        },
      },
      lease: {
        type: ["object", "null"],
        properties: {
          holder: { type: ["string", "null"], description: "Node id holding the leader lease." },
          epoch: { type: ["integer", "null"], description: "Fencing epoch, raised on every acquisition." },
          ttlSeconds: { type: "integer" },
          checkedAt: { type: ["string", "null"], format: "date-time" },
          error: { type: ["string", "null"], description: "Redis or Valkey could not be reached." },
        },
      },
      replication: {
        type: ["object", "null"],
        properties: {
          replicaId: { type: "string", description: "The leader's replica (a directory under the storage path)." },
          lastSyncAt: { type: ["string", "null"], format: "date-time", description: "When Litestream last confirmed every change in object storage." },
          lagSeconds: { type: ["integer", "null"], description: "Seconds since then." },
          error: { type: ["string", "null"] },
          checkedAt: { type: "string", format: "date-time" },
        },
      },
      lastRestore: restoreRecord,
      nodes: {
        type: "array",
        description: "Every node's last report (standbys and the leader).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            role: { type: "string", enum: [...NODE_ROLES] },
            epoch: { type: ["integer", "null"] },
            follow: followStatus,
            lastRestore: restoreRecord,
            updatedAt: { type: "string", format: "date-time" },
          },
        },
      },
      config: {
        type: ["object", "null"],
        description: "From the HA_* environment variables, without secrets.",
        properties: {
          redis: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["standalone", "sentinel", "cluster"] },
              addresses: { type: "array", items: { type: "string" } },
              keyPrefix: { type: "string" },
              tls: { type: "boolean" },
              hasPassword: { type: "boolean" },
            },
          },
          storage: {
            type: "object",
            properties: {
              endpoint: { type: ["string", "null"], description: "null: AWS S3." },
              region: { type: "string" },
              bucket: { type: "string" },
              path: { type: "string" },
            },
          },
          leaseTtlSeconds: { type: "integer" },
          syncIntervalSeconds: { type: "integer" },
          followIntervalSeconds: { type: "integer", description: "0: standbys keep no warm copy." },
        },
      },
      postgres: {
        type: ["object", "null"],
        description: "On PostgreSQL (where HA_ENABLED is refused): the replicas sharing the database, as GET /api/v1/cluster/nodes returns them without enabled and configurable. null on SQLite.",
      },
    },
  },
  RedisStorageInput: {
    type: "object",
    required: ["addresses"],
    properties: {
      mode: { type: "string", enum: [...REDIS_MODES], default: "standalone", description: "standalone: one server; cluster: Redis/Valkey Cluster; sentinel: Sentinel failover." },
      addresses: {
        type: "array",
        minItems: 1,
        maxItems: STORAGE_LIMITS.addresses,
        items: { type: "string", examples: ["valkey.example.com:6379", "[2001:db8::10]:6379"] },
        description: "host:port of the server (exactly one in standalone mode), of cluster nodes to start from, or of the Sentinels.",
      },
      masterName: { type: ["string", "null"], description: "Sentinel mode only (required there): the master's name." },
      db: { type: "integer", minimum: 0, maximum: STORAGE_LIMITS.db, default: 0, description: "Database number; 0 in cluster mode." },
      username: { type: ["string", "null"], description: "ACL user name." },
      password: secretInput("Password, stored encrypted and synced sealed to slaves."),
      passwordEnv: envName("Read the password from this variable on every Caddy node instead (never stored)."),
      sentinelPassword: secretInput("Sentinel mode: the Sentinels' password."),
      sentinelPasswordEnv: envName("Sentinel mode: read the Sentinels' password from this variable on every Caddy node."),
      keyPrefix: {
        type: "string",
        default: DEFAULT_KEY_PREFIX,
        maxLength: STORAGE_LIMITS.keyPrefix,
        description: "Prefix of every key; give each cluster its own to share one server. Segments of letters, digits, '.', '_', '-' separated by '/'.",
      },
      encryptionKey: secretInput(
        `Optional: Caddy encrypts every stored value with the first 32 bytes of this key (at least ${STORAGE_LIMITS.encryptionKeyMin}). Keep a copy.`
      ),
      encryptionKeyEnv: envName("Read the encryption key from this variable on every Caddy node instead."),
      tls: tlsInput,
    },
    additionalProperties: false,
  },
  CertificateStorageInput: {
    type: "object",
    properties: {
      backend: { type: "string", enum: ["local", "redis"] },
      redis: { oneOf: [ref("RedisStorageInput"), { type: "null" }], description: "Left out: the stored settings are kept. null: removed (backend local only)." },
    },
    additionalProperties: false,
  },
  RedisStorage: {
    type: "object",
    properties: {
      mode: { type: "string", enum: [...REDIS_MODES] },
      addresses: { type: "array", items: { type: "string" } },
      masterName: { type: ["string", "null"] },
      db: { type: "integer" },
      username: { type: ["string", "null"] },
      keyPrefix: { type: "string" },
      hasPassword: { type: "boolean" },
      passwordEnv: { type: ["string", "null"] },
      hasSentinelPassword: { type: "boolean" },
      sentinelPasswordEnv: { type: ["string", "null"] },
      hasEncryptionKey: { type: "boolean" },
      encryptionKeyEnv: { type: ["string", "null"] },
      tls: {
        type: "object",
        properties: { enabled: { type: "boolean" }, insecureSkipVerify: { type: "boolean" }, caPem: { type: ["string", "null"] } },
      },
    },
  },
  CertificateStorage: {
    type: "object",
    properties: {
      backend: { type: "string", enum: ["local", "redis"], description: "In effect on this instance." },
      redis: { oneOf: [ref("RedisStorage"), { type: "null" }], description: "Kept while backend is local, until removed." },
      source: { type: "string", enum: ["default", "local", "master"], description: "default: never set; local: set here; master: synced from the master." },
      updatedAt: { type: ["string", "null"], format: "date-time" },
      configurable: { type: "boolean", description: "The license lets this instance enable or change shared storage." },
      editable: { type: "boolean", description: "False on a sync slave." },
      error: { type: ["string", "null"], description: "The stored value is not valid; Caddy keeps its previous configuration until it is saved again." },
      migration: {
        oneOf: [ref("CertificateStorageMigration"), { type: "null" }],
        description: "For moving certificates with caddy storage export/import.",
      },
      envPrefix: { type: "string", description: `Variables named for secrets must start with ${STORAGE_ENV_PREFIX}.` },
    },
  },
  CertificateStorageMigration: {
    type: "object",
    properties: {
      config: {
        type: "object",
        additionalProperties: true,
        description: "A Caddy JSON config holding only this storage. Secrets are {env.NAME} placeholders, never values.",
      },
      environment: { type: "array", items: { type: "string" }, description: "The variables the config names." },
    },
  },
  CertificateStorageTestInput: {
    type: "object",
    properties: { redis: ref("RedisStorageInput") },
    additionalProperties: false,
  },
  CertificateStorageTestResult: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "Every step that ran succeeded." },
      complete: { type: "boolean", description: "False when a secret is read from the Caddy nodes' environment and could not be used here." },
      server: { type: ["string", "null"], description: "host:port that answered the storage commands." },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string", enum: [...STORAGE_TEST_STEPS] },
            ok: { type: "boolean" },
            detail: { type: "string" },
          },
        },
      },
    },
  },
};
