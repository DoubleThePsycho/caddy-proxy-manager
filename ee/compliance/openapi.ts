// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the compliance endpoints, spread into
 * app/api/v1/openapi.json/route.ts.
 */

const TAG = "Compliance";

export const COMPLIANCE_OPENAPI_TAG = {
  name: TAG,
  description:
    "Compliance reports (access review, change log, certificate inventory, protection coverage) mapped to NIS2 Article 21(2) and " +
    "ISO/IEC 27001:2022 Annex A, report schedules (evidence packs), live control status, recorded test restores, and the incident " +
    "register with NIS2 Article 23 significance assessments and notification drafts (Enterprise edition). Reports and control statuses " +
    "are evidence that can support those controls, not proof of compliance. Generating a report, setting up or changing a schedule, " +
    "recording a test restore and creating or drafting an incident need the compliance_reports feature; reading, downloading, disabling " +
    "and deleting never do. Nothing is ever sent to a CSIRT or authority.",
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
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};
const pageParams = [
  { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
  { name: "perPage", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
];
const LICENSED = "Permission compliance:write; needs the compliance_reports feature (403 otherwise).";

export const COMPLIANCE_OPENAPI_PATHS = {
  "/api/v1/compliance/controls/status": {
    get: {
      tags: [TAG],
      summary: "Get the live control status",
      description:
        "Six checks of this installation: TLS on every host, MFA for administrators, audit log integrity verified in the last 31 days, " +
        "a successful test restore in the last 90 days, access reviews completed and none overdue, and the WAF blocking on every enabled " +
        "proxy host. Each comes with what was checked, the evidence and its NIS2 and ISO/IEC 27001 references. Permission compliance:read; " +
        "available without a license.",
      operationId: "getComplianceControlStatus",
      responses: { "200": { description: "Control status", content: json(ref("ComplianceControlStatus")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/compliance/schedules": {
    get: {
      tags: [TAG],
      summary: "List report schedules",
      description: "With the next run, the period it covers and the reports of the last run. Permission compliance:read.",
      operationId: "listComplianceSchedules",
      responses: {
        "200": { description: "Schedules", content: json({ type: "object", properties: { schedules: { type: "array", items: ref("ComplianceSchedule") } } }) },
        ...errors("401", "403"),
      },
    },
    post: {
      tags: [TAG],
      summary: "Create a report schedule",
      description:
        `${LICENSED} Every week (the seven days before the run) or month (the previous calendar month), the chosen reports are ` +
        "generated, stored and hashed like reports made by hand, the audit log's hash chain is verified, and a notice with the findings and " +
        "SHA-256 digests goes to the chosen alert channels (not PagerDuty). Report contents are never sent. questionIds copies saved analytics " +
        "questions (GET /api/v1/analytics/questions/saved) into the schedule; each run then adds a traffic_questions report that re-runs them " +
        "for the period over every host, without asking an AI model.",
      operationId: "createComplianceSchedule",
      requestBody: { required: true, content: json(ref("ComplianceScheduleInput")) },
      responses: { "201": { description: "Created", content: json(ref("ComplianceSchedule")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/compliance/schedules/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a report schedule",
      operationId: "getComplianceSchedule",
      parameters: [idParam],
      responses: { "200": { description: "Schedule", content: json(ref("ComplianceSchedule")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Update a report schedule",
      description: `${LICENSED} Fields left out keep their values. {"enabled": false} works without a license.`,
      operationId: "updateComplianceSchedule",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("ComplianceScheduleInput")) },
      responses: { "200": { description: "Updated", content: json(ref("ComplianceSchedule")) }, ...errors("400", "401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a report schedule",
      description: "Permission compliance:write; works without a license. The reports it generated are kept.",
      operationId: "deleteComplianceSchedule",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/compliance/schedules/{id}/run": {
    post: {
      tags: [TAG],
      summary: "Run a report schedule now",
      description: `${LICENSED} Generates the schedule's reports for the week or month that has ended, as a scheduled run would.`,
      operationId: "runComplianceSchedule",
      parameters: [idParam],
      responses: { "200": { description: "The run", content: json(ref("ComplianceScheduleRun")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/compliance/packs": {
    get: {
      tags: [TAG],
      summary: "List evidence packs",
      description: "The reports of each scheduled run, newest first. Permission compliance:read.",
      operationId: "listComplianceEvidencePacks",
      parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 12 } }],
      responses: {
        "200": {
          description: "Evidence packs",
          content: json({
            type: "object",
            properties: {
              packs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    packId: { type: "string", format: "uuid" },
                    scheduleId: { type: ["integer", "null"] },
                    generatedAt: { type: "string", format: "date-time" },
                    reports: { type: "array", items: ref("ComplianceReportSummary") },
                  },
                },
              },
            },
          }),
        },
        ...errors("401", "403"),
      },
    },
  },
  "/api/v1/compliance/restore-tests": {
    get: {
      tags: [TAG],
      summary: "List recorded test restores",
      description: "Newest first. Permission compliance:read.",
      operationId: "listComplianceRestoreTests",
      parameters: pageParams,
      responses: {
        "200": {
          description: "Test restores",
          content: json({
            type: "object",
            properties: { tests: { type: "array", items: ref("ComplianceRestoreTest") }, total: { type: "integer" }, page: { type: "integer" }, perPage: { type: "integer" } },
          }),
        },
        ...errors("401", "403"),
      },
    },
    post: {
      tags: [TAG],
      summary: "Record a test restore",
      description: `${LICENSED} Records that a configuration backup was restored as a test (usually on a spare instance); evidence for the backup control.`,
      operationId: "recordComplianceRestoreTest",
      requestBody: { required: true, content: json(ref("ComplianceRestoreTestInput")) },
      responses: { "201": { description: "Recorded", content: json(ref("ComplianceRestoreTest")) }, ...errors("400", "401", "403") },
    },
  },
  "/api/v1/compliance/restore-tests/{id}": {
    delete: {
      tags: [TAG],
      summary: "Delete a recorded test restore",
      description: "Permission compliance:write; works without a license.",
      operationId: "deleteComplianceRestoreTest",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/compliance/controls": {
    get: {
      tags: [TAG],
      summary: "Get the control mapping",
      description: "Which NIS2 measures and ISO/IEC 27001:2022 Annex A controls each report and the incident drafts support. Permission compliance:read.",
      operationId: "getComplianceControls",
      responses: { "200": { description: "Control mapping", content: json(ref("ComplianceControlMapping")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/compliance/reports": {
    get: {
      tags: [TAG],
      summary: "List stored reports",
      description: "Newest first, without their content. Permission compliance:read; available without a license.",
      operationId: "listComplianceReports",
      parameters: [
        { name: "type", in: "query", schema: ref("ComplianceReportType") },
        { name: "packId", in: "query", schema: { type: "string", format: "uuid" }, description: "Only the reports of one scheduled run" },
        ...pageParams,
      ],
      responses: { "200": { description: "Reports", content: json(ref("ComplianceReportList")) }, ...errors("400", "401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Generate a report",
      description:
        `${LICENSED} Generates the report for the period, stores it with the SHA-256 of its canonical JSON (RFC 8785) and records ` +
        "the generation, with that SHA-256, in the audit log. `to` defaults to now and is capped at now, `from` to 30 days before `to`; " +
        "a bare date as `to` means the end of that day; the period spans at most 366 days. With format csv the answer is the report's " +
        "first table as CSV (other tables: GET /reports/{id}/export).",
      operationId: "generateComplianceReport",
      requestBody: { required: true, content: json(ref("ComplianceReportInput")) },
      responses: {
        "201": {
          description: "Generated and stored",
          headers: { Location: { schema: { type: "string" } } },
          content: { ...json(ref("ComplianceReportDetail")), "text/csv": { schema: { type: "string" } } },
        },
        ...errors("400", "401", "403"),
      },
    },
  },
  "/api/v1/compliance/reports/{id}": {
    get: {
      tags: [TAG],
      summary: "Get a stored report",
      description: "The report document with an integrity check: the stored content re-hashed and compared with the SHA-256 recorded in the audit log at generation.",
      operationId: "getComplianceReport",
      parameters: [idParam],
      responses: { "200": { description: "Report", content: json(ref("ComplianceReportDetail")) }, ...errors("401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a stored report",
      description: "Permission compliance:write; works without a license. The deletion is recorded in the audit log with the report's SHA-256.",
      operationId: "deleteComplianceReport",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/compliance/reports/{id}/export": {
    get: {
      tags: [TAG],
      summary: "Download a stored report",
      description:
        "format=json: the report with an `integrity` member (remove it, canonicalize with RFC 8785 and hash with SHA-256 to verify). " +
        "format=csv: one table, chosen with `section` (`summary`, `findings` or a section key of the report; default the first section). " +
        "Cells a spreadsheet would run as formulas are prefixed with an apostrophe. Headers X-Report-Id and X-Report-Sha256 carry the " +
        "report id and SHA-256. Available without a license.",
      operationId: "exportComplianceReport",
      parameters: [
        idParam,
        { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv"], default: "json" } },
        { name: "section", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Report file",
          content: { "application/json": { schema: ref("ComplianceReportDocument") }, "text/csv": { schema: { type: "string" } } },
        },
        ...errors("400", "401", "403", "404"),
      },
    },
  },
  "/api/v1/compliance/incidents": {
    get: {
      tags: [TAG],
      summary: "List the incident register",
      description:
        "Latest incident first, with its window, classification, whether a notification is required and the next stage due. " +
        "Permission compliance:read; available without a license.",
      operationId: "listComplianceIncidents",
      parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["open", "closed"] } }, ...pageParams],
      responses: { "200": { description: "Drafts", content: json(ref("ComplianceIncidentList")) }, ...errors("401", "403") },
    },
    post: {
      tags: [TAG],
      summary: "Record an incident",
      description:
        `${LICENSED} Records the incident in the register (window, significance assessment, classification, cause, timeline) and collects aggregated facts (WAF and traffic figures from ClickHouse, alert events, configuration changes) for the period ` +
        "and the affected hosts, and fills every stage from a structured template. Starting from an alert event (alertEventId) takes its " +
        "title and time unless given. `detectedAt` (when you became aware) defaults to the alert's time or now; the period defaults to the " +
        "24 hours before it up to now and spans at most 31 days. Nothing is sent anywhere.",
      operationId: "createComplianceIncident",
      requestBody: { required: true, content: json(ref("ComplianceIncidentInput")) },
      responses: {
        "201": { description: "Created", headers: { Location: { schema: { type: "string" } } }, content: json(ref("ComplianceIncident")) },
        ...errors("400", "401", "403"),
      },
    },
  },
  "/api/v1/compliance/incidents/{id}": {
    get: {
      tags: [TAG],
      summary: "Get an incident notification draft",
      description: "With each stage's deadline: early warning 24 hours and incident notification 72 hours after detectedAt, final report one month after the incident notification was submitted (until then, after its 72-hour deadline).",
      operationId: "getComplianceIncident",
      parameters: [idParam],
      responses: { "200": { description: "Draft", content: json(ref("ComplianceIncident")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: "Update an incident",
      description:
        "Permission compliance:write; works without a license, so an incident under way stays editable. Fields left out keep their values. " +
        "Changing the period or the hosts collects the facts again. Changing a stage's text records editedAt (an AI-generated draft keeps its " +
        "label). Record a submission you made with stages.<stage>.submittedAt and reference. Setting classification records who classified it " +
        "and when; status closed records closedAt. Assessment answers for suspected malicious acts and cross-border impact fill the early " +
        "warning's choices while they are unknown.",
      operationId: "updateComplianceIncident",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("ComplianceIncidentUpdate")) },
      responses: { "200": { description: "Updated", content: json(ref("ComplianceIncident")) }, ...errors("400", "401", "403", "404") },
    },
    delete: {
      tags: [TAG],
      summary: "Delete an incident notification draft",
      description: "Permission compliance:write; works without a license.",
      operationId: "deleteComplianceIncident",
      parameters: [idParam],
      responses: { "204": { description: "Deleted" }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/compliance/incidents/{id}/facts": {
    post: {
      tags: [TAG],
      summary: "Collect the draft's facts again",
      description: `${LICENSED} The stages' text is not changed.`,
      operationId: "refreshComplianceIncidentFacts",
      parameters: [idParam],
      responses: { "200": { description: "Updated", content: json(ref("ComplianceIncident")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/v1/compliance/incidents/{id}/draft": {
    post: {
      tags: [TAG],
      summary: "Fill a stage from the template or with AI",
      description:
        `${LICENSED} source template: the structured template from the facts. source ai: a first draft from the configured AI provider ` +
        "(your own model, see the AI tag); the model gets the aggregated facts only, as untrusted data, and no tools. The stage is marked " +
        "as AI-generated until replaced; a person must review, edit and submit it. Choice fields and the submission record are kept. " +
        "400 when no AI provider is configured, 502 when the provider fails.",
      operationId: "draftComplianceIncidentStage",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("ComplianceIncidentDraftInput")) },
      responses: {
        "200": { description: "Updated", content: json(ref("ComplianceIncident")) },
        "502": { description: "The AI provider failed", content: json({ $ref: "#/components/schemas/Error" }) },
        ...errors("400", "401", "403", "404"),
      },
    },
  },
};

const cell = { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }, { type: "array", items: { type: "string" } }] };
const counts = {
  type: "object",
  properties: { high: { type: "integer" }, medium: { type: "integer" }, low: { type: "integer" }, info: { type: "integer" } },
  required: ["high", "medium", "low", "info"],
};
const control = {
  type: "object",
  properties: {
    framework: { type: "string", enum: ["NIS2", "ISO/IEC 27001:2022"] },
    ref: { type: "string", example: "A.5.15" },
    title: { type: "string" },
    how: { type: "string", description: "How the report supports the control" },
  },
  required: ["framework", "ref", "title", "how"],
};
const stageKey = { type: "string", enum: ["early_warning", "notification", "final_report"] };
const stageInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    fields: {
      type: "object",
      additionalProperties: { type: "string", maxLength: 8000 },
      description:
        "early_warning: summary, suspectedMalicious (unknown|yes|no), crossBorderImpact (unknown|yes|no), actionsTaken; " +
        "notification: update, assessment, indicatorsOfCompromise, mitigation; final_report: description, rootCause, mitigation, crossBorderImpact",
    },
    submittedAt: { type: ["string", "null"], format: "date-time", description: "When you submitted this stage to the CSIRT or authority" },
    reference: { type: ["string", "null"], maxLength: 200, description: "The CSIRT's or authority's reference" },
  },
};

export const COMPLIANCE_OPENAPI_SCHEMAS = {
  ComplianceReportType: {
    type: "string",
    enum: ["access_review", "change_log", "certificate_inventory", "protection_coverage", "traffic_questions"],
    description: "traffic_questions reports come only from report schedules with saved analytics questions",
  },
  ComplianceSelectableReportType: { type: "string", enum: ["access_review", "change_log", "certificate_inventory", "protection_coverage"] },
  ComplianceReportInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: ref("ComplianceSelectableReportType"),
      from: { type: "string", description: "ISO 8601 date or date-time with a zone" },
      to: { type: "string", description: "ISO 8601 date (end of that day) or date-time with a zone; capped at now" },
      format: { type: "string", enum: ["json", "csv"], default: "json" },
    },
    required: ["type"],
  },
  ComplianceReportSummary: {
    type: "object",
    properties: {
      id: { type: "integer" },
      reportId: { type: "string", format: "uuid" },
      type: ref("ComplianceReportType"),
      title: { type: "string" },
      period: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } },
      generatedAt: { type: "string", format: "date-time" },
      generatedBy: { type: "object", properties: { userId: { type: ["integer", "null"] }, name: { type: ["string", "null"] } } },
      sha256: { type: "string", description: "SHA-256 of the report's canonical JSON" },
      findings: counts,
      sizeBytes: { type: "integer" },
      scheduleId: { type: ["integer", "null"], description: "The schedule that generated it; null when generated by hand" },
      packId: { type: ["string", "null"], description: "The scheduled run (evidence pack) it belongs to" },
    },
    required: ["id", "reportId", "type", "title", "period", "generatedAt", "generatedBy", "sha256", "findings", "sizeBytes"],
  },
  ComplianceReportList: {
    type: "object",
    properties: {
      reports: { type: "array", items: ref("ComplianceReportSummary") },
      total: { type: "integer" },
      page: { type: "integer" },
      perPage: { type: "integer" },
    },
    required: ["reports", "total", "page", "perPage"],
  },
  ComplianceReportDocument: {
    type: "object",
    description: "The report as hashed. Exports add an `integrity` member {algorithm, canonicalization, sha256}.",
    properties: {
      format: { type: "string", enum: ["compliance-report"] },
      formatVersion: { type: "integer", enum: [1] },
      reportId: { type: "string", format: "uuid" },
      type: ref("ComplianceReportType"),
      title: { type: "string" },
      period: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
      generatedAt: { type: "string", format: "date-time" },
      generatedBy: { type: "object", properties: { userId: { type: "integer" }, name: { type: ["string", "null"] }, email: { type: ["string", "null"] } } },
      product: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } } },
      instanceMode: { type: "string" },
      statement: { type: "string" },
      controls: { type: "array", items: control },
      summary: {
        type: "array",
        items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, value: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] } } },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["high", "medium", "low", "info"] },
            code: { type: "string" },
            subject: { type: "string" },
            message: { type: "string" },
          },
        },
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            title: { type: "string" },
            description: { type: ["string", "null"] },
            columns: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" } } } },
            rows: { type: "array", items: { type: "object", additionalProperties: cell } },
            truncated: { type: ["object", "null"], properties: { shown: { type: "integer" }, total: { type: "integer" } } },
          },
        },
      },
      notes: { type: "array", items: { type: "string" } },
    },
  },
  ComplianceReportDetail: {
    allOf: [
      ref("ComplianceReportSummary"),
      {
        type: "object",
        properties: {
          document: ref("ComplianceReportDocument"),
          integrity: {
            type: "object",
            properties: {
              algorithm: { type: "string", enum: ["SHA-256"] },
              canonicalization: { type: "string" },
              sha256: { type: "string" },
              contentMatches: { type: "boolean", description: "The stored content still hashes to the stored SHA-256" },
              auditEvent: {
                type: ["object", "null"],
                properties: { id: { type: "integer" }, recordedAt: { type: "string" }, sha256Matches: { type: "boolean" } },
              },
            },
          },
        },
      },
    ],
  },
  ComplianceControlMapping: {
    type: "object",
    properties: {
      statement: { type: "string" },
      nis2Measures: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, title: { type: "string" } } } },
      iso27001Controls: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, title: { type: "string" } } } },
      mapping: { type: "object", additionalProperties: { type: "array", items: control } },
    },
  },
  ComplianceIncidentInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 200, description: "Required unless alertEventId is given" },
      detectedAt: { type: "string", format: "date-time", description: "When you became aware of the incident; the deadlines run from here" },
      from: { type: "string" },
      to: { type: "string" },
      alertEventId: { type: ["integer", "null"] },
      proxyHostIds: { type: "array", items: { type: "integer" }, maxItems: 50, description: "Affected hosts; empty means every host" },
      language: { type: "string", enum: ["en", "it"], default: "en", description: "Language of the template and AI drafts" },
      startedAt: { type: ["string", "null"], format: "date-time", description: "When the incident started" },
      endedAt: { type: ["string", "null"], format: "date-time", description: "When it ended; not before startedAt" },
      classification: { type: "string", enum: ["undetermined", "not_significant", "significant"], description: "A person's decision under NIS2 Art. 23(3)" },
      assessment: ref("ComplianceIncidentAssessmentInput"),
      cause: { type: ["string", "null"], maxLength: 8000 },
      timeline: {
        type: "array",
        maxItems: 100,
        description: "Entries a person adds (replaces the stored ones); entries with source facts are ignored",
        items: { type: "object", properties: { at: { type: "string", format: "date-time" }, text: { type: "string", maxLength: 500 } }, required: ["at", "text"] },
      },
    },
  },
  ComplianceIncidentUpdate: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 200 },
      status: { type: "string", enum: ["open", "closed"] },
      language: { type: "string", enum: ["en", "it"] },
      detectedAt: { type: "string", format: "date-time" },
      from: { type: "string" },
      to: { type: "string" },
      proxyHostIds: { type: "array", items: { type: "integer" } },
      stages: {
        type: "object",
        additionalProperties: false,
        properties: { early_warning: stageInput, notification: stageInput, final_report: stageInput },
      },
      startedAt: { type: ["string", "null"], format: "date-time", description: "When the incident started" },
      endedAt: { type: ["string", "null"], format: "date-time", description: "When it ended; not before startedAt" },
      classification: { type: "string", enum: ["undetermined", "not_significant", "significant"], description: "A person's decision under NIS2 Art. 23(3)" },
      assessment: ref("ComplianceIncidentAssessmentInput"),
      cause: { type: ["string", "null"], maxLength: 8000 },
      timeline: {
        type: "array",
        maxItems: 100,
        description: "Entries a person adds (replaces the stored ones); entries with source facts are ignored",
        items: { type: "object", properties: { at: { type: "string", format: "date-time" }, text: { type: "string", maxLength: 500 } }, required: ["at", "text"] },
      },
    },
  },
  ComplianceIncidentDraftInput: {
    type: "object",
    additionalProperties: false,
    properties: { stage: stageKey, source: { type: "string", enum: ["template", "ai"], default: "template" } },
    required: ["stage"],
  },
  ComplianceIncidentStage: {
    type: "object",
    properties: {
      key: stageKey,
      label: { type: "string" },
      legalBasis: { type: "string", example: "NIS2 Art. 23(4)(a)" },
      deadline: { type: "string", format: "date-time" },
      deadlineRule: { type: "string" },
      status: { type: "string", enum: ["open", "overdue", "submitted"] },
      fields: { type: "object", additionalProperties: { type: "string" } },
      ai: {
        type: ["object", "null"],
        description: "Set while the stage's text is an AI-generated first draft",
        properties: { generatedAt: { type: "string" }, provider: { type: "string" }, model: { type: "string" } },
      },
      editedAt: { type: ["string", "null"] },
      submittedAt: { type: ["string", "null"] },
      reference: { type: ["string", "null"] },
    },
  },
  ComplianceIncident: {
    type: "object",
    properties: {
      id: { type: "integer" },
      title: { type: "string" },
      status: { type: "string", enum: ["open", "closed"] },
      language: { type: "string", enum: ["en", "it"] },
      detectedAt: { type: "string", format: "date-time" },
      period: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
      alertEventId: { type: ["integer", "null"] },
      proxyHosts: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } },
      facts: { type: ["object", "null"], description: "Aggregated figures: traffic, WAF, alerts, configuration changes" },
      factsCollectedAt: { type: ["string", "null"] },
      stages: { type: "array", items: ref("ComplianceIncidentStage") },
      createdAt: { type: "string" },
      createdBy: { type: "object", properties: { userId: { type: ["integer", "null"] }, name: { type: ["string", "null"] } } },
      updatedAt: { type: "string" },
      startedAt: { type: ["string", "null"] },
      endedAt: { type: ["string", "null"] },
      classification: { type: "string", enum: ["undetermined", "not_significant", "significant"] },
      classifiedAt: { type: ["string", "null"] },
      classifiedBy: { type: ["object", "null"], properties: { userId: { type: ["integer", "null"] }, name: { type: ["string", "null"] } } },
      assessment: ref("ComplianceIncidentAssessment"),
      suggestedClassification: { type: "string", enum: ["undetermined", "not_significant", "significant"], description: "What the answers suggest" },
      cause: { type: ["string", "null"] },
      timeline: {
        type: "array",
        items: { type: "object", properties: { at: { type: "string" }, text: { type: "string" }, source: { type: "string", enum: ["person", "facts"] } } },
      },
      closedAt: { type: ["string", "null"] },
      notification: { type: "string", enum: ["undetermined", "not_required", "required", "submitted"] },
    },
  },
  ComplianceIncidentAssessment: {
    type: "object",
    description:
      "NIS2 Art. 23(3): severeDisruption and considerableDamage decide significance; suspectedMalicious and crossBorderImpact go into the early warning (Art. 23(4)(a)).",
    properties: Object.fromEntries(
      ["severeDisruption", "considerableDamage", "suspectedMalicious", "crossBorderImpact"].map((key) => [
        key,
        { type: "object", properties: { answer: { type: "string", enum: ["unknown", "yes", "no"] }, reason: { type: "string" } } },
      ])
    ),
  },
  ComplianceIncidentAssessmentInput: {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      ["severeDisruption", "considerableDamage", "suspectedMalicious", "crossBorderImpact"].map((key) => [
        key,
        {
          type: "object",
          additionalProperties: false,
          properties: { answer: { type: "string", enum: ["unknown", "yes", "no"] }, reason: { type: ["string", "null"], maxLength: 1000 } },
        },
      ])
    ),
  },
  ComplianceControlStatus: {
    type: "object",
    properties: {
      checkedAt: { type: "string", format: "date-time" },
      counts: { type: "object", properties: { met: { type: "integer" }, attention: { type: "integer" }, not_met: { type: "integer" }, unknown: { type: "integer" } } },
      statement: { type: "string" },
      controls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: ["tls", "mfa_admins", "audit_chain", "backup_restore", "access_reviews", "waf_blocking"] },
            title: { type: "string" },
            status: { type: "string", enum: ["met", "attention", "not_met", "unknown"] },
            statusLabel: { type: "string", example: "Due in 3 days" },
            checked: { type: "string", description: "What was checked and found" },
            evidence: {
              type: "array",
              items: { type: "object", properties: { label: { type: "string" }, route: { type: "string" }, kind: { type: "string", enum: ["report", "page", "record"] } } },
            },
            references: {
              type: "object",
              properties: {
                nis2: { type: "object", properties: { ref: { type: "string" }, title: { type: "string" } } },
                iso27001: { type: "object", properties: { ref: { type: "string" }, title: { type: "string" } } },
              },
            },
            facts: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  },
  ComplianceScheduleInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 100 },
      enabled: { type: "boolean", default: true },
      frequency: { type: "string", enum: ["weekly", "monthly"], default: "monthly" },
      weekday: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], description: "Weekly schedules" },
      dayOfMonth: { type: "integer", minimum: 1, maximum: 28, description: "Monthly schedules" },
      time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", default: "06:00" },
      timeZone: { type: "string", default: "UTC" },
      reportTypes: {
        type: "array",
        items: ref("ComplianceSelectableReportType"),
        description: "The reports of each run; may be empty when questionIds is not",
      },
      questionIds: {
        type: "array",
        items: { type: "integer" },
        maxItems: 10,
        description:
          "Saved analytics questions to copy into the schedule (your own and the shared ones you can see). Each run adds a traffic_questions report " +
          "that re-runs them for the period. Ids already in the schedule keep their copy when the saved question has been deleted since.",
      },
      channelIds: { type: "array", items: { type: "integer" }, maxItems: 20, description: "Alert channels for the notice (not PagerDuty)" },
    },
  },
  ComplianceSchedule: {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      enabled: { type: "boolean" },
      frequency: { type: "string", enum: ["weekly", "monthly"] },
      weekday: { type: ["string", "null"] },
      dayOfMonth: { type: ["integer", "null"] },
      time: { type: "string" },
      timeZone: { type: "string" },
      reportTypes: { type: "array", items: ref("ComplianceSelectableReportType") },
      questions: {
        type: "array",
        description: "Saved analytics questions copied into the schedule",
        items: {
          type: "object",
          properties: {
            savedQuestionId: { type: ["integer", "null"], description: "The saved question it was copied from (it may have been deleted since)" },
            question: { type: "string" },
            interpretation: { type: "string", description: "The query in words, with its own range; each run uses the report's period" },
          },
        },
      },
      channelIds: { type: "array", items: { type: "integer" } },
      nextRunAt: { type: ["string", "null"], format: "date-time" },
      nextPeriod: { type: ["object", "null"], properties: { from: { type: "string" }, to: { type: "string" } } },
      lastRunAt: { type: ["string", "null"] },
      lastStatus: { type: ["string", "null"], enum: ["success", "partial", "failed", null] },
      lastError: { type: ["string", "null"] },
      lastPackId: { type: ["string", "null"] },
      lastDeliveries: {
        type: "array",
        items: { type: "object", properties: { channelId: { type: "integer" }, channelName: { type: "string" }, ok: { type: "boolean" }, error: { type: ["string", "null"] } } },
      },
      lastReports: { type: "array", items: ref("ComplianceReportSummary") },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
  },
  ComplianceScheduleRun: {
    type: "object",
    properties: {
      packId: { type: "string", format: "uuid" },
      period: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
      status: { type: "string", enum: ["success", "partial", "failed"] },
      reports: { type: "array", items: ref("ComplianceReportSummary") },
      failed: { type: "array", items: { type: "object", properties: { type: ref("ComplianceReportType"), error: { type: "string" } } } },
      chain: { type: ["object", "null"], properties: { ok: { type: "boolean" }, checked: { type: "integer" } } },
      deliveries: { type: "array", items: { type: "object", properties: { channelId: { type: "integer" }, ok: { type: "boolean" }, error: { type: ["string", "null"] } } } },
    },
  },
  ComplianceRestoreTestInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      testedAt: { type: "string", format: "date-time" },
      source: { type: "string", enum: ["backup", "snapshot", "export", "other"] },
      outcome: { type: "string", enum: ["success", "partial", "failed"] },
      backupDestinationId: { type: ["integer", "null"] },
      backupObjectKey: { type: ["string", "null"], maxLength: 512 },
      notes: { type: ["string", "null"], maxLength: 2000 },
    },
    required: ["testedAt", "source", "outcome"],
  },
  ComplianceRestoreTest: {
    type: "object",
    properties: {
      id: { type: "integer" },
      testedAt: { type: "string" },
      source: { type: "string", enum: ["backup", "snapshot", "export", "other"] },
      backupDestination: { type: ["object", "null"], properties: { id: { type: "integer" }, name: { type: ["string", "null"] } } },
      backupObjectKey: { type: ["string", "null"] },
      outcome: { type: "string", enum: ["success", "partial", "failed"] },
      notes: { type: ["string", "null"] },
      recordedBy: { type: "object", properties: { userId: { type: ["integer", "null"] }, name: { type: ["string", "null"] } } },
      createdAt: { type: "string" },
    },
  },
  ComplianceIncidentList: {
    type: "object",
    properties: {
      incidents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            title: { type: "string" },
            status: { type: "string" },
            detectedAt: { type: "string" },
            nextDeadline: {
              type: ["object", "null"],
              properties: { stage: stageKey, label: { type: "string" }, at: { type: "string" }, overdue: { type: "boolean" } },
            },
            submittedStages: { type: "integer" },
            createdAt: { type: "string" },
            createdBy: { type: "object", properties: { userId: { type: ["integer", "null"] }, name: { type: ["string", "null"] } } },
            startedAt: { type: ["string", "null"] },
            endedAt: { type: ["string", "null"] },
            proxyHostCount: { type: "integer" },
            classification: { type: "string", enum: ["undetermined", "not_significant", "significant"] },
            notification: { type: "string", enum: ["undetermined", "not_required", "required", "submitted"] },
            closedAt: { type: ["string", "null"] },
          },
        },
      },
      total: { type: "integer" },
      page: { type: "integer" },
      perPage: { type: "integer" },
    },
  },
};
