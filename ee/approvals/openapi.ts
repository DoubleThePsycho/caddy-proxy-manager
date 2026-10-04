// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the change approval endpoints, spread into
 * app/api/v1/openapi.json/route.ts.
 */
import {
  DEFAULT_REQUEST_TTL_HOURS,
  MAX_COMMENT_LENGTH,
  MAX_REQUEST_TTL_HOURS,
  MAX_REQUIRED_APPROVALS,
  MAX_WINDOWS,
  MIN_EMERGENCY_REASON_LENGTH,
  OPERATIONS,
  REQUEST_STATUSES,
  TARGET_TYPES,
} from "./types";

const TAG = "Change Approvals";

export const APPROVALS_OPENAPI_TAG = {
  name: TAG,
  description:
    "Four-eyes approval and change windows for protected proxy hosts and L4 proxy hosts (Enterprise edition). An approval policy " +
    "names the hosts (all, or those with given tags) and operations it protects; a change to such a host made through the host " +
    "endpoints answers 202 with a change request instead of applying it. Creating and changing policies needs the approvals " +
    "feature; disabling and deleting them never do, and enforcement never checks the license.",
};

/** Added to the descriptions of the host write endpoints. */
export const PROTECTED_HOST_NOTE =
  " On a host a change approval policy protects (see Change Approvals), the change is not applied: the response is 202 with the " +
  "change request, which is applied once enough other users approve it (and its change window is open).";

/** Added to the descriptions of the endpoints that replace the whole configuration. */
export const REPLACEMENT_PROTECTED_NOTE =
  " Refused (409, nothing changed) when the new configuration would create, change or delete a host that an enabled change " +
  "approval policy protects: make those changes through change requests, or disable the policies first.";

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
const commentBody = (required: boolean) => ({
  required,
  content: json({
    type: "object",
    additionalProperties: false,
    properties: { comment: { type: "string", maxLength: MAX_COMMENT_LENGTH } },
    ...(required ? { required: ["comment"] } : {}),
  }),
});
const requestResponse = (description: string) => ({ description, content: json(ref("ChangeRequest")) });

