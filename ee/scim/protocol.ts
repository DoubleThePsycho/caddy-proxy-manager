// SPDX-License-Identifier: Elastic-2.0
/**
 * SCIM 2.0 protocol plumbing (RFC 7643, RFC 7644): media type, error bodies,
 * list responses and the discovery documents (ServiceProviderConfig,
 * ResourceTypes, Schemas).
 */
import { NextResponse } from "next/server";
import { config } from "@/src/lib/config";
import { ApiClientError } from "@/src/lib/api-errors";
import { logUnexpectedApiError } from "@/src/lib/api-auth";
import { SCIM_BASE_PATH } from "./types";

export const SCIM_CONTENT_TYPE = "application/scim+json";

export const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCHEMA_ENTERPRISE_USER = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCHEMA_SERVICE_PROVIDER_CONFIG = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCHEMA_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** Largest page a list request gets; also announced as filter.maxResults. */
export const MAX_RESULTS = 200;
/** Page size when the request has no `count`. */
export const DEFAULT_COUNT = 100;
/** Largest request body accepted. */
export const MAX_BODY_BYTES = 1024 * 1024;

export type ScimType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue";

/** A SCIM error (RFC 7644 section 3.12). The detail is application-authored and safe to return. */
export class ScimError extends Error {
  readonly status: number;
  readonly scimType: ScimType | null;
  constructor(status: number, detail: string, scimType: ScimType | null = null) {
    super(detail);
    this.name = "ScimError";
    this.status = status;
    this.scimType = scimType;
  }
}

export function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, "Cache-Control": "no-store", ...headers },
  });
}

export function scimNoContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

