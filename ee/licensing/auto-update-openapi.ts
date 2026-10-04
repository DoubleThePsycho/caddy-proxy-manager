// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of automatic license updates, spread into
 * app/api/v1/openapi.json/route.ts under the License tag.
 */
import { DEFAULT_LICENSE_SERVER_URL } from "./auto-update-env";

const TAG = "License";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "409": { $ref: "#/components/responses/Conflict" },
    "429": {
      description: "The license server was asked less than a minute ago",
      content: json({ type: "object", properties: { error: { type: "string" } }, required: ["error"] }),
    },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};
const nullableDate = { type: ["string", "null"], format: "date-time" };

const WHAT_IS_SENT =
  `While it is on, the leader node (a standalone install or the instance sync master, never a replica) asks the license server ` +
  `(${DEFAULT_LICENSE_SERVER_URL}, or LICENSE_SERVER_URL) once a day for the current key of the installed license: ` +
  "GET /v1/licenses/{licenseId}/current with the license's refresh token as a bearer token. Nothing else is sent. A returned " +
  "key is installed only if its signature verifies with the public keys built into this release, it is for the same license id " +
  "and it was issued after the installed key. Off by default; LICENSE_AUTO_UPDATE_DISABLED forbids it.";

export const LICENSE_AUTO_UPDATE_OPENAPI_PATHS = {
  "/api/v1/license/auto-update": {
    get: {
      tags: [TAG],
      summary: "Get the automatic license update setting and its last results",
      description: `Permission license:read. The refresh token is never returned (see hasRefreshToken). ${WHAT_IS_SENT}`,
      operationId: "getLicenseAutoUpdate",
      responses: { "200": { description: "Setting and status", content: json(ref("LicenseAutoUpdate")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Turn automatic license updates on or off, or replace the refresh token",
      description:
        "Permission license:write. On needs a valid installed license and its refresh token (from the license e-mail; it can be " +
        "left out when one is already stored for the installed license). The license server is asked at once: a token it does not " +
        "accept is refused (400) and nothing is stored; a newer key it returns is installed. Refused (409) on a sync replica, with " +
        "LICENSE_AUTO_UPDATE_DISABLED, with an invalid LICENSE_SERVER_URL, or without a valid license. Off deletes the stored " +
        "token and always works. Audited as license_auto_update_enabled, license_auto_update_token_replaced or " +
        "license_auto_update_disabled; an installed key as license_auto_updated.",
      operationId: "updateLicenseAutoUpdate",
      requestBody: { required: true, content: json(ref("LicenseAutoUpdateInput")) },
      responses: { "200": { description: "Updated", content: json(ref("LicenseAutoUpdate")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/license/auto-update/check": {
    post: {
      tags: [TAG],
      summary: "Ask the license server for a renewed key now",
      description:
        "Permission license:write. One check outside the daily slot; a newer key is installed under the same rules and audited " +
        "as license_auto_updated. 409 while automatic updates do not apply (off, replica, disabled, invalid endpoint, no license, " +
        "or a token for another license); 429 when the server was asked less than a minute ago.",
      operationId: "checkLicenseAutoUpdate",
      responses: { "200": { description: "Checked", content: json(ref("LicenseAutoUpdate")) }, ...errors("401", "403", "409", "429") },
    },
  },
};

export const LICENSE_AUTO_UPDATE_OPENAPI_SCHEMAS = {
  LicenseAutoUpdateInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      refreshToken: {
        type: "string",
        writeOnly: true,
        pattern: "^lrt_[A-Za-z0-9_-]{43}$",
        description: "The refresh token from the license e-mail. Only with enabled true; stored encrypted and never returned.",
      },
    },
    required: ["enabled"],
  },
  LicenseAutoUpdate: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      hasRefreshToken: { type: "boolean", description: "A refresh token is stored; the token itself is never returned" },
      licenseId: { type: ["string", "null"], description: "The license the stored refresh token belongs to" },
      disabledByEnv: { type: "boolean", description: "LICENSE_AUTO_UPDATE_DISABLED is set" },
      role: { type: "string", enum: ["standalone", "master", "slave"] },
      status: {
        type: "string",
        enum: ["on", "off", "disabled_by_env", "replica", "invalid_endpoint", "license_mismatch", "no_license"],
        description:
          "on: checked once a day; replica: replicas never check; invalid_endpoint: LICENSE_SERVER_URL is not a valid https URL, " +
          "so nothing is sent; license_mismatch: the installed license is not the one the refresh token belongs to, so nothing " +
          "is sent; no_license: no valid license is installed",
      },
      endpoint: { type: ["string", "null"], description: "The license server" },
      endpointError: { type: ["string", "null"] },
      nextCheckAt: nullableDate,
      lastCheckAt: nullableDate,
      lastSuccessAt: { ...nullableDate, description: "The last time the license server answered with a key" },
      lastResult: {
        type: ["string", "null"],
        enum: ["updated", "current", "failed", "revoked", null],
        description:
          "updated: a newer key was installed; current: the installed key is the newest; failed: see lastError; revoked: the " +
          "license server says the license was revoked (the installed key keeps working until it expires)",
      },
      lastError: { type: ["string", "null"] },
      lastUpdatedAt: { ...nullableDate, description: "The last time a newer key was installed" },
    },
    required: [
      "enabled",
      "hasRefreshToken",
      "licenseId",
      "disabledByEnv",
      "role",
      "status",
      "endpoint",
      "endpointError",
      "nextCheckAt",
      "lastCheckAt",
      "lastSuccessAt",
      "lastResult",
      "lastError",
      "lastUpdatedAt",
    ],
  },
};