export const APPROVALS_OPENAPI_PATHS = {
  "/api/v1/approval-policies": {
    get: {
      tags: [TAG],
      summary: "List approval policies",
      description: "Permission approvals:read. Available without a license.",
      operationId: "listApprovalPolicies",
      responses: { "200": { description: "Policies", content: json({ type: "array", items: ref("ApprovalPolicy") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create an approval policy",
      description:
        "Permission approvals:manage (administrator-level); needs the approvals feature (403 otherwise). 409 for a duplicate name.",
      operationId: "createApprovalPolicy",
      requestBody: { required: true, content: json(ref("ApprovalPolicyInput")) },
      responses: { "201": { description: "Created", content: json(ref("ApprovalPolicy")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/approval-policies/{id}": {
    get: {
      tags: [TAG],
      summary: "Get an approval policy",
      description: "Permission approvals:read.",
      operationId: "getApprovalPolicy",
      parameters: [idParam],
      responses: { "200": { description: "Policy", content: json(ref("ApprovalPolicy")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Update an approval policy",
      description:
        "Permission approvals:manage. Fields left out keep their values. Needs the approvals feature, except for {\"enabled\": false}, " +
        "which turns the policy off without a license. Pending requests keep the approvals they need, or more if the policy now asks more.",
      operationId: "updateApprovalPolicy",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("ApprovalPolicyInput")) },
      responses: { "200": { description: "Updated", content: json(ref("ApprovalPolicy")) }, ...errors("400", "401", "403", "404", "409") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete an approval policy",
      description: "Permission approvals:manage. Never needs a license. Requests made under it stay as they are.",
      operationId: "deleteApprovalPolicy",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/change-requests": {
    get: {
      tags: [TAG],
      summary: "List change requests",
      description:
        "Permission approvals:read. Lists the requests on hosts the caller can read (within a role's tag scope), and the caller's own, " +
        "newest first. Pending requests past their expiry are marked expired first.",
      operationId: "listChangeRequests",
      parameters: [
        {
          name: "status",
          in: "query",
          schema: { type: "string", enum: ["all", "open", "closed", ...REQUEST_STATUSES] },
          description: "open: pending and approved; closed: the rest. Default all.",
        },
        { name: "mine", in: "query", schema: { type: "boolean" }, description: "Only requests the caller made" },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "perPage", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
      ],
      responses: { "200": { description: "A page of change requests", content: json(ref("ChangeRequestPage")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/change-requests/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a change request",
      description: "Permission approvals:read. 404 for a request on a host the caller cannot read.",
      operationId: "getChangeRequest",
      parameters: [idParam],
      responses: { "200": requestResponse("Change request"), ...errors("401", "403", "404") },
    },
  },
  "/api/v1/change-requests/{id}/approve": {
    post: {
      tags: [TAG],
      summary: "Approve a change request",
      description:
        "Permission approvals:approve. Nobody approves their own request (403); each user counts once (409 for a second approval). " +
        "With enough approvals the request is approved and applied at once when every covering policy's change window is open, " +
        "otherwise when the window opens. Applying re-checks that the host is unchanged since the request and that the requester " +
        "still holds the permission and tag scope it needs; otherwise the request fails.",
      operationId: "approveChangeRequest",
      parameters: [idParam],
      requestBody: commentBody(false),
      responses: { "200": requestResponse("The request after the approval"), ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/change-requests/{id}/reject": {
    post: {
      tags: [TAG],
      summary: "Reject a change request",
      description: "Permission approvals:approve. A comment is required. The requester cancels instead (403).",
      operationId: "rejectChangeRequest",
      parameters: [idParam],
      requestBody: commentBody(true),
      responses: { "200": requestResponse("The rejected request"), ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/change-requests/{id}/cancel": {
    post: {
      tags: [TAG],
      summary: "Cancel a change request",
      description: "Permission approvals:read; only the requester, or a user holding approvals:manage, may cancel.",
      operationId: "cancelChangeRequest",
      parameters: [idParam],
      requestBody: commentBody(false),
      responses: { "200": requestResponse("The cancelled request"), ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/change-requests/{id}/comments": {
    post: {
      tags: [TAG],
      summary: "Comment on a change request",
      description: "Permission approvals:read.",
      operationId: "commentOnChangeRequest",
      parameters: [idParam],
      requestBody: commentBody(true),
      responses: { "201": requestResponse("The request with the comment"), ...errors("400", "401", "403", "404") },
    },
  },
  "/api/v1/change-requests/{id}/apply": {
    post: {
      tags: [TAG],
      summary: "Apply an approved change request now",
      description:
        "Permission approvals:approve. Only inside the change window (409 outside it, naming when it opens). The scheduler applies " +
        "approved requests by itself within a minute of the window opening.",
      operationId: "applyChangeRequest",
      parameters: [idParam],
      responses: { "200": requestResponse("The request after applying (status applied or failed)"), ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/change-requests/{id}/emergency": {
    post: {
      tags: [TAG],
      summary: "Apply a change request as an emergency change",
      description:
        `Permission approvals:emergency (administrator-level). Applies a pending or approved request at once, without approvals or ` +
        `change windows, with a mandatory reason (at least ${MIN_EMERGENCY_REASON_LENGTH} characters). Refused (403) when a covering ` +
        "policy forbids emergency changes. The request and the audit log flag it as an emergency change.",
      operationId: "emergencyApplyChangeRequest",
      parameters: [idParam],
      requestBody: {
        required: true,
        content: json({
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: "string", minLength: MIN_EMERGENCY_REASON_LENGTH, maxLength: MAX_COMMENT_LENGTH } },
          required: ["reason"],
        }),
      },
      responses: { "200": requestResponse("The request after applying (status applied or failed)"), ...errors("400", "401", "403", "404", "409") },
    },
  },
};

const windowSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    days: {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
    },
    start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", example: "09:00" },
    end: {
      type: "string",
      pattern: "^(([01]\\d|2[0-3]):[0-5]\\d|24:00)$",
      example: "17:00",
      description: "An end not after the start runs past midnight into the next day",
    },
  },
  required: ["days", "start", "end"],
};

const policyProperties = {
  name: { type: "string", maxLength: 100 },
  description: { type: ["string", "null"], maxLength: 500 },
  enabled: { type: "boolean" },
  targetTypes: { type: "array", minItems: 1, items: { type: "string", enum: [...TARGET_TYPES] } },
  operations: {
    type: "array",
    minItems: 1,
    items: { type: "string", enum: [...OPERATIONS] },
    description: "update: any change of a host's settings; enable/disable: turning it on or off",
  },
  hostTags: { type: "array", items: { type: "string" }, description: "Hosts with one of these tags; empty: every host" },
  requiredApprovals: { type: "integer", minimum: 1, maximum: MAX_REQUIRED_APPROVALS, description: "Distinct approvers, never the requester" },
  allowEmergency: { type: "boolean", description: "Whether approvals:emergency may skip this policy" },
  timeZone: { type: "string", example: "Europe/Rome", description: "IANA time zone the windows are read in" },
  windows: { type: "array", maxItems: MAX_WINDOWS, items: windowSchema, description: "When approved changes may be applied; empty: any time" },
  requestTtlHours: {
    type: "integer",
    minimum: 1,
    maximum: MAX_REQUEST_TTL_HOURS,
    description: `Hours a request waits for approval before it expires (default ${DEFAULT_REQUEST_TTL_HOURS})`,
  },
};

const userRef = { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } }, required: ["id", "name"] };

export const APPROVALS_OPENAPI_SCHEMAS = {
  ApprovalPolicyInput: {
    type: "object",
    additionalProperties: false,
    properties: policyProperties,
    required: ["name"],
    description: "On create, left-out fields default to: every target type and operation, every host, 1 approval, emergency allowed, UTC, no windows.",
  },
  ApprovalPolicy: {
    type: "object",
    properties: {
      id: { type: "integer" },
      ...policyProperties,
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name", "enabled", "targetTypes", "operations", "hostTags", "requiredApprovals", "allowEmergency", "timeZone", "windows", "requestTtlHours"],
  },
  ChangeRequest: {
    type: "object",
    properties: {
      id: { type: "integer" },
      targetType: { type: "string", enum: [...TARGET_TYPES] },
      targetId: { type: ["integer", "null"], description: "Null for a create until it is applied" },
      targetName: { type: "string" },
      operation: { type: "string", enum: [...OPERATIONS] },
      operations: { type: "array", items: { type: "string", enum: [...OPERATIONS] } },
      status: { type: "string", enum: [...REQUEST_STATUSES] },
      requestedBy: userRef,
      note: { type: ["string", "null"] },
      emergency: { type: "boolean" },
      emergencyReason: { type: ["string", "null"] },
      emergencyBy: { oneOf: [userRef, { type: "null" }] },
      requiredApprovals: { type: "integer" },
      approvals: { type: "integer", description: "Distinct approvers so far" },
      policies: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
      tags: { type: "array", items: { type: "string" } },
      input: { type: "object", description: "The validated change: host (fields), forwardAuthAccess, mtlsRule" },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, before: {}, after: {}, secret: { type: "boolean" } },
          required: ["path"],
        },
        description: "Field-level changes against the host as it was when requested",
      },
      reviews: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            userId: { type: "integer" },
            userName: { type: "string" },
            decision: { type: "string", enum: ["approve", "reject", "comment"] },
            comment: { type: ["string", "null"] },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
      window: {
        type: "object",
        properties: {
          restricted: { type: "boolean" },
          open: { type: "boolean" },
          nextOpenAt: { type: ["string", "null"], format: "date-time" },
          description: { type: ["string", "null"] },
        },
      },
      expiresAt: { type: "string", format: "date-time" },
      decidedAt: { type: ["string", "null"], format: "date-time" },
      appliedAt: { type: ["string", "null"], format: "date-time" },
      appliedBy: { oneOf: [userRef, { type: "null" }], description: "Null when the scheduler applied it" },
      error: { type: ["string", "null"], description: "Why applying failed, or a warning when Caddy did not take the saved change" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      viewer: {
        type: "object",
        description: "What the caller may do with the request",
        properties: {
          isRequester: { type: "boolean" },
          canApprove: { type: "boolean" },
          canReject: { type: "boolean" },
          canCancel: { type: "boolean" },
          canApply: { type: "boolean" },
          canEmergency: { type: "boolean" },
        },
      },
      impact: { $ref: "#/components/schemas/ChangeImpact" },
    },
    required: ["id", "targetType", "targetName", "operation", "status", "requestedBy", "requiredApprovals", "approvals", "changes", "expiresAt", "impact"],
  },
  ChangeImpact: {
    type: "object",
    description:
      "What applying the request does: the host it changes (a request changes exactly one), whether Caddy reloads and on how many nodes " +
      "(this node and, on a master, the enabled instances outside promotion-only environments), the certificates Caddy will request, " +
      "whether L4 listening ports change, and when it applies given the change windows of the policies that cover it.",
    properties: {
      hosts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["proxy_host", "l4_proxy_host"] },
            id: { type: ["integer", "null"] },
            name: { type: "string" },
            domains: { type: "array", items: { type: "string" } },
            change: { type: "string", enum: ["create", "update", "delete"] },
            operations: { type: "array", items: { type: "string" } },
          },
        },
      },
      otherHosts: { type: "integer", description: "Always 0" },
      caddy: {
        type: "object",
        properties: {
          reloads: { type: "boolean" },
          nodes: { type: "integer" },
          instances: { type: "array", items: { type: "string" } },
          heldBack: { type: "array", items: { type: "string" }, description: "Instances that get the change only through promotion" },
          certificateRequests: { type: "array", items: { type: "string" } },
          l4PortsChange: { type: "boolean" },
        },
      },
      schedule: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["on_approval", "next_window", "now", "waiting", "done"] },
          at: { type: ["string", "null"], format: "date-time" },
          windows: { type: ["string", "null"] },
          description: { type: "string" },
        },
      },
      lines: {
        type: "array",
        items: { type: "object", properties: { key: { type: "string", enum: ["hosts", "caddy", "when"] }, text: { type: "string" } } },
      },
    },
  },
  ChangeRequestPage: {
    type: "object",
    properties: {
      requests: { type: "array", items: ref("ChangeRequest") },
      total: { type: "integer" },
      page: { type: "integer" },
      perPage: { type: "integer" },
    },
    required: ["requests", "total", "page", "perPage"],
  },
};

/** The 202 answer of a host write endpoint on a protected host. */
export const CHANGE_REQUEST_SUBMITTED_RESPONSE = {
  description: "A change approval policy protects the host: the change was stored as a change request, not applied",
  content: json(ref("ChangeRequest")),
};
