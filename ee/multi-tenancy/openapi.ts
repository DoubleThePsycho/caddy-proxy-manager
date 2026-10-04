// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the multi-tenancy endpoints, spread into
 * app/api/v1/openapi.json/route.ts.
 */

const TAG = "Organizations";

export const MULTI_TENANCY_OPENAPI_TAG = {
  name: TAG,
  description:
    "Multi-tenancy (MSP edition): client organisations with their own administrators, hosts and usage reports. A user " +
    "belongs to the provider level or to one organisation. Organisation users only ever reach their organisation's proxy " +
    "hosts, certificates, access lists, groups, users, analytics and audit log: a row of another organisation answers 404 " +
    "like a missing one, and lists are filtered. They hold at most the organisation permissions (proxy_hosts, " +
    "certificates, access_lists, groups and users read/write, analytics:read, audit_log:read, api_docs:read, " +
    "usage_reports:read), whatever their role; org_admin holds all of them. Provider-level callers can filter the lists " +
    "of those resources with ?organizationId=<id> (or \"provider\") and create a row inside an organisation with " +
    "organizationId in the body (needs organizations:write and the license). Creating organisations, changing them " +
    "(except disabling) and moving rows into one need the multi_tenancy feature; disabling, deleting and moving rows out " +
    "never do, and isolation never checks the license.",
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

/** The ?organizationId= filter of the provider-level lists. */
export const ORGANIZATION_FILTER_PARAMETER = {
  name: "organizationId",
  in: "query",
  required: false,
  description:
    "Provider-level callers: only rows of this organisation, or \"provider\" for provider-level rows. Ignored for " +
    "organisation users, who always get their own organisation's rows.",
  schema: { type: "string" },
};

export const MULTI_TENANCY_OPENAPI_PATHS = {
  "/api/v1/organizations": {
    get: {
      tags: [TAG],
      summary: "List organisations",
      description: "Permission organizations:read. With the number of proxy hosts, certificates, access lists, groups and users each owns.",
      operationId: "listOrganizations",
      responses: { "200": { description: "Organisations", content: json({ type: "array", items: ref("Organization") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create an organisation",
      description:
        "Permission organizations:write (administrator-level); needs the multi_tenancy feature. The slug is derived from the " +
        "name when left out. 409 for a slug in use.",
      operationId: "createOrganization",
      requestBody: { required: true, content: json(ref("OrganizationInput")) },
      responses: { "201": { description: "Created", content: json(ref("Organization")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/organizations/{id}": {
    get: {
      tags: [TAG],
      summary: "Get an organisation",
      description: "Permission organizations:read.",
      operationId: "getOrganization",
      parameters: [idParam],
      responses: { "200": { description: "Organisation", content: json(ref("Organization")) }, ...errors("401", "403", "404") },
    },
    patch: {
      tags: [TAG],
      summary: "Update an organisation",
      description:
        "Permission organizations:write. Fields left out keep their values. Needs the multi_tenancy feature unless the only " +
        "change is {\"enabled\": false}. A disabled organisation's users cannot sign in (their sessions end, their API tokens " +
        "and forward-auth sign-ins stop working); its hosts keep serving traffic.",
      operationId: "updateOrganization",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("OrganizationInput")) },
      responses: { "200": { description: "Updated", content: json(ref("Organization")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete an organisation",
      description:
        "Permission organizations:write; never needs a license. 409 while the organisation still owns proxy hosts, " +
        "certificates, access lists, groups or users: move or delete them first. Its audit events stay for the provider level.",
      operationId: "deleteOrganization",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/organizations/{id}/members": {
    get: {
      tags: [TAG],
      summary: "List an organisation's users",
      description: "Permission organizations:read.",
      operationId: "listOrganizationMembers",
      parameters: [idParam],
      responses: { "200": { description: "Users", content: json({ type: "array", items: ref("User") }) }, ...errors("401", "403", "404") },
    },
    post: {
      tags: [TAG],
      summary: "Move users into an organisation",
      description:
        "Permission organizations:write; needs the multi_tenancy feature. The same as POST /api/v1/organizations/move with " +
        "userIds only. To create a user inside an organisation, POST /api/v1/users with organizationId.",
      operationId: "addOrganizationMembers",
      parameters: [idParam],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          properties: { userIds: { type: "array", items: { type: "integer" }, minItems: 1 } },
          required: ["userIds"],
          additionalProperties: false,
        }),
      },
      responses: { "200": { description: "Moved", content: json(ref("OrganizationMoveResult")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/organizations/move": {
    post: {
      tags: [TAG],
      summary: "Move rows between organisations",
      description:
        "Permission organizations:write. Moves proxy hosts, certificates, access lists, groups and users to an organisation, or " +
        "to the provider level with organizationId null, in one transaction. Moving into an organisation needs the " +
        "multi_tenancy feature; moving out never does. Refused (409) when a host and its certificate or access list would end " +
        "up in different organisations (move them together), when a domain would be served in two organisations, or when the " +
        "destination already has a group of that name; refused (403) over the destination's limits; refused (400) for your own " +
        "account, the primary administrator and break-glass accounts, and when the last active administrator would go. Moved " +
        "users get a role that fits: admin becomes org_admin, a custom role holding more than the organisation permissions " +
        "becomes viewer, and moving out of an organisation always gives viewer. Group members, forward-auth grants and " +
        "forward-auth sessions that would cross organisations are removed.",
      operationId: "moveToOrganization",
      requestBody: { required: true, content: json(ref("OrganizationMove")) },
      responses: { "200": { description: "Moved", content: json(ref("OrganizationMoveResult")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/usage-reports": {
    get: {
      tags: [TAG],
      summary: "Usage report",
      description:
        "Permission usage_reports:read. Per organisation and period: proxy hosts and users (now), requests, bytes served and " +
        "WAF blocks (from analytics, over the organisation's host names). Provider-level callers get every organisation and " +
        "the provider level's own row, or one with ?organizationId=; organisation users get their own organisation (404 for " +
        "another). The period defaults to the current calendar month (UTC).",
      operationId: "getUsageReport",
      parameters: [
        { name: "organizationId", in: "query", required: false, schema: { type: "string" }, description: "An organisation id, or \"provider\"" },
        { name: "month", in: "query", required: false, schema: { type: "string", example: "2026-09" }, description: "YYYY-MM" },
        { name: "from", in: "query", required: false, schema: { type: "string" }, description: "ISO 8601 date or date-time" },
        { name: "to", in: "query", required: false, schema: { type: "string" }, description: "ISO 8601 date (the whole day) or date-time" },
        { name: "format", in: "query", required: false, schema: { type: "string", enum: ["json", "csv"], default: "json" } },
      ],
      responses: {
        "200": {
          description: "Report",
          content: { ...json(ref("UsageReport")), "text/csv": { schema: { type: "string" } } },
        },
        ...errors("400", "401", "403", "404"),
      },
    },
  },
};

export const MULTI_TENANCY_OPENAPI_SCHEMAS = {
  Organization: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      slug: { type: "string", example: "acme" },
      enabled: { type: "boolean" },
      maxProxyHosts: { type: ["integer", "null"], description: "null: no limit" },
      maxUsers: { type: ["integer", "null"], description: "null: no limit" },
      allowedUpstreams: {
        type: "array",
        items: { type: "string" },
        description:
          "Upstreams the organisation's own users may proxy to: host names, *.wildcards (any depth), IP addresses or CIDRs, " +
          "or \"*\" for any. Empty allows none.",
      },
      notes: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      counts: {
        type: "object",
        properties: {
          proxyHosts: { type: "integer" },
          certificates: { type: "integer" },
          accessLists: { type: "integer" },
          groups: { type: "integer" },
          users: { type: "integer" },
        },
      },
    },
    required: ["id", "name", "slug", "enabled", "allowedUpstreams", "createdAt", "updatedAt"],
  },
  OrganizationInput: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      slug: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
      enabled: { type: "boolean" },
      maxProxyHosts: { type: ["integer", "null"], minimum: 0 },
      maxUsers: { type: ["integer", "null"], minimum: 0 },
      allowedUpstreams: { type: "array", items: { type: "string" }, maxItems: 64 },
      notes: { type: ["string", "null"], maxLength: 1000 },
    },
    additionalProperties: false,
  },
  OrganizationMove: {
    type: "object",
    properties: {
      organizationId: { type: ["integer", "null"], description: "The destination; null for the provider level" },
      proxyHostIds: { type: "array", items: { type: "integer" } },
      certificateIds: { type: "array", items: { type: "integer" } },
      accessListIds: { type: "array", items: { type: "integer" } },
      groupIds: { type: "array", items: { type: "integer" } },
      userIds: { type: "array", items: { type: "integer" } },
    },
    required: ["organizationId"],
    additionalProperties: false,
  },
  OrganizationMoveResult: {
    type: "object",
    properties: {
      organizationId: { type: ["integer", "null"] },
      proxyHostIds: { type: "integer", description: "Rows moved (rows already there are not counted)" },
      certificateIds: { type: "integer" },
      accessListIds: { type: "integer" },
      groupIds: { type: "integer" },
      userIds: { type: "integer" },
      removedGrants: { type: "integer", description: "Forward-auth grants removed because they would cross organisations" },
      removedMemberships: { type: "integer", description: "Group memberships removed because they would cross organisations" },
    },
  },
  UsageReport: {
    type: "object",
    properties: {
      period: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } },
      analyticsAvailable: { type: "boolean", description: "False when analytics (ClickHouse) are off: traffic counts are 0" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            organizationId: { type: ["integer", "null"], description: "null: the provider level" },
            organizationName: { type: "string" },
            organizationSlug: { type: ["string", "null"] },
            enabled: { type: "boolean" },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            proxyHosts: { type: "integer" },
            enabledProxyHosts: { type: "integer" },
            users: { type: "integer" },
            requests: { type: "integer" },
            bytes: { type: "integer" },
            wafBlocks: { type: "integer" },
          },
        },
      },
    },
  },
};
