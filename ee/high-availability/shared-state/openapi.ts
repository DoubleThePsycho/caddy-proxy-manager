// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the shared state endpoints (high availability
 * phase 3), spread into app/api/v1/openapi.json/route.ts.
 */
import { DEFAULT_SHARED_STATE_PREFIX, SHARED_STATE_LIMITS } from "./types";

const TAG = "High availability";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "409": { $ref: "#/components/responses/Conflict" },
    "502": {
      description:
        "This web container could not use the Redis or Valkey server, or the shared balances could not be written to the ledger; nothing was changed",
      content: json(ref("Error")),
    },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};

export const SHARED_STATE_OPENAPI_PATHS = {
  "/api/v1/high-availability/shared-state": {
    get: {
      tags: [TAG],
      summary: "Get the shared state setting",
      description:
        "Permission high_availability:read. Available without a license. Whether the web nodes keep forward-auth sessions, exchange " +
        "codes, redirect intents and API monetization balances in Redis or Valkey (the certificate storage's server) instead of their own " +
        "database and memory. No secrets.",
      operationId: "getSharedState",
      responses: { "200": { description: "Shared state", content: json(ref("SharedState")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Turn shared state on or off",
      description:
        "Permission high_availability:write (administrator-level). {enabled?, keyPrefix?}; a missing field keeps the stored value. Turning " +
        "shared state on, or changing the prefix while on, needs the high_availability feature (403 otherwise) and the certificate " +
        "storage's Redis or Valkey settings (saved, enabled or not); this web container must reach the server (502 otherwise). Turning it " +
        "off, or moving to another prefix, first writes the shared API balances to the ledger and refuses (502) when it cannot. Either way " +
        "users signed in through Ingressi forward auth sign in again once. 409 on a sync slave.",
      operationId: "setSharedState",
      requestBody: { required: true, content: json(ref("SharedStateInput")) },
      responses: { "200": { description: "Saved", content: json(ref("SharedState")) }, ...errors("400", "401", "403", "409", "502") },
    },
    delete: {
      tags: [TAG],
      summary: "Remove the shared state setting",
      description:
        "Permission high_availability:write. Turns shared state off and forgets the setting even when the server cannot be reached: the " +
        "shared balances are written to the ledger when it answers, otherwise usage and credits not yet in the ledger are lost. Never " +
        "needs a license.",
      operationId: "removeSharedState",
      responses: { "200": { description: "Removed", content: json(ref("SharedState")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/high-availability/shared-state/status": {
    get: {
      tags: [TAG],
      summary: "Get the shared state status",
      description:
        "Permission high_availability:read. Whether this web container reaches the server, how many forward-auth sessions and API " +
        "consumers it holds, credits not yet written to the ledger, and the leader's last write-back. Read-only; no secrets.",
      operationId: "getSharedStateStatus",
      responses: { "200": { description: "Status", content: json(ref("SharedStateStatus")) }, ...errors("401", "403") },
    },
  },
};

export const SHARED_STATE_OPENAPI_SCHEMAS = {
  SharedStateInput: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "Missing: true when nothing is stored yet, otherwise the stored value." },
      keyPrefix: {
        type: "string",
        default: DEFAULT_SHARED_STATE_PREFIX,
        maxLength: SHARED_STATE_LIMITS.keyPrefix,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
        description: "Start of every key (followed by a generation that changes each time shared state is turned on).",
      },
    },
    additionalProperties: false,
  },
  SharedState: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      backend: { type: "string", enum: ["local", "redis"], description: "What request paths use now: redis only when enabled and usable." },
      keyPrefix: { type: "string" },
      namespace: { type: ["string", "null"], description: "<keyPrefix>:<generation>: while on." },
      connection: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["certificate_storage"] },
          configured: { type: "boolean", description: "The certificate storage has Redis or Valkey settings." },
          mode: { type: ["string", "null"] },
          addresses: { type: "array", items: { type: "string" } },
          tls: { type: "boolean" },
        },
      },
      updatedAt: { type: ["string", "null"], format: "date-time" },
      configurable: { type: "boolean", description: "The license lets this instance turn shared state on or change it." },
      editable: { type: "boolean", description: "False on a sync slave." },
      error: { type: ["string", "null"], description: "Shared state is on but cannot be used; request paths fail closed." },
    },
  },
  SharedStateStatus: {
    type: "object",
    properties: {
      backend: { type: "string", enum: ["local", "redis"] },
      reachable: { type: ["boolean", "null"], description: "Null while shared state is off." },
      error: { type: ["string", "null"] },
      keys: {
        oneOf: [
          {
            type: "object",
            properties: {
              forwardAuthSessions: { type: "integer" },
              monetizationConsumers: { type: "integer", description: "API consumers with shared balances." },
              pendingCredits: { type: "integer", description: "Top-ups and adjustments not yet written to the ledger." },
            },
          },
          { type: "null" },
        ],
      },
      drain: {
        oneOf: [
          {
            type: "object",
            properties: {
              at: { type: ["string", "null"], format: "date-time" },
              consumers: { type: "integer" },
              credits: { type: "integer" },
              error: { type: ["string", "null"] },
            },
          },
          { type: "null" },
        ],
        description: "The leader's last write-back of shared usage and credits to the ledger.",
      },
      leader: { type: "boolean", description: "This node writes shared state back to the database." },
    },
  },
};
