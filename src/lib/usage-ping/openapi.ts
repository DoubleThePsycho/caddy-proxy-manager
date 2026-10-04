/**
 * OpenAPI paths and schemas of the usage ping endpoints, spread into
 * app/api/v1/openapi.json/route.ts. The payload schema is built from the
 * field lists in payload.ts, so it cannot drift from what is sent.
 */
import {
  COUNT_BUCKETS,
  COUNT_FIELDS,
  FEATURE_FIELDS,
  USAGE_PING_ARCHES,
  USAGE_PING_EDITIONS,
  USAGE_PING_ROLES,
  USAGE_PING_SCHEMA_VERSION,
} from "./payload";
import { DEFAULT_USAGE_PING_URL } from "./env";

const TAG = "Usage Ping";

export const USAGE_PING_OPENAPI_TAG = {
  name: TAG,
  description:
    "The anonymous usage ping (free, off until an administrator says yes to the question on the overview page, or " +
    "USAGE_PING_ENABLED answers it). While it is on, once a day the install sends its version, edition, " +
    "role, bucketed counts and which features are in use, with a random install id, to " +
    `${DEFAULT_USAGE_PING_URL} (USAGE_PING_URL replaces it). Never sent: hostnames, domains, IP addresses, e-mails, names, ` +
    "license ids, configuration or logs. Sync slaves never send. Turning it off deletes the install id and asks the " +
    "receiving service to delete its data. USAGE_PING_DISABLED turns it off entirely.",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "409": { $ref: "#/components/responses/Conflict" },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};
const nullableDate = { type: ["string", "null"], format: "date-time" };

export const USAGE_PING_OPENAPI_PATHS = {
  "/api/v1/usage-ping": {
    get: {
      tags: [TAG],
      summary: "Get the usage ping setting and preview its payload",
      description:
        "Permission settings:read. `payload` is exactly what the next ping sends, built by the code that sends it; while the " +
        "usage ping is off its install_id is a placeholder. On a sync slave `payload` is null: slaves never send.",
      operationId: "getUsagePing",
      responses: { "200": { description: "Setting and preview", content: json(ref("UsagePing")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Turn the usage ping on or off",
      description:
        "Permission settings:write. Answers the overview question, or changes the answer. On creates a new random install id and " +
        "sends the first ping a few minutes later; off deletes the id and, if a ping may have reached the receiving service, asks " +
        "it to delete its data (retried for 7 days if that fails). Either answer hides the overview question for good. On is refused (409) on a sync " +
        "slave and when USAGE_PING_DISABLED is set; off always works. Audited as usage_ping_enabled / usage_ping_disabled.",
      operationId: "updateUsagePing",
      requestBody: { required: true, content: json(ref("UsagePingInput")) },
      responses: { "200": { description: "Updated", content: json(ref("UsagePing")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/usage-ping/reset-install-id": {
    post: {
      tags: [TAG],
      summary: "Reset the install id",
      description:
        "Permission settings:write. Replaces the install id (and the minute of the day the ping goes out) with new random " +
        "values, so later pings cannot be linked to earlier ones. 409 while the usage ping is off. Audited as " +
        "usage_ping_install_id_reset.",
      operationId: "resetUsagePingInstallId",
      responses: { "200": { description: "Reset", content: json(ref("UsagePing")) }, ...errors("401", "403", "409") },
    },
  },
};

export const USAGE_PING_OPENAPI_SCHEMAS = {
  UsagePingInput: {
    type: "object",
    additionalProperties: false,
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
  },
  UsagePingPayload: {
    type: "object",
    description: "Exactly what one ping sends (documentation/usage-ping.md describes each field).",
    additionalProperties: false,
    properties: {
      schema: { type: "integer", enum: [USAGE_PING_SCHEMA_VERSION] },
      install_id: { type: "string", description: "Random UUID v4, created when the ping is turned on" },
      version: { type: "string" },
      edition: { type: "string", enum: [...USAGE_PING_EDITIONS] },
      role: { type: "string", enum: [...USAGE_PING_ROLES] },
      counts: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(COUNT_FIELDS.map((field) => [field, { type: "string", enum: [...COUNT_BUCKETS] }])),
        required: [...COUNT_FIELDS],
      },
      features: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(FEATURE_FIELDS.map((field) => [field, { type: "boolean" }])),
        required: [...FEATURE_FIELDS],
      },
      arch: { type: "string", enum: [...USAGE_PING_ARCHES] },
    },
    required: ["schema", "install_id", "version", "edition", "role", "counts", "features", "arch"],
  },
  UsagePing: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "The stored answer; false while unanswered" },
      answered: { type: "boolean", description: "The question has been answered; the overview question is not shown again" },
      answeredAt: nullableDate,
      answeredBy: {
        type: ["string", "null"],
        enum: ["administrator", "environment", null],
        description: "environment: USAGE_PING_ENABLED gave the answer at start-up",
      },
      disabledByEnv: { type: "boolean", description: "USAGE_PING_DISABLED is set" },
      role: { type: "string", enum: ["standalone", "master", "slave"] },
      status: {
        type: "string",
        enum: ["on", "unanswered", "off", "disabled_by_env", "replica", "invalid_endpoint"],
        description:
          "on: pings go out; unanswered: nobody has answered the question, so nothing is sent; " +
          "invalid_endpoint: USAGE_PING_URL is not a valid https URL, so nothing is sent",
      },
      endpoint: { type: ["string", "null"] },
      endpointError: { type: ["string", "null"] },
      installId: { type: ["string", "null"] },
      nextAttemptAt: nullableDate,
      lastAttemptAt: nullableDate,
      lastSuccessAt: nullableDate,
      lastResult: { type: ["string", "null"], enum: ["sent", "failed", null] },
      lastError: { type: ["string", "null"] },
      pendingErasures: { type: "integer", description: "Deletion requests for earlier install ids not delivered yet" },
      payload: { oneOf: [ref("UsagePingPayload"), { type: "null" }] },
    },
    required: [
      "enabled",
      "answered",
      "answeredAt",
      "answeredBy",
      "disabledByEnv",
      "role",
      "status",
      "endpoint",
      "endpointError",
      "installId",
      "nextAttemptAt",
      "lastAttemptAt",
      "lastSuccessAt",
      "lastResult",
      "lastError",
      "payload",
    ],
  },
};
