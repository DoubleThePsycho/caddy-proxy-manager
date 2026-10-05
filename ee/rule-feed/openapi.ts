// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the virtual patching endpoints (rule feed and
 * virtual patches), spread into app/api/v1/openapi.json/route.ts.
 */
import { VIRTUAL_PATCH_RULE_ID_MAX, VIRTUAL_PATCH_RULE_ID_MIN } from "@/src/lib/waf-exclusions";
import { isFeatureAvailable } from "@/ee/licensing/features";
import { DEFAULT_RULE_FEED_URL, PACK_SEVERITIES, RULE_FEED_LIMITS, VIRTUAL_PATCH_MODES, VIRTUAL_PATCHING_FEATURE } from "./types";

const TAG = "Virtual patching";

/** Virtual patching is coming soon in this release (ee/licensing/features.ts). */
const COMING_SOON = !isFeatureAvailable(VIRTUAL_PATCHING_FEATURE);
const soon = (summary: string) => (COMING_SOON ? `${summary} (coming soon)` : summary);

export const VIRTUAL_PATCHING_OPENAPI_TAG = {
  name: TAG,
  description:
    (COMING_SOON
      ? "Coming soon: virtual patching is not available in this release. Subscribing, changing the feed URL, turning on automatic " +
        "blocking, fetching, importing and turning a patch on answer 403 with any license, and no feed is fetched on a schedule; " +
        "reading, unsubscribing, turning automatic blocking off and turning patches off work. "
      : "") +
    "WAF rules for newly published CVEs from a signed rule feed (Enterprise edition, feature virtual_patching). The feed is fetched daily " +
    "from an https URL or imported as a file, and installed only when its Ed25519 signature matches a key this build trusts, it has not " +
    "expired, its sequence is higher than the installed one and every rule passes the SecLang allowlist; otherwise nothing changes. Each " +
    "patch is off, detect (logs matching requests) or block (403). New patches start in detect. Subscribing, changing the feed URL, " +
    "turning on automatic blocking, fetching on demand, importing and turning a patch on need the license; unsubscribing, turning a patch " +
    "off, reading, the daily fetch of an existing subscription and the patches in the Caddy configuration never do. A sync replica applies " +
    "its master's patches and refuses changes (409).",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
    "409": { $ref: "#/components/responses/Conflict" },
    "502": {
      description: "The feed URL could not be reached or served a feed that was refused, or Caddy did not accept the patches; nothing changed",
      content: json(ref("Error")),
    },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,63}$" }, description: "Pack id, e.g. ivp-2021-44228." };