function errorBody(status: number, detail: string, scimType: ScimType | null) {
  return {
    schemas: [SCHEMA_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

/** The SCIM error response for anything a SCIM handler throws. */
export function scimErrorResponse(error: unknown): NextResponse {
  if (error instanceof ScimError) {
    const headers: Record<string, string> = error.status === 401 ? { "WWW-Authenticate": 'Bearer realm="SCIM"' } : {};
    return scimJson(errorBody(error.status, error.message, error.scimType), error.status, headers);
  }
  if (error instanceof ApiClientError) {
    // Guards shared with the dashboard (last administrator, enforced SSO,
    // sign-in names) carry messages meant to be shown.
    const scimType: ScimType | null = error.status === 409 ? "uniqueness" : error.status === 400 ? "invalidValue" : null;
    return scimJson(errorBody(error.status, error.message, scimType), error.status);
  }
  const errorId = logUnexpectedApiError("Unhandled SCIM error", error);
  return scimJson(errorBody(500, `Internal server error (${errorId})`, null), 500);
}

/** Absolute URL of a SCIM resource, for meta.location and member $ref. */
export function resourceLocation(resourceType: "Users" | "Groups", id: number | string): string {
  return `${config.baseUrl.replace(/\/+$/, "")}${SCIM_BASE_PATH}/${resourceType}/${id}`;
}

export function scimEndpointUrl(): string {
  return `${config.baseUrl.replace(/\/+$/, "")}${SCIM_BASE_PATH}`;
}

export type Page = { startIndex: number; count: number };

/**
 * startIndex and count of a list request (RFC 7644 section 3.4.2.4): a
 * startIndex below 1 is 1, a negative count is 0, and count is capped at
 * MAX_RESULTS.
 */
export function readPage(params: URLSearchParams): Page {
  const parse = (value: string | null): number | null => {
    if (value === null || value.trim() === "") return null;
    if (!/^-?\d{1,9}$/.test(value.trim())) throw new ScimError(400, "startIndex and count must be integers", "invalidValue");
    return Number(value);
  };
  const startIndex = Math.max(1, parse(params.get("startIndex")) ?? 1);
  const count = Math.min(MAX_RESULTS, Math.max(0, parse(params.get("count")) ?? DEFAULT_COUNT));
  return { startIndex, count };
}

export function listResponse(resources: unknown[], totalResults: number, page: Page) {
  return {
    schemas: [SCHEMA_LIST],
    totalResults,
    startIndex: page.startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/**
 * Applies `attributes` / `excludedAttributes` (RFC 7644 section 3.9) to a
 * resource, on top-level attributes. id, schemas and meta are always returned;
 * userName (User) and displayName (Group) too, as the RFC asks for
 * "returned: always" attributes.
 */
export function projectResource(
  resource: Record<string, unknown>,
  params: URLSearchParams
): Record<string, unknown> {
  const always = new Set(["id", "schemas", "meta", "username", "displayname"]);
  const names = (value: string | null) =>
    (value ?? "")
      .split(",")
      .map((name) => stripCoreSchema(name.trim()).split(".")[0].toLowerCase())
      .filter(Boolean);
  const attributes = names(params.get("attributes"));
  const excluded = names(params.get("excludedAttributes"));
  if (attributes.length === 0 && excluded.length === 0) return resource;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resource)) {
    const lower = key.toLowerCase();
    if (always.has(lower)) result[key] = value;
    else if (attributes.length > 0) {
      if (attributes.includes(lower)) result[key] = value;
    } else if (!excluded.includes(lower)) {
      result[key] = value;
    }
  }
  return result;
}

/** "urn:ietf:params:scim:schemas:core:2.0:User:userName" is "userName". */
export function stripCoreSchema(path: string): string {
  for (const urn of [SCHEMA_USER, SCHEMA_GROUP]) {
    if (path.toLowerCase().startsWith(`${urn.toLowerCase()}:`)) return path.slice(urn.length + 1);
  }
  return path;
}

// ── Discovery ───────────────────────────────────────────────────────────

export function serviceProviderConfig() {
  return {
    schemas: [SCHEMA_SERVICE_PROVIDER_CONFIG],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "A SCIM token created on the Provisioning page, sent as Authorization: Bearer <token>.",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${scimEndpointUrl()}/ServiceProviderConfig` },
  };
}

const RESOURCE_TYPES = [
  { id: "User", name: "User", endpoint: "/Users", description: "Dashboard user account", schema: SCHEMA_USER },
  { id: "Group", name: "Group", endpoint: "/Groups", description: "Forward-auth group", schema: SCHEMA_GROUP },
] as const;

export function resourceTypes() {
  return RESOURCE_TYPES.map((type) => ({
    schemas: [SCHEMA_RESOURCE_TYPE],
    ...type,
    meta: { resourceType: "ResourceType", location: `${scimEndpointUrl()}/ResourceTypes/${type.id}` },
  }));
}

type AttributeDefinition = {
  name: string;
  type: "string" | "boolean" | "complex" | "reference";
  multiValued: boolean;
  required: boolean;
  caseExact: boolean;
  mutability: "readOnly" | "readWrite" | "immutable" | "writeOnly";
  returned: "always" | "never" | "default" | "request";
  uniqueness: "none" | "server" | "global";
  description?: string;
  subAttributes?: AttributeDefinition[];
  referenceTypes?: string[];
};

function attribute(
  name: string,
  overrides: Partial<AttributeDefinition> = {}
): AttributeDefinition {
  return {
    name,
    type: "string",
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: "readWrite",
    returned: "default",
    uniqueness: "none",
    ...overrides,
  };
}

const USER_ATTRIBUTES: AttributeDefinition[] = [
  attribute("userName", { required: true, uniqueness: "server", description: "Unique identifier of the user at the identity provider; never used to sign in to the dashboard by itself." }),
  attribute("name", {
    type: "complex",
    subAttributes: [attribute("formatted"), attribute("givenName"), attribute("familyName")],
  }),
  attribute("displayName", { description: "Shown as the user's name in the dashboard." }),
  attribute("active", { type: "boolean", description: "false disables the account and revokes its sessions and API tokens." }),
  attribute("emails", {
    type: "complex",
    multiValued: true,
    required: true,
    description: "The primary address (or the only one) is the account's e-mail address.",
    subAttributes: [attribute("value"), attribute("type"), attribute("primary", { type: "boolean" })],
  }),
  attribute("groups", {
    type: "complex",
    multiValued: true,
    mutability: "readOnly",
    subAttributes: [
      attribute("value", { mutability: "readOnly" }),
      attribute("$ref", { type: "reference", mutability: "readOnly", referenceTypes: ["Group"] }),
      attribute("display", { mutability: "readOnly" }),
    ],
  }),
];

const GROUP_ATTRIBUTES: AttributeDefinition[] = [
  attribute("displayName", { required: true, uniqueness: "server" }),
  attribute("members", {
    type: "complex",
    multiValued: true,
    subAttributes: [
      attribute("value", { mutability: "immutable" }),
      attribute("$ref", { type: "reference", mutability: "immutable", referenceTypes: ["User"] }),
      attribute("display", { mutability: "readOnly" }),
    ],
  }),
];

export function schemaDefinitions() {
  return [
    { id: SCHEMA_USER, name: "User", description: "User account", attributes: USER_ATTRIBUTES },
    { id: SCHEMA_GROUP, name: "Group", description: "Group", attributes: GROUP_ATTRIBUTES },
  ].map((definition) => ({
    schemas: [SCHEMA_SCHEMA],
    ...definition,
    meta: { resourceType: "Schema", location: `${scimEndpointUrl()}/Schemas/${definition.id}` },
  }));
}
