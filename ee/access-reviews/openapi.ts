// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of access reviews, spread into
 * app/api/v1/openapi.json/route.ts.
 */

const TAG = "Access Reviews";

export const ACCESS_REVIEWS_OPENAPI_TAG = {
  name: TAG,
  description:
    "Periodic access recertification (Enterprise edition): campaigns over the users in a scope, whose reviewers keep or revoke " +
    "each account, role, group membership and API token, with a CSV/JSON record. Starting a campaign and creating, enabling or " +
    "changing a schedule need the access_reviews feature; completing, cancelling and deleting campaigns, disabling and deleting " +
    "schedules, and reviewers' decisions never do. access_reviews:write is administrator-level. Reviewers need no permission: " +
    "being named on a campaign lets them use the /api/v1/access-review-assignments endpoints for it.",
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

export const ACCESS_REVIEWS_OPENAPI_PATHS = {
  "/api/v1/access-reviews": {
    get: {
      tags: [TAG],
      summary: "List access review campaigns",
      description: "Permission access_reviews:read. Newest first, with counts.",
      operationId: "listAccessReviews",
      responses: { "200": { description: "Campaigns", content: json({ type: "array", items: ref("AccessReviewSummary") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Start an access review",
      description:
        "Permission access_reviews:write (administrator-level); needs the access_reviews feature. Snapshots every access of the " +
        "active users in scope. 400 when nobody is in scope or a user in scope is the only reviewer.",
      operationId: "startAccessReview",
      requestBody: { required: true, content: json(ref("AccessReviewInput")) },
      responses: { "201": { description: "Started", content: json(ref("AccessReview")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/access-reviews/{id}": {
    get: {
      tags: [TAG],
      summary: "Get an access review with its items",
      description: "Permission access_reviews:read.",
      operationId: "getAccessReview",
      parameters: [idParam],
      responses: { "200": { description: "Campaign", content: json(ref("AccessReview")) }, ...errors("401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete an access review",
      description: "Permission access_reviews:write. Deletes the campaign and its record (the audit log keeps the events). Never needs a license.",
      operationId: "deleteAccessReview",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/access-reviews/{id}/complete": {
    post: {
      tags: [TAG],
      summary: "Complete an access review now",
      description: "Permission access_reviews:write. Items nobody confirmed are recorded as not_reviewed. Never needs a license.",
      operationId: "completeAccessReview",
      parameters: [idParam],
      responses: { "200": { description: "Campaign", content: json(ref("AccessReview")) }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/access-reviews/{id}/cancel": {
    post: {
      tags: [TAG],
      summary: "Cancel an access review",
      description: "Permission access_reviews:write. Never needs a license.",
      operationId: "cancelAccessReview",
      parameters: [idParam],
      responses: { "200": { description: "Campaign", content: json(ref("AccessReview")) }, ...errors("401", "403", "404", "409") },
    },
  },
  "/api/v1/access-reviews/{id}/record": {
    get: {
      tags: [TAG],
      summary: "Download the record",
      description: "Permission access_reviews:read. CSV (default) or JSON, as an attachment. Interim while the campaign is open.",
      operationId: "getAccessReviewRecord",
      parameters: [idParam, { name: "format", in: "query", schema: { type: "string", enum: ["csv", "json"], default: "csv" } }],
      responses: {
        "200": {
          description: "Record",
          content: { "text/csv": { schema: { type: "string" } }, "application/json": { schema: ref("AccessReviewRecord") } },
        },
        ...errors("400", "401", "403", "404"),
      },
    },
  },
  "/api/v1/access-reviews/{id}/evidence": {
    get: {
      tags: [TAG],
      summary: "Get the evidence for a campaign's items",
      description:
        "Permission access_reviews:read. For each person: how the account signs in (password, OAuth/OIDC, LDAP, SAML, SCIM), MFA, " +
        "the last sign-in and sign-ins in the last 30 days, the last change they made and whether a directory sets their role at sign-in; " +
        "for each item, when that access was last used. Read now from the audit log and the accounts; never stored.",
      operationId: "getAccessReviewEvidence",
      parameters: [idParam],
      responses: { "200": { description: "Evidence", content: json(ref("AccessReviewEvidence")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/access-review-assignments/evidence": {
    get: {
      tags: [TAG],
      summary: "Get the evidence for a campaign you review",
      description: "No permission needed: the caller must be a reviewer of the open campaign; any other campaign answers 404.",
      operationId: "getAccessReviewAssignmentEvidence",
      parameters: [{ name: "campaignId", in: "query", required: true, schema: { type: "integer" } }],
      responses: { "200": { description: "Evidence", content: json(ref("AccessReviewEvidence")) }, ...errors("401", "404") },
    },
  },
  "/api/v1/access-review-schedules": {
    get: {
      tags: [TAG],
      summary: "List schedules",
      description: "Permission access_reviews:read.",
      operationId: "listAccessReviewSchedules",
      responses: { "200": { description: "Schedules", content: json({ type: "array", items: ref("AccessReviewSchedule") }) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Create a schedule",
      description:
        "Permission access_reviews:write; needs the access_reviews feature. Starts a campaign every intervalMonths, due durationDays " +
        "later. When firstRunAt is now or earlier (the default) the first campaign starts right away.",
      operationId: "createAccessReviewSchedule",
      requestBody: { required: true, content: json(ref("AccessReviewScheduleInput")) },
      responses: { "201": { description: "Created", content: json(ref("AccessReviewSchedule")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/access-review-schedules/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a schedule",
      description: "Permission access_reviews:read.",
      operationId: "getAccessReviewSchedule",
      parameters: [idParam],
      responses: { "200": { description: "Schedule", content: json(ref("AccessReviewSchedule")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Change a schedule",
      description: "Permission access_reviews:write. Needs the access_reviews feature unless the body is only {\"enabled\": false}.",
      operationId: "updateAccessReviewSchedule",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("AccessReviewScheduleInput")) },
      responses: { "200": { description: "Schedule", content: json(ref("AccessReviewSchedule")) }, ...errors("400", "401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a schedule",
      description: "Permission access_reviews:write. Campaigns it started stay. Never needs a license.",
      operationId: "deleteAccessReviewSchedule",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/access-review-assignments": {
    get: {
      tags: [TAG],
      summary: "My open reviews",
      description: "Any signed-in user or API token: the open campaigns the caller reviews, with their items. Items of the caller's own access are marked ownAccess.",
      operationId: "listAccessReviewAssignments",
      responses: { "200": { description: "Assignments", content: json({ type: "array", items: ref("AccessReviewAssignment") }) }, ...errors("401") },
    },
  },
  "/api/v1/access-review-assignments/{id}": {
    put: {
      tags: [TAG],
      summary: "Draft a decision on an item",
      description:
        "Reviewers of the item's campaign only (404 otherwise). 403 for the caller's own access, 409 once confirmed or when the " +
        "campaign is closed. decision null clears the draft.",
      operationId: "draftAccessReviewDecision",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("AccessReviewDecisionInput")) },
      responses: { "200": { description: "Item", content: json(ref("AccessReviewItem")) }, ...errors("400", "401", "403", "404", "409") },
    },
  },
  "/api/v1/access-review-assignments/confirm": {
    post: {
      tags: [TAG],
      summary: "Confirm my decisions",
      description:
        "Confirms the caller's draft decisions in one campaign and applies the revocations through the same functions as manual " +
        "changes (last-administrator and break-glass guards included). The campaign completes when its last item is confirmed.",
      operationId: "confirmAccessReviewDecisions",
      requestBody: { required: true, content: json({ type: "object", additionalProperties: false, properties: { campaignId: { type: "integer" } }, required: ["campaignId"] }) },
      responses: { "200": { description: "Result", content: json(ref("AccessReviewConfirmResult")) }, ...errors("400", "401", "404", "409") },
    },
  },
};

const timestamp = { type: "string", format: "date-time" };
const nullableTimestamp = { type: ["string", "null"], format: "date-time" };
const scope = {
  oneOf: [
    { type: "object", properties: { type: { const: "all" } }, required: ["type"] },
    {
      type: "object",
      properties: {
        type: { const: "filter" },
        roles: { type: "array", items: { type: "string", enum: ["admin", "user", "viewer"] } },
        customRoleIds: { type: "array", items: { type: "integer" } },
        groupIds: { type: "array", items: { type: "integer" } },
      },
      required: ["type"],
    },
  ],
};
const reviewer = { type: "object", properties: { id: { type: "integer" }, email: { type: ["string", "null"] }, name: { type: ["string", "null"] } } };

export const ACCESS_REVIEWS_OPENAPI_SCHEMAS = {
  AccessReviewEvidence: {
    type: "object",
    properties: {
      campaignId: { type: "integer" },
      generatedAt: { type: "string", format: "date-time" },
      subjects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            userId: { type: "integer" },
            exists: { type: "boolean" },
            status: { type: ["string", "null"] },
            sources: {
              type: "array",
              items: { type: "object", properties: { kind: { type: "string", enum: ["local", "oidc", "ldap", "saml", "scim"] }, label: { type: "string" } } },
            },
            mfa: { type: "boolean" },
            lastSignIn: { type: ["object", "null"], properties: { at: { type: "string" }, summary: { type: ["string", "null"] } } },
            signInsLast30Days: { type: "integer" },
            lastChange: {
              type: ["object", "null"],
              properties: { at: { type: "string" }, action: { type: "string" }, entityType: { type: "string" }, summary: { type: ["string", "null"] } },
            },
            roleManagedBy: { type: ["string", "null"], description: "A directory or provider that sets the role at each sign-in" },
          },
        },
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            itemId: { type: "integer" },
            kind: { type: "string", enum: ["account", "role", "group", "api_token"] },
            lastUsed: { type: ["object", "null"], properties: { at: { type: "string" }, detail: { type: "string" } } },
            note: { type: ["string", "null"] },
          },
        },
      },
    },
  },
  AccessReviewInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 100 },
      scope,
      reviewerIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50 },
      dueAt: { ...timestamp, description: "In the future, within 366 days" },
    },
    required: ["name", "reviewerIds", "dueAt"],
  },
  AccessReviewCounts: {
    type: "object",
    properties: Object.fromEntries(
      ["total", "pending", "drafted", "kept", "revoked", "unchanged", "failed", "notReviewed", "unreviewable"].map((key) => [key, { type: "integer" }])
    ),
  },
  AccessReviewSummary: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      status: { type: "string", enum: ["open", "completed", "cancelled"] },
      overdue: { type: "boolean" },
      scope,
      reviewers: { type: "array", items: reviewer },
      dueAt: timestamp,
      startedAt: timestamp,
      completedAt: nullableTimestamp,
      cancelledAt: nullableTimestamp,
      scheduleId: { type: ["integer", "null"] },
      createdBy: { type: ["integer", "null"] },
      counts: ref("AccessReviewCounts"),
    },
    required: ["id", "name", "status", "overdue", "scope", "reviewers", "dueAt", "startedAt", "counts"],
  },
  AccessReviewItem: {
    type: "object",
    properties: {
      id: { type: "integer" },
      campaignId: { type: "integer" },
      subjectUserId: { type: "integer" },
      subjectEmail: { type: "string" },
      subjectName: { type: ["string", "null"] },
      kind: { type: "string", enum: ["account", "role", "group", "api_token"] },
      targetId: { type: ["integer", "null"] },
      targetLabel: { type: "string" },
      decision: { type: ["string", "null"], enum: ["keep", "revoke", null] },
      comment: { type: ["string", "null"] },
      decidedBy: { type: ["integer", "null"] },
      decidedByEmail: { type: ["string", "null"] },
      decidedAt: nullableTimestamp,
      confirmedAt: nullableTimestamp,
      outcome: { type: ["string", "null"], enum: ["kept", "revoked", "unchanged", "failed", "not_reviewed", null] },
      outcomeDetail: { type: ["string", "null"] },
      overdue: { type: "boolean" },
    },
    required: ["id", "campaignId", "subjectUserId", "subjectEmail", "kind", "targetLabel", "decision", "outcome", "overdue"],
  },
  AccessReview: {
    allOf: [ref("AccessReviewSummary"), { type: "object", properties: { items: { type: "array", items: ref("AccessReviewItem") } }, required: ["items"] }],
  },
  AccessReviewRecord: {
    type: "object",
    properties: {
      generatedAt: timestamp,
      campaign: ref("AccessReviewSummary"),
      items: { type: "array", items: ref("AccessReviewItem") },
    },
    required: ["generatedAt", "campaign", "items"],
  },
  AccessReviewSchedule: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      enabled: { type: "boolean" },
      scope,
      reviewers: { type: "array", items: reviewer },
      durationDays: { type: "integer" },
      intervalMonths: { type: "integer" },
      nextRunAt: timestamp,
      lastRunAt: nullableTimestamp,
      lastCampaignId: { type: ["integer", "null"] },
      lastError: { type: ["string", "null"], description: "Why the last scheduled run could not start a campaign" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: ["id", "name", "enabled", "scope", "reviewers", "durationDays", "intervalMonths", "nextRunAt", "lastRunAt", "lastCampaignId", "lastError"],
  },
  AccessReviewScheduleInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 100 },
      enabled: { type: "boolean" },
      scope,
      reviewerIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50 },
      durationDays: { type: "integer", minimum: 1, maximum: 365, default: 14 },
      intervalMonths: { type: "integer", minimum: 1, maximum: 36, default: 3 },
      firstRunAt: { ...timestamp, description: "Create only; defaults to now" },
    },
  },
  AccessReviewAssignment: {
    type: "object",
    properties: {
      campaign: {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" }, dueAt: timestamp, overdue: { type: "boolean" } },
      },
      items: {
        type: "array",
        items: { allOf: [ref("AccessReviewItem"), { type: "object", properties: { ownAccess: { type: "boolean" } } }] },
      },
    },
    required: ["campaign", "items"],
  },
  AccessReviewDecisionInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      decision: { type: ["string", "null"], enum: ["keep", "revoke", null] },
      comment: { type: ["string", "null"], maxLength: 1000 },
    },
    required: ["decision"],
  },
  AccessReviewConfirmResult: {
    type: "object",
    properties: {
      confirmed: { type: "integer" },
      kept: { type: "integer" },
      revoked: { type: "integer" },
      unchanged: { type: "integer" },
      failed: { type: "integer" },
      campaignCompleted: { type: "boolean" },
    },
    required: ["confirmed", "kept", "revoked", "unchanged", "failed", "campaignCompleted"],
  },
};