export const VIRTUAL_PATCHING_OPENAPI_PATHS = {
  "/api/v1/waf/rule-feed": {
    get: {
      tags: [TAG],
      summary: soon("Get the rule feed subscription and status"),
      description: "Permission virtual_patches:read. Available without a license.",
      operationId: "getRuleFeed",
      responses: { "200": { description: "Subscription and feed status", content: json(ref("RuleFeedStatus")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: soon("Subscribe to the rule feed or change the subscription"),
      description:
        "Permission virtual_patches:write. Fields left out keep their value. Subscribing, changing feedUrl (https only, no credentials) and " +
        "turning autoBlockCritical on need the virtual_patching feature (403 otherwise); unsubscribing and turning automatic blocking off do " +
        "not. Saving does not fetch: use POST /api/v1/waf/rule-feed/fetch.",
      operationId: "updateRuleFeed",
      requestBody: { required: true, content: json(ref("RuleFeedSubscriptionInput")) },
      responses: { "200": { description: "Saved", content: json(ref("RuleFeedStatus")) }, ...errors("400", "401", "403", "409") },
    },
  },
  "/api/v1/waf/rule-feed/fetch": {
    post: {
      tags: [TAG],
      summary: soon("Fetch the rule feed now"),
      description:
        "Permission virtual_patches:write; needs the virtual_patching feature. Downloads the feed from the configured URL (redirects are not " +
        `followed, at most ${RULE_FEED_LIMITS.feedBytes / (1024 * 1024)} MiB), verifies it and installs its packs; the Caddy configuration ` +
        "is applied when anything changed. A refused feed changes nothing (502, the reason in error).",
      operationId: "fetchRuleFeed",
      responses: { "200": { description: "Fetched", content: json(ref("RuleFeedRunResult")) }, ...errors("401", "403", "409", "502") },
    },
  },
  "/api/v1/waf/rule-feed/import": {
    post: {
      tags: [TAG],
      summary: soon("Import a rule feed file"),
      description:
        "Permission virtual_patches:write; needs the virtual_patching feature. The body is the feed file exactly as published " +
        "({v, payload, signature}), for installs without internet access. It is verified like a fetched feed: signature, expiry, " +
        "sequence (never lower than the installed one) and the SecLang allowlist. A refused feed changes nothing (400, the reason in error).",
      operationId: "importRuleFeed",
      requestBody: { required: true, content: json(ref("RuleFeedDocument")) },
      responses: { "200": { description: "Imported", content: json(ref("RuleFeedRunResult")) }, ...errors("400", "401", "403", "409", "502") },
    },
  },
  "/api/v1/waf/virtual-patches": {
    get: {
      tags: [TAG],
      summary: soon("List virtual patches"),
      description: "Permission virtual_patches:read. Available without a license. On a replica, only the master's patches that are on.",
      operationId: "listVirtualPatches",
      responses: {
        "200": {
          description: "Virtual patches",
          content: json({
            type: "object",
            properties: {
              patches: { type: "array", items: ref("VirtualPatch") },
              counts: ref("VirtualPatchCounts"),
              source: { type: "string", enum: ["local", "master"] },
            },
          }),
        },
        ...errors("401", "403"),
      },
    },
  },
  "/api/v1/waf/virtual-patches/{id}": {
    get: {
      tags: [TAG],
      summary: soon("Get a virtual patch"),
      description: "Permission virtual_patches:read.",
      operationId: "getVirtualPatch",
      parameters: [idParam],
      responses: { "200": { description: "Virtual patch", content: json(ref("VirtualPatch")) }, ...errors("401", "403", "404") },
    },
    put: {
      tags: [TAG],
      summary: soon("Set a virtual patch's mode"),
      description:
        "Permission virtual_patches:write. detect logs matching requests as WAF events, block answers them with 403 (on hosts whose WAF " +
        "blocks; hosts in detection only log). Turning a patch on (detect or block) needs the virtual_patching feature; off never does. " +
        "The Caddy configuration is applied at once; when Caddy refuses it the previous mode is put back (502).",
      operationId: "setVirtualPatchMode",
      parameters: [idParam],
      requestBody: { required: true, content: json(ref("VirtualPatchModeInput")) },
      responses: { "200": { description: "Saved and applied", content: json(ref("VirtualPatch")) }, ...errors("400", "401", "403", "404", "409", "502") },
    },
  },
};

const sample = {
  type: "object",
  properties: {
    method: { type: "string" },
    path: { type: "string", description: "Path and query string as sent." },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: { type: "string" },
  },
};

export const VIRTUAL_PATCHING_OPENAPI_SCHEMAS = {
  RuleFeedSettings: {
    type: "object",
    properties: {
      subscribed: { type: "boolean", description: "Fetch the feed every day." },
      feedUrl: { type: "string", format: "uri", default: DEFAULT_RULE_FEED_URL },
      autoBlockCritical: {
        type: "boolean",
        description: "New critical patches that the publisher recommends blocking start in block mode instead of detect.",
      },
    },
  },
  RuleFeedSubscriptionInput: {
    type: "object",
    properties: {
      subscribed: { type: "boolean" },
      feedUrl: { type: "string", format: "uri", maxLength: RULE_FEED_LIMITS.feedUrlLength, description: "https:// only, without credentials or fragment." },
      autoBlockCritical: { type: "boolean" },
    },
    additionalProperties: false,
  },
  RuleFeedStatus: {
    type: "object",
    properties: {
      settings: ref("RuleFeedSettings"),
      feed: {
        type: "object",
        properties: {
          installed: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kid: { type: "string", description: "The signing key." },
                  sequence: { type: "integer" },
                  digest: { type: "string", description: "SHA-256 of the signed payload." },
                  issuedAt: { type: "string", format: "date-time" },
                  expiresAt: { type: "string", format: "date-time" },
                  source: { type: "string", enum: ["fetch", "import"] },
                  installedAt: { type: "string", format: "date-time" },
                  packs: { type: "integer" },
                },
              },
              { type: "null" },
            ],
          },
          expired: { type: "boolean", description: "Past its expiry: its patches keep applying, but no newer feed was installed." },
          lastCheck: {
            oneOf: [
              {
                type: "object",
                properties: {
                  at: { type: "string", format: "date-time" },
                  source: { type: "string", enum: ["fetch", "import"] },
                  outcome: { type: "string", enum: ["updated", "unchanged", "failed"] },
                  error: { type: ["string", "null"] },
                  sequence: { type: ["integer", "null"] },
                  added: { type: "integer" },
                  updated: { type: "integer" },
                  withdrawn: { type: "integer" },
                },
              },
              { type: "null" },
            ],
          },
          trustedKeyIds: { type: "array", items: { type: "string" }, description: "Signing keys this build trusts." },
        },
      },
      counts: ref("VirtualPatchCounts"),
      available: { type: "boolean", description: "Virtual patching ships in this release; false while it is coming soon." },
      configurable: { type: "boolean", description: "Available, and the license lets administrators subscribe, import and turn patches on." },
      editable: { type: "boolean", description: "False on a sync replica." },
      source: { type: "string", enum: ["local", "master"] },
    },
  },
  RuleFeedDocument: {
    type: "object",
    required: ["v", "payload", "signature"],
    properties: {
      v: { type: "integer", enum: [1] },
      payload: { type: "string", description: "base64url of the payload JSON {v, kid, sequence, issuedAt, expiresAt, packs}." },
      signature: { type: "string", description: 'base64url Ed25519 signature over "ingressi-rule-feed:v1." followed by payload.' },
    },
  },
  RuleFeedRunResult: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["updated", "unchanged"], description: "unchanged: this feed is already installed." },
      sequence: { type: "integer" },
      added: { type: "array", items: { type: "string" } },
      updated: { type: "array", items: { type: "string" } },
      withdrawn: { type: "array", items: { type: "string" }, description: "No longer in the feed; they keep their mode." },
      autoBlocked: { type: "array", items: { type: "string" }, description: "New patches that started in block mode." },
    },
  },
  VirtualPatchCounts: {
    type: "object",
    properties: {
      total: { type: "integer" },
      detect: { type: "integer" },
      block: { type: "integer" },
      off: { type: "integer" },
      withdrawn: { type: "integer" },
    },
  },
  VirtualPatch: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      cves: { type: "array", items: { type: "string", pattern: "^CVE-\\d{4}-\\d{4,7}$" } },
      severity: { type: "string", enum: [...PACK_SEVERITIES] },
      affected: {
        type: "array",
        items: { type: "object", properties: { product: { type: "string" }, versions: { type: "string" }, fixed: { type: "string" } } },
      },
      references: { type: "array", items: { type: "string", format: "uri" } },
      publishedAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      defaultMode: { type: "string", enum: [...VIRTUAL_PATCH_MODES], description: "The publisher's recommendation." },
      mode: { type: "string", enum: [...VIRTUAL_PATCH_MODES] },
      modeChangedAt: { type: ["string", "null"], format: "date-time" },
      ruleIds: {
        type: "array",
        items: { type: "integer", minimum: VIRTUAL_PATCH_RULE_ID_MIN, maximum: VIRTUAL_PATCH_RULE_ID_MAX },
        description: "The WAF rule ids its events carry.",
      },
      rules: { type: "array", items: { type: "string" }, description: "The SecRule lines as published." },
      samples: {
        type: "object",
        properties: { positive: { type: "array", items: sample }, negative: { type: "array", items: sample } },
        description: "Requests it matches (positive) and lets through (negative).",
      },
      example: { type: "boolean", description: "An example of the format, not a production patch." },
      inspectsBody: { type: "boolean", description: "Reads request bodies, which needs the Core Rule Set or SecRequestBodyAccess On." },
      withdrawnAt: { type: ["string", "null"], format: "date-time", description: "No longer in the feed; it keeps its mode until turned off." },
      firstSeenAt: { type: "string", format: "date-time" },
      feedSequence: { type: ["integer", "null"] },
    },
  },
  VirtualPatchModeInput: {
    type: "object",
    required: ["mode"],
    properties: { mode: { type: "string", enum: [...VIRTUAL_PATCH_MODES] } },
    additionalProperties: false,
  },
};
