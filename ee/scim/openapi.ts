// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of SCIM provisioning: the administration
 * endpoints (/api/v1/scim/*) and the SCIM 2.0 protocol endpoints
 * (/scim/v2/*), spread into app/api/v1/openapi.json/route.ts.
 */

const TAG = "SCIM";
const PROTOCOL_TAG = "SCIM 2.0 protocol";

export const SCIM_OPENAPI_TAGS = [
  {
    name: TAG,
    description:
      "SCIM provisioning settings, SCIM tokens, group-to-role mappings and the users and groups SCIM manages. " +
      "scim:write is administrator-level.",
  },
  {
    name: PROTOCOL_TAG,
    description:
      "The SCIM 2.0 service (RFC 7643/7644) for identity providers such as Microsoft Entra ID and Okta. Authenticate with a " +
      "SCIM token (Authorization: Bearer scim_…); API tokens and dashboard sessions are refused, and SCIM tokens are refused " +
      "by every /api/v1 endpoint. Responses use application/scim+json and SCIM error documents.",
  },
];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const scimJson = (schema: unknown) => ({ "application/scim+json": { schema } });
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
const scimErrors = (...codes: string[]) =>
  Object.fromEntries(codes.map((code) => [code, { description: `SCIM error ${code}`, content: scimJson(ref("ScimError")) }]));
const scimSecurity = [{ bearerAuth: [] }];
const scimIdParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "The resource id (the dashboard user or group id)" };
const listParams = [
  { name: "filter", in: "query", schema: { type: "string" }, description: 'One comparison with eq, e.g. userName eq "alice@example.com"' },
  { name: "startIndex", in: "query", schema: { type: "integer", minimum: 1 } },
  { name: "count", in: "query", schema: { type: "integer", minimum: 0, maximum: 200 } },
  { name: "attributes", in: "query", schema: { type: "string" } },
  { name: "excludedAttributes", in: "query", schema: { type: "string" } },
];

