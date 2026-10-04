// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the SAML provider endpoints, spread into
 * app/api/v1/openapi.json/route.ts. Sign-in itself is Better Auth's
 * POST /api/auth/sign-in/saml and POST /api/auth/saml/acs/{id}, documented
 * in ee/docs/sso-saml.md.
 */

const TAG = "SAML Providers";

export const SAML_OPENAPI_TAG = {
  name: TAG,
  description:
    "SAML 2.0 identity providers for dashboard sign-in, with group-to-role mapping (Business edition). Creating, enabling and " +
    "changing a provider need the sso_saml feature; reading, disabling and deleting never do, and sign-in through an enabled " +
    "provider never checks the license. The SP signing key is never returned. Providers are per instance and not synced to " +
    "slaves. This API is the only way to manage providers: no /api/auth route registers or changes one. Sign-in is " +
    "SP-initiated only: POST /api/auth/sign-in/saml {providerId}, then the identity provider posts to the provider's ACS URL.",
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

export const SAML_OPENAPI_PATHS = {
  "/api/v1/saml-providers": {
    get: {
      tags: [TAG],
      summary: "List SAML providers",
      description: "Permission sso:read. Available without a license. The SP signing key is never returned (see hasSpPrivateKey).",
      operationId: "listSamlProviders",
      responses: { "200": { description: "Providers", content: json({ type: "array", items: ref("SamlProvider") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create a SAML provider",
      description:
        "Permission sso:write (administrator-level). Needs the sso_saml feature (403 otherwise). Give idpMetadataXml (parsed once, " +
        "never fetched), or idpEntityId, idpSsoUrl and idpCertificates. 409 when the name is taken.",
      operationId: "createSamlProvider",
      requestBody: { required: true, content: json(ref("SamlProviderInput")) },
      responses: { "201": { description: "Created", content: json(ref("SamlProvider")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/saml-providers/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a SAML provider",
      description: "Permission sso:read. Available without a license.",
      operationId: "getSamlProvider",
      parameters: [idParam],
      responses: { "200": { description: "Provider", content: json(ref("SamlProvider")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Update a SAML provider",
      description:
        "Permission sso:write. Fields left out keep their values; the SP signing key is kept unless generateSpKey, spPrivateKey " +
        "with spCertificate, or spPrivateKey: null (remove) is sent. Needs the sso_saml feature, except a body that only " +
        "disables the provider ({\"enabled\": false}), which works without a license.",
      operationId: "updateSamlProvider",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("SamlProviderUpdate")) },
      responses: { "200": { description: "Updated", content: json(ref("SamlProvider")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a SAML provider",
      description:
        "Permission sso:write. Never needs a license. The accounts linked through the provider, its group mappings, its sign-ins " +
        "in progress and its replay records are deleted; the users are kept.",
      operationId: "deleteSamlProvider",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/saml-providers/{id}/metadata": {
    get: {
      tags: [TAG],
      summary: "Get the SP metadata XML",
      description:
        "Permission sso:read. Available without a license. The service provider metadata to give the identity provider: entity " +
        "ID, ACS URL (HTTP-POST) and, when AuthnRequests are signed, the signing certificate. The same document is public at " +
        "/api/auth/saml/metadata/{id}.",
      operationId: "getSamlProviderMetadata",
      parameters: [idParam],
      responses: {
        "200": { description: "SP metadata", content: { "application/samlmetadata+xml": { schema: { type: "string" } } } },
        ...errors("401", "403", "404"),
      },
    },
  },
};

const attribute = (description: string) => ({ type: "string", maxLength: 256, description });
const optionalAttribute = (description: string) => ({ type: ["string", "null"], maxLength: 256, description });
const mapping = {
  type: "object",
  properties: {
    group: { type: "string", maxLength: 512, description: "Group value exactly as the identity provider sends it" },
    role: { type: "string", enum: ["admin", "user", "viewer"] },
  },
  required: ["group", "role"],
  additionalProperties: false,
};

const settingsProperties = {
  name: { type: "string", maxLength: 100, description: "Shown on the login page as Continue with <name>; unique" },
  enabled: { type: "boolean" },
  idpEntityId: { type: "string", maxLength: 1024, description: "The IdP's entity ID: the Issuer of its responses" },
  idpSsoUrl: { type: "string", description: "HTTP-Redirect single sign-on URL; https:// (http:// only on the loopback host)", example: "https://idp.example.com/saml/sso" },
  subjectAttribute: optionalAttribute("Attribute holding the immutable account id; null: the NameID, which must then be persistent"),
  emailAttribute: attribute("Attribute holding the e-mail address (default email)"),
  nameAttribute: optionalAttribute("Attribute holding the display name"),
  groupsAttribute: optionalAttribute("Attribute holding the groups; needed for groupRoleMappings and requiredGroup"),
  groupRoleMappings: { type: "array", maxItems: 100, items: mapping, description: "The only way SAML grants a role" },
  defaultRole: { type: "string", enum: ["user", "viewer"], description: "Role of a user in none of the mapped groups" },
  requiredGroup: { type: ["string", "null"], maxLength: 512, description: "Only users with this group can sign in" },
  provisionUsers: { type: "boolean", description: "Create an account at first sign-in (default false)" },
  linkExistingAccounts: { type: "boolean", description: "Link an existing account with exactly the asserted e-mail address (default false; never administrators or protected accounts)" },
};

const inputProperties = {
  ...settingsProperties,
  idpMetadataXml: { type: "string", writeOnly: true, description: "IdP metadata XML; fills idpEntityId, idpSsoUrl and idpCertificates unless they are sent too. Parsed once, never fetched." },
  idpCertificates: {
    oneOf: [{ type: "array", items: { type: "string" }, maxItems: 5 }, { type: "string" }],
    description: "PEM signing certificates (RSA), one or more for rollover",
  },
  generateSpKey: { type: "boolean", writeOnly: true, description: "Generate a new RSA key and self-signed certificate to sign AuthnRequests" },
  spPrivateKey: { type: ["string", "null"], writeOnly: true, description: "PEM private key to sign AuthnRequests (with spCertificate); null removes it. Stored encrypted; never returned." },
  spCertificate: { type: "string", description: "PEM certificate of spPrivateKey" },
};

export const SAML_OPENAPI_SCHEMAS = {
  SamlProvider: {
    type: "object",
    properties: {
      id: { type: "integer" },
      ...settingsProperties,
      idpCertificates: { type: "array", items: { type: "string" }, description: "PEM signing certificates" },
      certificates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subject: { type: "string" },
            issuer: { type: "string" },
            notBefore: { type: "string", format: "date-time" },
            notAfter: { type: "string", format: "date-time" },
            fingerprint: { type: "string", description: "SHA-256, colon-separated hex" },
            expired: { type: "boolean" },
          },
        },
      },
      spCertificate: { type: ["string", "null"], description: "PEM certificate of the SP signing key" },
      hasSpPrivateKey: { type: "boolean" },
      signsRequests: { type: "boolean", description: "AuthnRequests are signed (RSA-SHA256)" },
      sp: {
        type: "object",
        description: "Derived from BASE_URL and the id",
        properties: {
          entityId: { type: "string" },
          acsUrl: { type: "string" },
          metadataUrl: { type: "string" },
        },
        required: ["entityId", "acsUrl", "metadataUrl"],
      },
      linkedAccounts: { type: "integer", description: "Accounts linked through this provider" },
      warnings: { type: "array", items: { type: "string" } },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name", "enabled", "idpEntityId", "idpSsoUrl", "hasSpPrivateKey", "sp", "linkedAccounts", "warnings"],
  },
  SamlProviderInput: {
    type: "object",
    properties: inputProperties,
    required: ["name"],
    additionalProperties: false,
  },
  SamlProviderUpdate: {
    type: "object",
    properties: inputProperties,
    additionalProperties: false,
  },
};
