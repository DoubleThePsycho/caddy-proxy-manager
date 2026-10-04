/**
 * OpenAPI paths and schema of the proxy host change previews
 * (POST /api/v1/proxy-hosts/preview and /api/v1/proxy-hosts/{id}/preview),
 * spread into app/api/v1/openapi.json/route.ts. The host editor's review
 * panel shows the same answer.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const PREVIEW_NOTE =
  " Runs the same scope checks as the write (tags, domains of other scopes, certificates, access lists, custom Caddy JSON, " +
  "mTLS trust), so a change the caller may not make answers 400 or 403 here already. Nothing is stored and Caddy is not reloaded.";

const responses = (description: string) => ({
  "200": { description, content: { "application/json": { schema: ref("ProxyHostChangePreview") } } },
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
});

export const PROXY_HOST_PREVIEW_OPENAPI_PATHS = {
  "/api/v1/proxy-hosts/preview": {
    post: {
      tags: ["Proxy Hosts"],
      summary: "Preview creating a proxy host",
      description:
        "Permission proxy_hosts:write. Takes the body of POST /api/v1/proxy-hosts and answers what creating the host would do: " +
        "whether a change approval policy covers it (and then how many approvals it needs, its change window and whether the " +
        "caller may apply it as an emergency change), the fields it sets and its impact." + PREVIEW_NOTE,
      operationId: "previewCreateProxyHost",
      requestBody: { required: true, content: { "application/json": { schema: ref("ProxyHostInput") } } },
      responses: responses("What creating the host would do"),
    },
  },
  "/api/v1/proxy-hosts/{id}/preview": {
    post: {
      tags: ["Proxy Hosts"],
      summary: "Preview updating a proxy host",
      description:
        "Permission proxy_hosts:write. Takes the body of PUT /api/v1/proxy-hosts/{id} and answers what the update would do: " +
        "whether a change approval policy covers it, the fields it changes against the host as it is now, and its impact. " +
        "A host outside the caller's tag scope answers 404." + PREVIEW_NOTE,
      operationId: "previewUpdateProxyHost",
      parameters: [{ $ref: "#/components/parameters/IdPath" }],
      requestBody: { required: true, content: { "application/json": { schema: ref("ProxyHostInput") } } },
      responses: { ...responses("What the update would do"), "404": { $ref: "#/components/responses/NotFound" } },
    },
  },
};

export const PROXY_HOST_PREVIEW_OPENAPI_SCHEMAS = {
  ProxyHostChangePreview: {
    type: "object",
    properties: {
      approval: {
        type: "object",
        properties: {
          required: { type: "boolean", description: "A change approval policy covers the change, so saving it creates a change request" },
          policies: {
            type: "array",
            description: "The covering policies; empty for organisation users (the policies are the provider's)",
            items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
          },
          requiredApprovals: { type: "integer", description: "Distinct approvals needed, from someone other than the requester; 0 when none" },
          operations: { type: "array", items: { type: "string", enum: ["create", "update", "delete", "enable", "disable"] } },
          window: {
            type: "object",
            properties: {
              restricted: { type: "boolean" },
              open: { type: "boolean" },
              nextOpenAt: { type: ["string", "null"], format: "date-time" },
              description: { type: ["string", "null"] },
            },
          },
          emergencyAllowed: { type: "boolean", description: "The caller may apply it at once as an emergency change (approvals:emergency)" },
          minEmergencyReasonLength: { type: "integer" },
        },
      },
      changes: {
        type: "array",
        description: "Field by field, against the host as it is now (every field it sets for a new host)",
        items: {
          type: "object",
          properties: { path: { type: "string" }, before: {}, after: {}, secret: { type: "boolean" } },
          required: ["path"],
        },
      },
      impact: ref("ChangeImpact"),
      warning: { type: ["string", "null"], description: "Set when the chosen certificate no longer exists and Caddy would manage the certificate" },
    },
    required: ["approval", "changes", "impact", "warning"],
  },
};
