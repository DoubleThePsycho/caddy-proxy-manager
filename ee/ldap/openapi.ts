// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the LDAP / Active Directory endpoints, spread
 * into app/api/v1/openapi.json/route.ts. Sign-in itself is Better Auth's
 * POST /api/auth/sign-in/ldap, documented in ee/docs/ldap.md.
 */

const TAG = "LDAP Directories";

export const LDAP_OPENAPI_TAG = {
  name: TAG,
  description:
    "LDAP and Active Directory directories for dashboard sign-in, with group-to-role mapping (Enterprise edition). Creating, " +
    "enabling and changing a directory need the ldap feature; reading, testing, disabling and deleting never do, and sign-in " +
    "through an enabled directory never checks the license. The service account password is never returned. Directories are " +
    "per instance and not synced to slaves. People sign in with POST /api/auth/sign-in/ldap {directoryId, username, password}.",
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

export const LDAP_OPENAPI_PATHS = {
  "/api/v1/ldap-directories": {
    get: {
      tags: [TAG],
      summary: "List directories",
      description: "Permission ldap:read. Available without a license. The service account password is never returned (see hasBindPassword).",
      operationId: "listLdapDirectories",
      responses: { "200": { description: "Directories", content: json({ type: "array", items: ref("LdapDirectory") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create a directory",
      description:
        "Permission ldap:write (administrator-level). Needs the ldap feature (403 otherwise). An ldap:// URL needs startTls, or " +
        "allowUnencrypted to send passwords in clear text; server certificates are always verified. 409 when the name is taken.",
      operationId: "createLdapDirectory",
      requestBody: { required: true, content: json(ref("LdapDirectoryInput")) },
      responses: { "201": { description: "Created", content: json(ref("LdapDirectory")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/ldap-directories/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a directory",
      description: "Permission ldap:read. Available without a license.",
      operationId: "getLdapDirectory",
      parameters: [idParam],
      responses: { "200": { description: "Directory", content: json(ref("LdapDirectory")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Update a directory",
      description:
        "Permission ldap:write. Fields left out keep their values; an omitted or empty bindPassword keeps the stored one. Changing the " +
        "URL requires entering bindPassword again. Needs the ldap feature, except a body that only disables the directory " +
        "({\"enabled\": false}), which works without a license.",
      operationId: "updateLdapDirectory",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("LdapDirectoryUpdate")) },
      responses: { "200": { description: "Updated", content: json(ref("LdapDirectory")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a directory",
      description:
        "Permission ldap:write. Never needs a license. The accounts linked through the directory are unlinked; the users are kept.",
      operationId: "deleteLdapDirectory",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/ldap-directories/{id}/test": {
    post: {
      tags: [TAG],
      summary: "Test the connection",
      description:
        "Permission ldap:write. Connects with the configured TLS, binds as the service account and reads the user search base. " +
        "Works on a disabled directory and without a license. Recorded in the audit log. For an enabled directory the " +
        "result also becomes its health (the periodic check's status).",
      operationId: "testLdapDirectory",
      parameters: [idParam],
      responses: { "200": { description: "Result", content: json(ref("LdapConnectionTestResult")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/ldap-directories/{id}/test-sign-in": {
    post: {
      tags: [TAG],
      summary: "Test a sign-in",
      description:
        "Permission ldap:write. Checks a username and password against the directory and reports the entry, its groups, the role " +
        "the mapping gives and what a sign-in would do with the local account. Signs nobody in and changes no account. Counts " +
        "towards the sign-in rate limits for the username (429 when reached) and is recorded in the audit log.",
      operationId: "testLdapDirectorySignIn",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("LdapSignInTestInput")) },
      responses: {
        "200": { description: "Result", content: json(ref("LdapSignInTestResult")) },
        ...errors("400", "401", "403", "404"),
        "429": { description: "Too many attempts for this username", content: json(ref("Error")) },
      },
    },
  },
};

const dn = { type: "string", maxLength: 1024, description: "A distinguished name" };
const attribute = (example: string) => ({ type: "string", maxLength: 64, description: `Attribute name, for example ${example}` });
const mapping = {
  type: "object",
  properties: {
    group: { ...dn, description: "Group DN, compared case-insensitively" },
    role: { type: "string", enum: ["admin", "user", "viewer"] },
  },
  required: ["group", "role"],
  additionalProperties: false,
};

const settingsProperties = {
  name: { type: "string", maxLength: 100, description: "Shown on the login page; unique" },
  enabled: { type: "boolean" },
  url: { type: "string", description: "ldaps://host[:port] or ldap://host[:port]", example: "ldaps://ldap.example.com:636" },
  startTls: { type: "boolean", description: "ldap:// only: upgrade with StartTLS before anything is sent (default true for ldap://)" },
  allowUnencrypted: { type: "boolean", description: "ldap:// without StartTLS only: send passwords in clear text. Off by default." },
  caCertificate: { type: ["string", "null"], description: "PEM certificates the server certificate must chain to; null: the system trust store" },
  connectTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000, default: 5000 },
  operationTimeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 10000 },
  bindDn: { ...dn, description: "Service account used to search users and groups" },
  userSearchBase: dn,
  userSearchFilter: {
    type: "string",
    maxLength: 1024,
    description: "RFC 4515 filter with {username} where an assertion value goes; the typed username is escaped. Exactly one entry must match.",
    example: "(&(objectClass=inetOrgPerson)(uid={username}))",
  },
  usernameAttribute: attribute("uid or sAMAccountName"),
  emailAttribute: attribute("mail"),
  displayNameAttribute: attribute("cn or displayName"),
  uniqueIdAttribute: attribute("entryUUID or objectGUID"),
  groupMode: { type: "string", enum: ["none", "member_of", "search"] },
  groupMembershipAttribute: attribute("memberOf"),
  groupSearchBase: { ...dn, type: ["string", "null"] },
  groupSearchFilter: {
    type: ["string", "null"],
    maxLength: 1024,
    description: "groupMode search: RFC 4515 filter with {dn} (the user's DN) and/or {username}, escaped",
    example: "(&(objectClass=groupOfNames)(member={dn}))",
  },
  nestedGroups: { type: "boolean", description: "groupMode member_of, Active Directory: every group, nested ones included (needs groupSearchBase)" },
  groupRoleMappings: { type: "array", maxItems: 100, items: mapping, description: "The only way a directory grants a role" },
  defaultRole: { type: "string", enum: ["user", "viewer"], description: "Role of a user in none of the mapped groups" },
  requiredGroup: { ...dn, type: ["string", "null"], description: "Only members of this group can sign in" },
  provisionUsers: { type: "boolean", description: "Create an account at first sign-in (default false)" },
  linkExistingAccounts: { type: "boolean", description: "Link an existing account with exactly the entry's e-mail address (default false)" },
  allowWhenSsoEnforced: { type: "boolean", description: "Directory sign-in stays open while enforced SSO is on (default false)" },
};

export const LDAP_OPENAPI_SCHEMAS = {
  LdapDirectory: {
    type: "object",
    properties: {
      id: { type: "integer" },
      ...settingsProperties,
      hasBindPassword: { type: "boolean" },
      linkedAccounts: { type: "integer", description: "Accounts linked through this directory" },
      warnings: { type: "array", items: { type: "string" } },
      health: {
        oneOf: [ref("LdapDirectoryHealth"), { type: "null" }],
        description:
          "The periodic connection check: every 5 minutes each enabled directory is connected to, bound with the service " +
          "account and its user search base read. null until it was first checked (also after its connection settings change).",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name", "enabled", "url", "hasBindPassword", "linkedAccounts", "warnings", "health"],
  },
  LdapDirectoryHealth: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok", "failing"] },
      checkedAt: { type: "string", format: "date-time" },
      lastSuccessAt: { type: ["string", "null"], format: "date-time" },
      lastFailureAt: { type: ["string", "null"], format: "date-time" },
      failingSince: { type: ["string", "null"], format: "date-time", description: "When the current run of failures started" },
      lastError: {
        type: ["string", "null"],
        description: "The last failure, such as \"Service account bind: invalid credentials (LDAP result 49)\"; never a password",
      },
      consecutiveFailures: { type: "integer", description: "Failed checks in a row; 0 while the directory works" },
    },
    required: ["status", "checkedAt", "lastSuccessAt", "lastFailureAt", "failingSince", "lastError", "consecutiveFailures"],
  },
  LdapDirectoryInput: {
    type: "object",
    properties: {
      ...settingsProperties,
      bindPassword: { type: "string", writeOnly: true, maxLength: 1024, description: "Stored encrypted; never returned" },
    },
    required: ["name", "url", "bindDn", "bindPassword", "userSearchBase", "userSearchFilter"],
    additionalProperties: false,
  },
  LdapDirectoryUpdate: {
    type: "object",
    properties: {
      ...settingsProperties,
      bindPassword: { type: "string", writeOnly: true, maxLength: 1024, description: "Omit or send an empty string to keep the stored one" },
    },
    additionalProperties: false,
  },
  LdapConnectionTestResult: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string", enum: ["connect", "bind", "search_base"] },
            ok: { type: "boolean" },
            detail: { type: "string" },
          },
          required: ["step", "ok", "detail"],
        },
      },
    },
    required: ["ok", "steps"],
  },
  LdapSignInTestInput: {
    type: "object",
    properties: {
      username: { type: "string", maxLength: 256 },
      password: { type: "string", writeOnly: true, maxLength: 1024 },
    },
    required: ["username", "password"],
    additionalProperties: false,
  },
  LdapSignInTestResult: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      outcome: {
        type: "string",
        enum: [
          "success", "invalid_input", "directory_unavailable", "unknown_user", "multiple_entries", "wrong_password",
          "incomplete_entry", "groups_unavailable",
        ],
      },
      detail: { type: "string" },
      user: {
        type: ["object", "null"],
        properties: {
          dn: { type: "string" },
          uniqueId: { type: "string" },
          username: { type: "string" },
          email: { type: ["string", "null"] },
          displayName: { type: ["string", "null"] },
          groups: { type: ["array", "null"], items: { type: "string" } },
        },
      },
      roles: {
        type: ["object", "null"],
        properties: {
          inRequiredGroup: { type: "boolean" },
          managesRoles: { type: "boolean" },
          role: { type: "string", enum: ["admin", "user", "viewer"] },
          matchedGroups: { type: "array", items: { type: "string" } },
        },
      },
      account: {
        type: ["object", "null"],
        properties: {
          action: { type: "string", enum: ["existing", "link", "provision", "refuse"] },
          userId: { type: ["integer", "null"] },
          reason: { type: ["string", "null"] },
        },
      },
    },
    required: ["ok", "outcome", "detail", "user", "roles", "account"],
  },
};
