/**
 * OpenAPI paths and schemas of the identity overviews
 * (GET /api/v1/users/overview, /api/v1/groups/overview and
 * /api/v1/sign-in/overview), spread into app/api/v1/openapi.json/route.ts.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const string = { type: "string" };
const dateTime = { type: "string", format: "date-time" };
const errors = {
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
};

export const IDENTITY_OVERVIEW_OPENAPI_PATHS = {
  "/api/v1/users/overview": {
    get: {
      tags: ["Users"],
      summary: "Users with their sources, second factor and last use",
      description:
        "Requires users:read. Every account the caller may list, as on the Users page: where it comes from (password, " +
        "OpenID Connect or OAuth, SAML, LDAP, SCIM), its second factor, whether a directory or SCIM sets its role, " +
        "whether it is a break-glass account, its last sign-in and when one of its API tokens was last used. " +
        "mfaPolicy is null without mfa_policy:read. No password hash or secret.",
      operationId: "getUsersOverview",
      responses: { "200": { description: "The overview", content: { "application/json": { schema: ref("UsersOverview") } } }, ...errors },
    },
  },
  "/api/v1/groups/overview": {
    get: {
      tags: ["Groups"],
      summary: "Groups with their members, SCIM management and hosts",
      description:
        "Requires groups:read. Every forward-auth group the caller may list, with its members and whether SCIM manages " +
        "it. roleMappings (the SCIM group-to-role mappings) is null without scim:read; hosts (the proxy hosts whose " +
        "forward auth lets the group in) is null without proxy_hosts:read and lists only hosts in the caller's tag scope.",
      operationId: "getGroupsOverview",
      responses: { "200": { description: "The overview", content: { "application/json": { schema: ref("GroupsOverview") } } }, ...errors },
    },
  },
  "/api/v1/sign-in/overview": {
    get: {
      tags: ["SSO"],
      summary: "Sign-in sources, enforced SSO and directory health",
      description:
        "Requires sso:read. Enforced SSO with its break-glass accounts and the correct passwords it refused in the last " +
        "7 days, what the login page offers now, and every OpenID Connect or OAuth provider, SAML provider, LDAP " +
        "directory (ldap:read, otherwise null) and the SCIM endpoint (scim:read, otherwise null), each with the accounts " +
        "that come from it, its group-to-role mappings, its last activity and, for directories, the periodic connection " +
        "check with its last error. Reads stored state only. No client secret, bind password, key or token value.",
      operationId: "getSignInOverview",
      responses: { "200": { description: "The overview", content: { "application/json": { schema: ref("SignInOverview") } } }, ...errors },
    },
  },
};

const sourceUsers = {
  type: "object",
  properties: {
    total: { type: "integer" },
    invited: { type: "integer", description: "Active accounts that never signed in" },
    names: { type: "array", items: string, description: "The first three accounts" },
  },
};
const sourceSignIn = nullable({ type: "object", properties: { at: dateTime, user: string } });
const mapping = { type: "object", properties: { group: string, role: string } };

export const IDENTITY_OVERVIEW_OPENAPI_SCHEMAS = {
  AccountSource: {
    type: "object",
    properties: { kind: { type: "string", enum: ["local", "oidc", "saml", "ldap", "scim"] }, label: string },
  },
  UserSecondFactor: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["authenticator_app", "passkey", "identity_provider", "none", "not_needed"] },
      authenticatorApp: { type: "boolean" },
      passkeys: { type: "integer" },
      required: { type: "boolean", description: "The MFA policy requires a second factor of this account" },
      gate: { type: "string", enum: ["none", "prompt", "required"] },
      deadline: nullable(dateTime),
    },
  },
  UserOverviewEntry: {
    type: "object",
    properties: {
      id: { type: "integer" },
      email: string,
      name: nullable(string),
      username: nullable(string),
      role: { type: "string", enum: ["admin", "user", "viewer"] },
      customRoleId: nullable({ type: "integer" }),
      status: string,
      lastSignInAt: nullable(dateTime),
      lastSignInMethod: nullable({ type: "string", enum: ["password", "sso", "saml", "ldap", "passkey"] }),
      disabledAt: nullable(dateTime),
      invited: { type: "boolean" },
      createdAt: dateTime,
      sources: { type: "array", items: ref("AccountSource") },
      passwordSignIn: { type: "boolean" },
      secondFactor: ref("UserSecondFactor"),
      roleManagedBy: nullable(string),
      administrator: { type: "boolean" },
      breakGlass: { type: "boolean" },
      primaryAdmin: { type: "boolean" },
      apiTokenLastUsedAt: nullable(dateTime),
    },
  },
  UsersOverview: {
    type: "object",
    properties: {
      generatedAt: dateTime,
      users: { type: "array", items: ref("UserOverviewEntry") },
      mfaPolicy: nullable({
        type: "object",
        properties: {
          scope: { type: "string", enum: ["off", "admins", "password_users"] },
          graceDays: { type: "integer" },
          deadline: nullable(dateTime),
          required: { type: "integer" },
          enrolled: { type: "integer" },
        },
      }),
    },
  },
  GroupOverviewEntry: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: string,
      description: nullable(string),
      createdAt: dateTime,
      updatedAt: dateTime,
      members: {
        type: "array",
        items: { type: "object", properties: { userId: { type: "integer" }, email: string, name: nullable(string) } },
      },
      scim: nullable({ type: "object", properties: { origin: { type: "string", enum: ["scim", "adopted"] }, updatedAt: dateTime } }),
      roleMappings: nullable({
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["admin", "user", "viewer"] },
            customRoleId: nullable({ type: "integer" }),
            customRoleName: nullable(string),
            priority: { type: "integer" },
          },
        },
      }),
      hosts: nullable({
        type: "array",
        items: { type: "object", properties: { id: { type: "integer" }, name: string, domain: string } },
      }),
    },
  },
  GroupsOverview: {
    type: "object",
    properties: { generatedAt: dateTime, groups: { type: "array", items: ref("GroupOverviewEntry") } },
  },
  SignInOverview: {
    type: "object",
    properties: {
      generatedAt: dateTime,
      enforcement: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          warnings: { type: "array", items: string },
          changedAt: nullable(dateTime),
          changedBy: nullable(string),
          refusedLastWeek: { type: "integer", description: "Correct passwords refused in the last 7 days" },
          breakGlass: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                username: nullable(string),
                name: nullable(string),
                email: string,
                role: string,
                status: string,
                passwordSignIn: { type: "boolean" },
                validAdmin: { type: "boolean" },
                authenticatorApp: { type: "boolean" },
                passkeys: { type: "integer" },
                lastSignInAt: nullable(dateTime),
                lastSignInMethod: nullable(string),
              },
            },
          },
        },
      },
      loginPage: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["oidc", "saml", "ldap", "password", "passkey"] },
            label: string,
            state: { type: "string", enum: ["offered", "unavailable", "break_glass"] },
          },
        },
      },
      oauthRegistration: { type: "boolean" },
      oauthRoleFromClaims: { type: "boolean" },
      oidc: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: string,
            name: string,
            type: string,
            enabled: { type: "boolean" },
            issuer: nullable(string),
            host: nullable(string),
            scopes: string,
            autoLink: { type: "boolean" },
            users: sourceUsers,
            lastSignIn: sourceSignIn,
          },
        },
      },
      saml: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: string,
            enabled: { type: "boolean" },
            idpEntityId: string,
            users: sourceUsers,
            lastSignIn: sourceSignIn,
            mappings: { type: "array", items: mapping },
            defaultRole: string,
            requiredGroup: nullable(string),
            provisionUsers: { type: "boolean" },
            linkExistingAccounts: { type: "boolean" },
            subjectAttribute: nullable(string),
            certificate: nullable({
              type: "object",
              properties: { notAfter: dateTime, expired: { type: "boolean" }, count: { type: "integer" } },
            }),
            signsRequests: { type: "boolean" },
            warnings: { type: "array", items: string },
          },
        },
      },
      ldap: nullable({
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: string,
            enabled: { type: "boolean" },
            url: string,
            transport: { type: "string", enum: ["tls", "starttls", "unencrypted"] },
            ownCaCertificate: { type: "boolean" },
            users: sourceUsers,
            lastSignIn: sourceSignIn,
            mappings: { type: "array", items: mapping },
            defaultRole: string,
            groupMode: { type: "string", enum: ["none", "member_of", "search"] },
            nestedGroups: { type: "boolean" },
            requiredGroup: nullable(string),
            provisionUsers: { type: "boolean" },
            allowWhenSsoEnforced: { type: "boolean" },
            open: { type: "boolean", description: "Enabled, and open while SSO is enforced" },
            health: nullable({
              type: "object",
              properties: {
                status: { type: "string", enum: ["ok", "failing"] },
                checkedAt: dateTime,
                lastSuccessAt: nullable(dateTime),
                lastFailureAt: nullable(dateTime),
                failingSince: nullable(dateTime),
                lastError: nullable(string),
                consecutiveFailures: { type: "integer" },
              },
            }),
            warnings: { type: "array", items: string },
          },
        },
      }),
      scim: nullable({
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          endpointUrl: string,
          signInProvider: nullable(string),
          deleteMode: { type: "string", enum: ["disable", "delete"] },
          manageRoles: { type: "boolean" },
          defaultRole: string,
          users: sourceUsers,
          groups: { type: "integer" },
          mappings: { type: "array", items: { type: "object", properties: { group: string, role: string, priority: { type: "integer" } } } },
          tokens: {
            type: "object",
            properties: {
              count: { type: "integer" },
              latest: nullable({ type: "object", properties: { name: string, prefix: string, lastUsedAt: nullable(dateTime) } }),
            },
          },
          lastChange: nullable({ type: "object", properties: { at: dateTime, summary: string } }),
        },
      }),
    },
  },
};
