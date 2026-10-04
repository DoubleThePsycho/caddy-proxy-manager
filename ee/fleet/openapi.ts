// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the fleet management endpoints, spread into
 * app/api/v1/openapi.json/route.ts.
 */

const TAG = "Fleet";

export const FLEET_OPENAPI_TAG = {
  name: TAG,
  description:
    "Fleet management (Enterprise edition): environments of slave instances in promotion order, revisions that promotion-only " +
    "environments are pinned to, promotions with canary rollout, rollbacks, and drift detection. Master mode. Creating and " +
    "changing environments, assigning instances and starting promotions or rollbacks need the fleet feature; deleting " +
    "environments, turning promotion-only off, taking instances out, aborting rollouts, re-syncing and drift checks never do, " +
    "and running rollouts and syncs never check the license. Permissions: fleet:read, fleet:write (environments, assignments, " +
    "drift checks), fleet:promote (promotions, rollbacks, aborts, re-syncs) and fleet:replicas (pull replicas and their " +
    "credentials; administrator-level). Releasing instances from a promotion-only environment also needs fleet:promote. Pull " +
    "replicas poll POST /api/instances/pull with their own credential (not part of this API); adding one and rotating its " +
    "credential need the fleet feature, revoking and deleting never do.",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const idParam = { $ref: "#/components/parameters/IdPath" };
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
    "409": { $ref: "#/components/responses/Conflict" },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};
const nullable = (schema: Record<string, unknown>) => ({ oneOf: [schema, { type: "null" }] });