export const SCIM_OPENAPI_PATHS = {
  "/api/v1/scim/settings": {
    get: {
      tags: [TAG],
      summary: "Get SCIM settings",
      description: "Permission scim:read. Includes the SCIM base URL, the OAuth/OIDC providers to choose from and counts.",
      operationId: "getScimSettings",
      responses: { "200": { description: "Settings", content: json(ref("ScimSettings")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Change SCIM settings",
      description:
        "Permission scim:write. Fields left out keep their values. Turning manageRoles on (or changing defaultRole while it is on) " +
        "re-applies the mappings to every SCIM user.",
      operationId: "updateScimSettings",
      requestBody: { required: true, content: json(ref("ScimSettingsInput")) },
      responses: { "200": { description: "Settings", content: json(ref("ScimSettings")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/scim/tokens": {
    get: {
      tags: [TAG],
      summary: "List SCIM tokens",
      description: "Permission scim:read. Tokens show only their prefix.",
      operationId: "listScimTokens",
      responses: { "200": { description: "Tokens", content: json({ type: "array", items: ref("ScimToken") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create a SCIM token",
      description: "Permission scim:write (administrator-level). The token is in this response only. At most 20 tokens.",
      operationId: "createScimToken",
      requestBody: { required: true, content: json(ref("ScimTokenInput")) },
      responses: { "201": { description: "Created", content: json(ref("ScimTokenCreated")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/scim/tokens/{id}": {
    delete: {
      tags: [TAG],
      summary: "Revoke a SCIM token",
      description: "Permission scim:write.",
      operationId: "deleteScimToken",
      parameters: [idParam],
      responses: { "204": { description: "Revoked" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/scim/role-mappings": {
    get: {
      tags: [TAG],
      summary: "List group-to-role mappings",
      description: "Permission scim:read. In priority order (lowest first).",
      operationId: "listScimRoleMappings",
      responses: { "200": { description: "Mappings", content: json({ type: "array", items: ref("ScimRoleMapping") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Map a SCIM group to a role",
      description:
        "Permission scim:write. Only roles the caller could assign themselves; only groups SCIM manages; one mapping per group " +
        "(409). With manageRoles on, applied to every SCIM user at once.",
      operationId: "createScimRoleMapping",
      requestBody: { required: true, content: json(ref("ScimRoleMappingInput")) },
      responses: { "201": { description: "Created", content: json(ref("ScimRoleMapping")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/scim/role-mappings/{id}": {
    put: {
      tags: [TAG],
      summary: "Change a mapping",
      description: "Permission scim:write. Fields left out keep their values.",
      operationId: "updateScimRoleMapping",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("ScimRoleMappingInput")) },
      responses: { "200": { description: "Mapping", content: json(ref("ScimRoleMapping")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a mapping",
      description: "Permission scim:write. With manageRoles on, its users get their next mapping or the default role.",
      operationId: "deleteScimRoleMapping",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/scim/users": {
    get: {
      tags: [TAG],
      summary: "List the users SCIM manages",
      description: "Permission scim:read.",
      operationId: "listScimManagedUsers",
      responses: { "200": { description: "Users", content: json({ type: "array", items: ref("ScimManagedUser") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Hand an existing account to SCIM",
      description:
        "Permission scim:write. The only way a local account becomes visible to SCIM: the identity provider " +
        "finds it by userName (exactly as it will send it), can change and disable it, and its first sign-in through the SCIM " +
        "sign-in provider is linked to it. The primary admin and break-glass accounts are refused (400).",
      operationId: "adoptScimUser",
      requestBody: { required: true, content: json(ref("ScimAdoptUserInput")) },
      responses: { "201": { description: "Managed", content: json(ref("ScimManagedUser")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/scim/users/{id}": {
    delete: {
      tags: [TAG],
      summary: "Stop SCIM managing a user",
      description: "Permission scim:write. The account is not changed.",
      operationId: "releaseScimUser",
      parameters: [idParam],
      responses: { "204": { description: "Released" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/scim/groups": {
    get: {
      tags: [TAG],
      summary: "List the groups SCIM manages",
      description: "Permission scim:read.",
      operationId: "listScimManagedGroups",
      responses: { "200": { description: "Groups", content: json({ type: "array", items: ref("ScimManagedGroup") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Hand an existing forward-auth group to SCIM",
      description: "Permission scim:write. SCIM then adds and removes SCIM users in it; other members stay.",
      operationId: "adoptScimGroup",
      requestBody: { required: true, content: json(ref("ScimAdoptGroupInput")) },
      responses: { "201": { description: "Managed", content: json(ref("ScimManagedGroup")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/scim/groups/{id}": {
    delete: {
      tags: [TAG],
      summary: "Stop SCIM managing a group",
      description: "Permission scim:write. The group and its members stay; its role mapping is deleted.",
      operationId: "releaseScimGroup",
      parameters: [idParam],
      responses: { "204": { description: "Released" }, ...errors("401", "403", "404") },
    },
  },

  // ── SCIM 2.0 protocol ─────────────────────────────────────────────────
  "/scim/v2/ServiceProviderConfig": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "Service provider configuration",
      operationId: "scimServiceProviderConfig",
      security: scimSecurity,
      responses: { "200": { description: "Configuration", content: scimJson({ type: "object" }) }, ...scimErrors("401", "403") },
    },
  },
  "/scim/v2/ResourceTypes": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "Resource types (User, Group)",
      operationId: "scimResourceTypes",
      security: scimSecurity,
      responses: { "200": { description: "List", content: scimJson(ref("ScimListResponse")) }, ...scimErrors("401", "403") },
    },
  },
  "/scim/v2/ResourceTypes/{id}": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "One resource type",
      operationId: "scimResourceType",
      security: scimSecurity,
      parameters: [scimIdParam],
      responses: { "200": { description: "Resource type", content: scimJson({ type: "object" }) }, ...scimErrors("401", "403", "404") },
    },
  },
  "/scim/v2/Schemas": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "Schemas (core User and Group attributes this server keeps)",
      operationId: "scimSchemas",
      security: scimSecurity,
      responses: { "200": { description: "List", content: scimJson(ref("ScimListResponse")) }, ...scimErrors("401", "403") },
    },
  },
  "/scim/v2/Schemas/{id}": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "One schema",
      operationId: "scimSchema",
      security: scimSecurity,
      parameters: [scimIdParam],
      responses: { "200": { description: "Schema", content: scimJson({ type: "object" }) }, ...scimErrors("401", "403", "404") },
    },
  },
  "/scim/v2/Users": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "List or find SCIM users",
      description: "Filters: userName eq, externalId eq, id eq. Only users SCIM manages are visible.",
      operationId: "scimListUsers",
      security: scimSecurity,
      parameters: listParams,
      responses: { "200": { description: "List", content: scimJson(ref("ScimListResponse")) }, ...scimErrors("400", "401", "403") },
    },
    post: {
      tags: [PROTOCOL_TAG],
      summary: "Create a user",
      description:
        "Needs userName and an e-mail address. The account gets no password, the default role from the SCIM settings and signs " +
        "in through the SCIM sign-in provider. 409 (uniqueness) when the userName is taken or the e-mail address belongs to an " +
        "account SCIM does not manage. password, roles and entitlements are ignored.",
      operationId: "scimCreateUser",
      security: scimSecurity,
      requestBody: { required: true, content: scimJson(ref("ScimUser")) },
      responses: { "201": { description: "Created", content: scimJson(ref("ScimUser")) }, ...scimErrors("400", "401", "403", "409") },
    },
  },
  "/scim/v2/Users/{id}": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "Get a user",
      operationId: "scimGetUser",
      security: scimSecurity,
      parameters: [scimIdParam],
      responses: { "200": { description: "User", content: scimJson(ref("ScimUser")) }, ...scimErrors("401", "403", "404") },
    },
    put: {
      tags: [PROTOCOL_TAG],
      summary: "Replace a user",
      description: "active left out keeps its value. active=false disables the account and revokes its sessions and API tokens.",
      operationId: "scimReplaceUser",
      security: scimSecurity,
      parameters: [scimIdParam],
      requestBody: { required: true, content: scimJson(ref("ScimUser")) },
      responses: { "200": { description: "User", content: scimJson(ref("ScimUser")) }, ...scimErrors("400", "401", "403", "404", "409") },
    },
    patch: {
      tags: [PROTOCOL_TAG],
      summary: "Patch a user",
      description:
        "PatchOp with add, replace and remove (any case), with a path or a path-less object value; active as a boolean or the " +
        'strings "True"/"False"; paths such as emails[type eq "work"].value and name.givenName. Protected accounts answer 403.',
      operationId: "scimPatchUser",
      security: scimSecurity,
      parameters: [scimIdParam],
      requestBody: { required: true, content: scimJson(ref("ScimPatchOp")) },
      responses: { "200": { description: "User", content: scimJson(ref("ScimUser")) }, ...scimErrors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [PROTOCOL_TAG],
      summary: "Delete a user",
      description: "Disables the account and revokes its sessions and API tokens (delete mode disable, the default) or deletes it (delete mode delete).",
      operationId: "scimDeleteUser",
      security: scimSecurity,
      parameters: [scimIdParam],
      responses: { "204": { description: "Deleted" }, ...scimErrors("400", "401", "403", "404") },
    },
  },
  "/scim/v2/Groups": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "List or find SCIM groups",
      description: "Filters: displayName eq, externalId eq, id eq. excludedAttributes=members leaves members out.",
      operationId: "scimListGroups",
      security: scimSecurity,
      parameters: listParams,
      responses: { "200": { description: "List", content: scimJson(ref("ScimListResponse")) }, ...scimErrors("400", "401", "403") },
    },
    post: {
      tags: [PROTOCOL_TAG],
      summary: "Create a group",
      description: "Creates a forward-auth group. 409 when a group with the name exists (and SCIM does not manage it).",
      operationId: "scimCreateGroup",
      security: scimSecurity,
      requestBody: { required: true, content: scimJson(ref("ScimGroup")) },
      responses: { "201": { description: "Created", content: scimJson(ref("ScimGroup")) }, ...scimErrors("400", "401", "403", "409") },
    },
  },
  "/scim/v2/Groups/{id}": {
    get: {
      tags: [PROTOCOL_TAG],
      summary: "Get a group",
      operationId: "scimGetGroup",
      security: scimSecurity,
      parameters: [scimIdParam],
      responses: { "200": { description: "Group", content: scimJson(ref("ScimGroup")) }, ...scimErrors("401", "403", "404") },
    },
    put: {
      tags: [PROTOCOL_TAG],
      summary: "Replace a group",
      operationId: "scimReplaceGroup",
      security: scimSecurity,
      parameters: [scimIdParam],
      requestBody: { required: true, content: scimJson(ref("ScimGroup")) },
      responses: { "200": { description: "Group", content: scimJson(ref("ScimGroup")) }, ...scimErrors("400", "401", "403", "404", "409") },
    },
    patch: {
      tags: [PROTOCOL_TAG],
      summary: "Patch a group",
      description: 'Members are added with add on members, removed with remove on members (with a value list) or members[value eq "<id>"].',
      operationId: "scimPatchGroup",
      security: scimSecurity,
      parameters: [scimIdParam],
      requestBody: { required: true, content: scimJson(ref("ScimPatchOp")) },
      responses: { "200": { description: "Group", content: scimJson(ref("ScimGroup")) }, ...scimErrors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [PROTOCOL_TAG],
      summary: "Delete a group",
      description: "Deletes a group SCIM created; for a group handed to SCIM, removes its SCIM members and stops managing it.",
      operationId: "scimDeleteGroup",
      security: scimSecurity,
      parameters: [scimIdParam],
      responses: { "204": { description: "Deleted" }, ...scimErrors("401", "403", "404") },
    },
  },
};

const timestamp = { type: "string", format: "date-time" };
const nullableTimestamp = { type: ["string", "null"], format: "date-time" };

export const SCIM_OPENAPI_SCHEMAS = {
  ScimSettings: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      providerId: { type: ["string", "null"], description: "OAuth/OIDC provider SCIM users sign in with" },
      deleteMode: { type: "string", enum: ["disable", "delete"] },
      defaultRole: { type: "string", enum: ["user", "viewer"] },
      manageRoles: { type: "boolean" },
      requireVerifiedEmail: { type: "boolean" },
      externalIdClaim: { type: ["string", "null"] },
      endpointUrl: { type: "string", description: "The SCIM base URL to give the identity provider" },
      providers: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, autoLink: { type: "boolean" } },
        },
      },
      counts: {
        type: "object",
        properties: { users: { type: "integer" }, groups: { type: "integer" }, tokens: { type: "integer" }, mappings: { type: "integer" } },
      },
    },
    required: ["enabled", "providerId", "deleteMode", "defaultRole", "manageRoles", "requireVerifiedEmail", "externalIdClaim", "endpointUrl"],
  },
  ScimSettingsInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      providerId: { type: ["string", "null"] },
      deleteMode: { type: "string", enum: ["disable", "delete"] },
      defaultRole: { type: "string", enum: ["user", "viewer"] },
      manageRoles: { type: "boolean" },
      requireVerifiedEmail: { type: "boolean" },
      externalIdClaim: { type: ["string", "null"], description: "e.g. sub (Okta) or oid (Entra ID)" },
    },
  },
  ScimToken: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      prefix: { type: "string", description: "First characters of the token" },
      createdBy: { type: ["integer", "null"] },
      createdAt: timestamp,
      lastUsedAt: nullableTimestamp,
      expiresAt: nullableTimestamp,
      expired: { type: "boolean" },
    },
    required: ["id", "name", "prefix", "createdBy", "createdAt", "lastUsedAt", "expiresAt", "expired"],
  },
  ScimTokenInput: {
    type: "object",
    additionalProperties: false,
    properties: { name: { type: "string", maxLength: 100 }, expiresAt: nullableTimestamp },
    required: ["name"],
  },
  ScimTokenCreated: {
    allOf: [
      ref("ScimToken"),
      { type: "object", properties: { token: { type: "string", description: "scim_…; shown only in this response" } }, required: ["token"] },
    ],
  },
  ScimRoleMapping: {
    type: "object",
    properties: {
      id: { type: "integer" },
      groupId: { type: "integer" },
      groupName: { type: "string" },
      role: { type: "string", enum: ["admin", "user", "viewer"], description: "viewer for a custom role" },
      customRoleId: { type: ["integer", "null"] },
      customRoleName: { type: ["string", "null"] },
      priority: { type: "integer", description: "Lower wins" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: ["id", "groupId", "groupName", "role", "customRoleId", "customRoleName", "priority", "createdAt", "updatedAt"],
  },
  ScimRoleMappingInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      groupId: { type: "integer", description: "A group SCIM manages" },
      role: { type: "string", enum: ["admin", "user", "viewer"] },
      customRoleId: { type: ["integer", "null"] },
      priority: { type: "integer", minimum: 0, maximum: 10000, default: 100 },
    },
  },
  ScimManagedUser: {
    type: "object",
    properties: {
      userId: { type: "integer" },
      email: { type: "string" },
      name: { type: ["string", "null"] },
      status: { type: "string" },
      role: { type: "string" },
      customRoleId: { type: ["integer", "null"] },
      userName: { type: "string" },
      externalId: { type: ["string", "null"] },
      origin: { type: "string", enum: ["scim", "adopted"] },
      deletedAt: { ...nullableTimestamp, description: "The identity provider deleted the user (delete mode disable)" },
      linkedAt: { ...nullableTimestamp, description: "When the first SSO sign-in was linked" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: ["userId", "email", "name", "status", "role", "customRoleId", "userName", "externalId", "origin", "deletedAt", "linkedAt", "createdAt", "updatedAt"],
  },
  ScimAdoptUserInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      userId: { type: "integer" },
      userName: { type: "string", description: "Exactly the userName the identity provider sends" },
      externalId: { type: ["string", "null"] },
    },
    required: ["userId", "userName"],
  },
  ScimManagedGroup: {
    type: "object",
    properties: {
      groupId: { type: "integer" },
      name: { type: "string" },
      externalId: { type: ["string", "null"] },
      origin: { type: "string", enum: ["scim", "adopted"] },
      scimMemberCount: { type: "integer" },
      memberCount: { type: "integer" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: ["groupId", "name", "externalId", "origin", "scimMemberCount", "memberCount", "createdAt", "updatedAt"],
  },
  ScimAdoptGroupInput: {
    type: "object",
    additionalProperties: false,
    properties: { groupId: { type: "integer" }, externalId: { type: ["string", "null"] } },
    required: ["groupId"],
  },
  ScimUser: {
    type: "object",
    properties: {
      schemas: { type: "array", items: { type: "string" } },
      id: { type: "string", readOnly: true },
      externalId: { type: "string" },
      userName: { type: "string" },
      name: {
        type: "object",
        properties: { formatted: { type: "string" }, givenName: { type: "string" }, familyName: { type: "string" } },
      },
      displayName: { type: "string" },
      emails: {
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "string" }, type: { type: "string" }, primary: { type: "boolean" } },
          required: ["value"],
        },
      },
      active: { type: "boolean" },
      groups: {
        type: "array",
        readOnly: true,
        items: { type: "object", properties: { value: { type: "string" }, display: { type: "string" }, $ref: { type: "string" } } },
      },
      meta: { type: "object", readOnly: true },
    },
    required: ["userName"],
  },
  ScimGroup: {
    type: "object",
    properties: {
      schemas: { type: "array", items: { type: "string" } },
      id: { type: "string", readOnly: true },
      externalId: { type: "string" },
      displayName: { type: "string" },
      members: {
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "string", description: "A SCIM user id" }, display: { type: "string" }, $ref: { type: "string" } },
          required: ["value"],
        },
      },
      meta: { type: "object", readOnly: true },
    },
    required: ["displayName"],
  },
  ScimPatchOp: {
    type: "object",
    properties: {
      schemas: { type: "array", items: { type: "string", enum: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] } },
      Operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", description: "add, replace or remove (any case)" },
            path: { type: "string" },
            value: {},
          },
          required: ["op"],
        },
      },
    },
    required: ["Operations"],
  },
  ScimListResponse: {
    type: "object",
    properties: {
      schemas: { type: "array", items: { type: "string" } },
      totalResults: { type: "integer" },
      startIndex: { type: "integer" },
      itemsPerPage: { type: "integer" },
      Resources: { type: "array", items: { type: "object" } },
    },
    required: ["schemas", "totalResults", "Resources"],
  },
  ScimError: {
    type: "object",
    properties: {
      schemas: { type: "array", items: { type: "string", enum: ["urn:ietf:params:scim:api:messages:2.0:Error"] } },
      status: { type: "string" },
      scimType: { type: "string" },
      detail: { type: "string" },
    },
    required: ["schemas", "status", "detail"],
  },
};