export const FLEET_OPENAPI_PATHS = {
  "/api/v1/fleet": {
    get: {
      tags: [TAG],
      summary: "Fleet overview",
      description: "Permission fleet:read. Environments, instances with their revision and drift, the newest revisions and rollouts.",
      operationId: "getFleetOverview",
      responses: { "200": { description: "Overview", content: json(ref("FleetOverview")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/fleet/environments": {
    get: {
      tags: [TAG],
      summary: "List environments",
      description: "Permission fleet:read. In promotion order.",
      operationId: "listFleetEnvironments",
      responses: { "200": { description: "Environments", content: json({ type: "array", items: ref("FleetEnvironment") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create an environment",
      description: "Permission fleet:write; needs the fleet feature. 409 for a duplicate name.",
      operationId: "createFleetEnvironment",
      requestBody: { required: true, content: json(ref("FleetEnvironmentInput")) },
      responses: { "201": { description: "Created", content: json(ref("FleetEnvironment")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/fleet/environments/{id}": {
    get: {
      tags: [TAG],
      summary: "Get an environment",
      operationId: "getFleetEnvironment",
      parameters: [idParam],
      responses: { "200": { description: "Environment", content: json(ref("FleetEnvironment")) }, ...errors("401", "403", "404") },
    },
    patch: {
      tags: [TAG],
      summary: "Update an environment",
      description:
        "Permission fleet:write. Fields left out keep their values. Needs the fleet feature unless the body is exactly " +
        '{"promotionOnly": false}. Turning promotion-only off drops the pinned revision and, when the environment has ' +
        "instances, also needs fleet:promote (403 otherwise): they then receive every change, from the next change or sync on. " +
        "409 while a rollout runs in the environment.",
      operationId: "updateFleetEnvironment",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("FleetEnvironmentUpdate")) },
      responses: { "200": { description: "Updated", content: json(ref("FleetEnvironment")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete an environment",
      description:
        "Permission fleet:write; never needs a license. Its instances lose their environment and its rollouts are deleted. " +
        "Deleting a promotion-only environment with instances also needs fleet:promote. 409 while a rollout runs there.",
      operationId: "deleteFleetEnvironment",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/instances": {
    get: {
      tags: [TAG],
      summary: "List instances",
      description: "Permission fleet:read. Every slave instance configured in the database, with its environment, revision and drift.",
      operationId: "listFleetInstances",
      responses: { "200": { description: "Instances", content: json({ type: "array", items: ref("FleetInstance") }) }, ...errors("401", "403") },
    },
  },
  "/api/v1/fleet/instances/{id}/environment": {
    put: {
      tags: [TAG],
      summary: "Assign an instance to an environment",
      description:
        "Permission fleet:write. Assigning needs the fleet feature; {\"environmentId\": null} (taking it out) does not. Leaving a " +
        "promotion-only environment for none or for one that receives every change also needs fleet:promote. Nothing is pushed. " +
        "409 while a rollout runs in either environment.",
      operationId: "assignFleetInstance",
      parameters: [idParam],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          properties: { environmentId: { type: ["integer", "null"] } },
          required: ["environmentId"],
          additionalProperties: false,
        }),
      },
      responses: { "200": { description: "The instance", content: json(ref("FleetInstance")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/instances/{id}/resync": {
    post: {
      tags: [TAG],
      summary: "Re-sync an instance",
      description:
        "Permission fleet:promote; never needs a license. Pushes what the instance should run: its promotion-only environment's " +
        "revision, or the master's configuration. The manual repair for a drifted instance. A pull replica is asked to take it " +
        "with its next poll (`pending: true`), even when it reports it runs it. 409 in slave or standalone mode, while " +
        "a rollout runs in its environment, or when that environment has no revision yet.",
      operationId: "resyncFleetInstance",
      parameters: [idParam],
      responses: { "200": { description: "Result", content: json(ref("FleetResyncResult")) }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/drift": {
    get: {
      tags: [TAG],
      summary: "Drift status",
      description: "Permission fleet:read. Every instance with its drift status as of the last check.",
      operationId: "getFleetDrift",
      responses: { "200": { description: "Instances", content: json({ type: "array", items: ref("FleetInstance") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Check drift now",
      description:
        "Permission fleet:write; never needs a license. Asks every enabled instance which configuration it runs (GET " +
        "/api/instances/sync?status=1 on the slave; a pull replica's last report instead) and returns the instances afterwards.",
      operationId: "checkFleetDrift",
      responses: { "200": { description: "Instances", content: json({ type: "array", items: ref("FleetInstance") }) }, ...errors("401", "403") },
    },
  },
  "/api/v1/fleet/revisions": {
    get: {
      tags: [TAG],
      summary: "List revisions",
      description: "Permission fleet:read. Newest first, without their content.",
      operationId: "listFleetRevisions",
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
      ],
      responses: {
        "200": {
          description: "Revisions",
          content: json({
            type: "object",
            properties: { revisions: { type: "array", items: ref("FleetRevision") }, total: { type: "integer" } },
            required: ["revisions", "total"],
          }),
        },
        ...errors("401", "403"),
      },
    },
  },
  "/api/v1/fleet/revisions/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a revision",
      operationId: "getFleetRevision",
      parameters: [idParam],
      responses: { "200": { description: "Revision", content: json(ref("FleetRevision")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/fleet/revisions/{id}/diff": {
    get: {
      tags: [TAG],
      summary: "Diff a revision",
      description:
        "Permission fleet:read. Changes from `against` (previous, the default; current, the master's configuration; or a revision " +
        "id) to the revision. Secrets are never returned, only that they changed.",
      operationId: "diffFleetRevision",
      parameters: [idParam, { name: "against", in: "query", schema: { type: "string", examples: ["previous", "current", "3"] } }],
      responses: { "200": { description: "Diff", content: json(ref("FleetRevisionDiff")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/promotions/preview": {
    get: {
      tags: [TAG],
      summary: "Preview a promotion",
      description:
        "Permission fleet:read. What promoting into the environment would roll out (what the environment before it runs, or the " +
        "master's configuration for the first one), the diff against the revision it is pinned to, the targets and warnings. " +
        "409 for an environment that receives every change, or when the one before it has no revision yet.",
      operationId: "previewFleetPromotion",
      parameters: [{ name: "environmentId", in: "query", required: true, schema: { type: "integer" } }],
      responses: { "200": { description: "Preview", content: json(ref("FleetPromotionPreview")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/rollouts": {
    get: {
      tags: [TAG],
      summary: "List rollouts",
      description: "Permission fleet:read. Newest first, with their targets.",
      operationId: "listFleetRollouts",
      parameters: [
        { name: "environmentId", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 25 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
      ],
      responses: {
        "200": {
          description: "Rollouts",
          content: json({
            type: "object",
            properties: { rollouts: { type: "array", items: ref("FleetRollout") }, total: { type: "integer" } },
            required: ["rollouts", "total"],
          }),
        },
        ...errors("400", "401", "403"),
      },
    },
    post: {
      tags: [TAG],
      summary: "Start a promotion",
      description:
        "Permission fleet:promote; needs the fleet feature and master mode. Promotes into a promotion-only environment what the " +
        "environment before it runs (capturing the master's configuration as a revision when needed), with the environment's " +
        "canary settings unless `canary` overrides them (false: no canary). The rollout runs in the background; poll GET " +
        "/api/v1/fleet/rollouts/{id}. 409 while another rollout runs there or when everything already runs that revision.",
      operationId: "startFleetPromotion",
      requestBody: { required: true, content: json(ref("FleetPromotionInput")) },
      responses: { "201": { description: "The rollout", content: json(ref("FleetRollout")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/rollouts/{id}": {
    get: {
      tags: [TAG],
      summary: "Rollout status",
      operationId: "getFleetRollout",
      parameters: [idParam],
      responses: { "200": { description: "Rollout", content: json(ref("FleetRollout")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/fleet/rollouts/{id}/abort": {
    post: {
      tags: [TAG],
      summary: "Abort a rollout",
      description:
        "Permission fleet:promote; never needs a license. Instances already pushed keep the new revision; the others and the " +
        "environment stay where they are. 409 when the rollout is not running.",
      operationId: "abortFleetRollout",
      parameters: [idParam],
      responses: { "200": { description: "The rollout", content: json(ref("FleetRollout")) }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/rollouts/{id}/rollback": {
    post: {
      tags: [TAG],
      summary: "Roll back a rollout",
      description:
        "Permission fleet:promote; needs the fleet feature. Promotes the revision the environment ran before the rollout, without " +
        "a canary unless the body asks for one. Only for the latest rollout of an environment once it stopped.",
      operationId: "rollbackFleetRollout",
      parameters: [idParam],
      requestBody: {
        required: false,
        content: json({ type: "object", properties: { canary: ref("FleetCanaryInput") }, additionalProperties: false }),
      },
      responses: { "201": { description: "The rollback rollout", content: json(ref("FleetRollout")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/fleet/pull-replicas": {
    get: {
      tags: [TAG],
      summary: "List pull replicas",
      description: "Permission fleet:read. Pull replicas with their last check-in, key pin and credential prefix; never the credential.",
      operationId: "listFleetPullReplicas",
      responses: { "200": { description: "Pull replicas", content: json({ type: "array", items: ref("FleetPullReplica") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Add a pull replica",
      description:
        "Permission fleet:replicas (administrator-level); needs the fleet feature. Creates an instance that fetches its " +
        "configuration from this master, and its credential. The credential and the replica's environment variables are in " +
        "this reply only; the master keeps the credential's hash. `syncPublicKey` (the replica's sync public key, from its " +
        "own Instance Sync settings) pins its key at once; otherwise the first key it proves is pinned.",
      operationId: "createFleetPullReplica",
      requestBody: { required: true, content: json(ref("FleetPullReplicaInput")) },
      responses: { "201": { description: "The replica and its credential", content: json(ref("FleetPullCredential")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/fleet/pull-replicas/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a pull replica",
      operationId: "getFleetPullReplica",
      parameters: [idParam],
      responses: { "200": { description: "Pull replica", content: json(ref("FleetPullReplica")) }, ...errors("401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a pull replica",
      description: "Permission fleet:replicas; never needs a license. Removes the instance with its credential, key pin and fleet records.",
      operationId: "deleteFleetPullReplica",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/fleet/pull-replicas/{id}/credential": {
    post: {
      tags: [TAG],
      summary: "Rotate a pull replica's credential",
      description:
        "Permission fleet:replicas; needs the fleet feature. Issues a new credential (also after a revocation); the old one " +
        "stops working at once. The key pin stays. The credential is in this reply only.",
      operationId: "rotateFleetPullCredential",
      parameters: [idParam],
      responses: { "200": { description: "The replica and its new credential", content: json(ref("FleetPullCredential")) }, ...errors("401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Revoke a pull replica's credential",
      description:
        "Permission fleet:replicas; never needs a license. The replica's polls are refused (401) until a new credential is " +
        "issued; the replica, its key pin and its history stay.",
      operationId: "revokeFleetPullCredential",
      parameters: [idParam],
      responses: { "200": { description: "The replica", content: json(ref("FleetPullReplica")) }, ...errors("401", "403", "404") },
    },
  },
};

const driftStatus = { type: "string", enum: ["in_sync", "drifted", "unreachable", "older_version", "unknown"] };
const pullCheckIn = {
  type: "string",
  enum: ["never", "ok", "missed"],
  description: "never: no poll yet; missed: no poll for 3 poll intervals",
};

const canary = {
  type: "object",
  properties: {
    enabled: { type: "boolean", description: "Roll out to one instance first" },
    waitSeconds: { type: "integer", minimum: 0, maximum: 86400, description: "How long the canary is observed" },
    checkCaddyStatus: { type: "boolean", description: "Also check the canary's Caddy apply status and fingerprint" },
  },
};

export const FLEET_OPENAPI_SCHEMAS = {
  FleetEnvironment: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      description: { type: ["string", "null"] },
      position: { type: "integer", description: "Promotion order, lowest first" },
      promotionOnly: { type: "boolean", description: "Receives configuration only through promotions" },
      revisionId: { type: ["integer", "null"], description: "The revision a promotion-only environment is pinned to" },
      canary: { ...canary, required: ["enabled", "waitSeconds", "checkCaddyStatus"] },
      instanceIds: { type: "array", items: { type: "integer" } },
      activeRolloutId: { type: ["integer", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name", "description", "position", "promotionOnly", "revisionId", "canary", "instanceIds", "activeRolloutId", "createdAt", "updatedAt"],
  },
  FleetEnvironmentInput: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      description: { type: ["string", "null"], maxLength: 500 },
      position: { type: "integer", minimum: 0, maximum: 10000, description: "Default: after the last environment" },
      promotionOnly: { type: "boolean", default: false },
      canary,
    },
    required: ["name"],
    additionalProperties: false,
  },
  FleetEnvironmentUpdate: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      description: { type: ["string", "null"], maxLength: 500 },
      position: { type: "integer", minimum: 0, maximum: 10000 },
      promotionOnly: { type: "boolean" },
      canary,
    },
    additionalProperties: false,
  },
  FleetInstance: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      baseUrl: { type: "string", description: 'For a pull replica its identity ("pull:" and a random id); nothing is sent there' },
      syncMode: { type: "string", enum: ["push", "pull"] },
      pull: nullable({
        type: "object",
        description: "For a pull replica: its last check-in",
        properties: {
          lastSeenAt: { type: ["string", "null"], format: "date-time" },
          pollIntervalSeconds: { type: ["integer", "null"] },
          checkIn: pullCheckIn,
          hasCredential: { type: "boolean" },
        },
        required: ["lastSeenAt", "pollIntervalSeconds", "checkIn", "hasCredential"],
      }),
      enabled: { type: "boolean" },
      environmentId: { type: ["integer", "null"] },
      revisionId: { type: ["integer", "null"], description: "Revision of the last successful push; null for the live configuration" },
      pushedAt: { type: ["string", "null"], format: "date-time" },
      lastSyncAt: { type: ["string", "null"], format: "date-time" },
      lastSyncError: { type: ["string", "null"] },
      drift: {
        type: "object",
        properties: {
          status: nullable(driftStatus),
          checkedAt: { type: ["string", "null"], format: "date-time" },
          since: { type: ["string", "null"], format: "date-time", description: "When it was found drifted" },
          detail: { type: ["string", "null"] },
          reportedVersion: { type: ["string", "null"], description: "The release the instance runs, when it reports one" },
          localChanges: { type: ["boolean", "null"], description: "Its synced configuration was changed on the instance" },
        },
        required: ["status", "checkedAt", "since", "detail", "reportedVersion", "localChanges"],
      },
    },
    required: ["id", "name", "baseUrl", "syncMode", "pull", "enabled", "environmentId", "revisionId", "pushedAt", "lastSyncAt", "lastSyncError", "drift"],
  },
  FleetRevision: {
    type: "object",
    properties: {
      id: { type: "integer" },
      createdAt: { type: "string", format: "date-time" },
      createdBy: { type: ["integer", "null"] },
      createdByName: { type: ["string", "null"] },
      summary: { type: "string" },
      fingerprint: { type: "string", description: "SHA-256 of the canonical content (secrets as keyed digests)" },
      sizeBytes: { type: "integer" },
    },
    required: ["id", "createdAt", "createdBy", "createdByName", "summary", "fingerprint", "sizeBytes"],
  },
  FleetConfigDiff: {
    type: "object",
    properties: {
      entities: { type: "array", items: ref("ConfigEntityDiff") },
      totals: {
        type: "object",
        properties: { added: { type: "integer" }, removed: { type: "integer" }, changed: { type: "integer" } },
      },
    },
    required: ["entities", "totals"],
  },
  FleetRevisionDiff: {
    type: "object",
    properties: {
      revision: ref("FleetRevision"),
      against: {
        type: "object",
        properties: { kind: { type: "string", enum: ["current", "revision", "empty"] }, id: { type: "integer" } },
        required: ["kind"],
      },
      diff: ref("FleetConfigDiff"),
    },
    required: ["revision", "against", "diff"],
  },
  FleetCanaryInput: {
    oneOf: [
      {
        type: "object",
        properties: {
          ...canary.properties,
          instanceId: { type: ["integer", "null"], description: "Default: the environment's enabled instance with the lowest id" },
        },
        additionalProperties: false,
      },
      { type: "boolean", enum: [false] },
      { type: "null" },
    ],
  },
  FleetPromotionInput: {
    type: "object",
    properties: { environmentId: { type: "integer" }, canary: ref("FleetCanaryInput") },
    required: ["environmentId"],
    additionalProperties: false,
  },
  FleetPromotionPreview: {
    type: "object",
    properties: {
      environmentId: { type: "integer" },
      environmentName: { type: "string" },
      source: {
        type: "object",
        properties: {
          environmentId: { type: ["integer", "null"] },
          environmentName: { type: ["string", "null"] },
          revisionId: { type: ["integer", "null"], description: "Null: the master's current configuration, captured on start" },
        },
        required: ["environmentId", "environmentName", "revisionId"],
      },
      currentRevisionId: { type: ["integer", "null"] },
      diff: ref("FleetConfigDiff"),
      upToDate: { type: "boolean" },
      targets: {
        type: "array",
        items: {
          type: "object",
          properties: { instanceId: { type: "integer" }, name: { type: "string" }, revisionId: { type: ["integer", "null"] } },
        },
      },
      canary: {
        type: "object",
        properties: { ...canary.properties, instanceId: { type: ["integer", "null"] } },
      },
      warnings: { type: "array", items: { type: "string" } },
    },
    required: ["environmentId", "environmentName", "source", "currentRevisionId", "diff", "upToDate", "targets", "canary", "warnings"],
  },
  FleetRollout: {
    type: "object",
    properties: {
      id: { type: "integer" },
      environmentId: { type: "integer" },
      environmentName: { type: ["string", "null"] },
      revisionId: { type: "integer" },
      fromRevisionId: { type: ["integer", "null"], description: "What a rollback restores" },
      kind: { type: "string", enum: ["promotion", "rollback"] },
      sourceEnvironmentId: { type: ["integer", "null"] },
      rollbackOfId: { type: ["integer", "null"] },
      status: { type: "string", enum: ["running", "succeeded", "failed", "aborted"] },
      phase: { type: "string", enum: ["canary", "observing", "rolling", "done"] },
      canary: {
        type: "object",
        properties: {
          instanceId: { type: ["integer", "null"] },
          waitSeconds: { type: "integer" },
          checkCaddyStatus: { type: "boolean" },
          observeUntil: { type: ["string", "null"], format: "date-time" },
        },
        required: ["instanceId", "waitSeconds", "checkCaddyStatus", "observeUntil"],
      },
      error: { type: ["string", "null"] },
      startedBy: { type: ["integer", "null"] },
      startedByName: { type: ["string", "null"], description: "Name or email of that user; null for the system or a deleted user" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      finishedAt: { type: ["string", "null"], format: "date-time" },
      targets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            instanceId: { type: "integer" },
            instanceName: { type: "string" },
            role: { type: "string", enum: ["canary", "rest"] },
            status: { type: "string", enum: ["pending", "synced", "failed", "skipped"] },
            error: { type: ["string", "null"] },
            syncedAt: { type: ["string", "null"], format: "date-time" },
          },
          required: ["instanceId", "instanceName", "role", "status", "error", "syncedAt"],
        },
      },
    },
    required: [
      "id", "environmentId", "environmentName", "revisionId", "fromRevisionId", "kind", "sourceEnvironmentId", "rollbackOfId",
      "status", "phase", "canary", "error", "startedBy", "startedByName", "createdAt", "updatedAt", "finishedAt", "targets",
    ],
  },
  FleetResyncResult: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      error: { type: ["string", "null"] },
      revisionId: { type: ["integer", "null"], description: "The revision pushed; null for the master's configuration" },
      instance: nullable(ref("FleetInstance")),
      pending: { type: "boolean", description: "A pull replica: sent with its next poll, confirmed by its report" },
    },
    required: ["ok", "error", "revisionId", "instance"],
  },
  FleetCertificateStorage: {
    type: "object",
    description: "Where a configuration keeps Caddy's certificates: the backend and Redis mode only, never addresses or secrets",
    properties: {
      backend: { type: "string", enum: ["local", "redis"] },
      redisMode: { type: ["string", "null"], enum: ["standalone", "cluster", "sentinel", null] },
    },
    required: ["backend", "redisMode"],
  },
  FleetOverview: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["standalone", "master", "slave"] },
      master: {
        type: "object",
        description: "The master itself, which is not one of the instances",
        properties: {
          version: { type: "string", description: "The release this dashboard runs" },
          certificateStorage: ref("FleetCertificateStorage"),
          driftCheckIntervalSeconds: { type: "integer" },
          rolloutStepSeconds: { type: "integer", description: "How often a running rollout moves on and its canary is checked" },
        },
        required: ["version", "certificateStorage", "driftCheckIntervalSeconds", "rolloutStepSeconds"],
      },
      environments: { type: "array", items: ref("FleetEnvironment") },
      instances: { type: "array", items: ref("FleetInstance") },
      revisions: { type: "array", items: ref("FleetRevision") },
      rollouts: { type: "array", items: ref("FleetRollout") },
      pullReplicas: { type: "array", items: ref("FleetPullReplica") },
      revisionStorage: {
        type: "object",
        description: "The certificate storage of each revision an environment, an instance or a running rollout refers to, by revision id",
        additionalProperties: ref("FleetCertificateStorage"),
      },
    },
    required: ["mode", "master", "environments", "instances", "revisions", "rollouts", "pullReplicas", "revisionStorage"],
  },
  FleetPullReplica: {
    type: "object",
    properties: {
      id: { type: "integer", description: "The instance id" },
      name: { type: "string" },
      enabled: { type: "boolean" },
      environmentId: { type: ["integer", "null"] },
      hasCredential: { type: "boolean", description: "False once revoked" },
      credentialPrefix: { type: ["string", "null"], description: "The start of the credential, to tell credentials apart" },
      credentialCreatedAt: { type: ["string", "null"], format: "date-time" },
      syncKeyPin: nullable({
        type: "object",
        properties: {
          keyId: { type: "string" },
          publicKey: { type: "string" },
          pinnedAt: { type: "string", format: "date-time" },
          source: { type: "string", description: "first-use, rotation, manual (or unreadable)" },
        },
        required: ["keyId", "publicKey", "pinnedAt", "source"],
      }),
      lastSeenAt: { type: ["string", "null"], format: "date-time", description: "Its last poll that authenticated and proved its key" },
      lastSeenAddress: { type: ["string", "null"], description: "The client address of that poll, as the master saw it" },
      pollIntervalSeconds: { type: ["integer", "null"] },
      checkIn: pullCheckIn,
      reportedVersion: { type: ["string", "null"] },
      caddy: nullable({
        type: "object",
        properties: { ok: { type: "boolean" }, at: { type: "string", format: "date-time" }, code: { type: ["string", "null"] } },
        required: ["ok", "at", "code"],
      }),
      deliveredAt: { type: ["string", "null"], format: "date-time", description: "When the master last sent it a configuration" },
      deliveredRevisionId: { type: ["integer", "null"], description: "That configuration's revision; null for the live one" },
      resyncPending: { type: "boolean" },
      lastSyncAt: { type: ["string", "null"], format: "date-time" },
      lastSyncError: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
    },
    required: [
      "id", "name", "enabled", "environmentId", "hasCredential", "credentialPrefix", "credentialCreatedAt", "syncKeyPin",
      "lastSeenAt", "lastSeenAddress", "pollIntervalSeconds", "checkIn", "reportedVersion", "caddy", "deliveredAt",
      "deliveredRevisionId", "resyncPending", "lastSyncAt", "lastSyncError", "createdAt",
    ],
  },
  FleetPullReplicaInput: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      enabled: { type: "boolean", default: true },
      syncPublicKey: { type: ["string", "null"], description: "The replica's sync public key (base64 of 32 bytes), to pin it now" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  FleetPullCredential: {
    type: "object",
    properties: {
      replica: ref("FleetPullReplica"),
      credential: { type: "string", description: "pull_…; INSTANCE_PULL_TOKEN on the replica. Shown only in this reply" },
      env: { type: "string", description: "The environment variables for the replica, the credential included" },
    },
    required: ["replica", "credential", "env"],
  },
};
