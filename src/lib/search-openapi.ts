/**
 * OpenAPI path and schemas of the dashboard search (GET /api/v1/search),
 * spread into app/api/v1/openapi.json/route.ts. Enumerations come from
 * search-results.ts, so they cannot drift from what the endpoint returns.
 */
import { MAX_SEARCH_QUERY_LENGTH, SEARCH_GROUPS, SEARCH_LIMITS, SEARCH_RESULT_KINDS, SEARCH_RUN_ACTIONS } from "./search-results";

const TAG = "Search";

export const SEARCH_OPENAPI_TAG = {
  name: TAG,
  description: "Search across hosts, certificates, users, actions, pages, settings and documentation (the dashboard's command palette)",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const SEARCH_OPENAPI_PATHS = {
  "/api/v1/search": {
    get: {
      tags: [TAG],
      summary: "Search the dashboard",
      description:
        "Any signed-in user or API token; no single permission. Each group of results is limited to what the caller's role " +
        "can read: proxy hosts need proxy_hosts:read, L4 hosts l4_proxy_hosts:read, certificates certificates:read and " +
        "users users:read (hosts and certificates follow the role's tag scope; organisation users only get their " +
        "organisation's rows); actions need the write permission of the page they open; pages the permission of their " +
        "page guard; settings sections settings:read plus the section's own permission. The query is matched literally " +
        `and case-insensitively, and cut to ${MAX_SEARCH_QUERY_LENGTH} characters. Up to ${SEARCH_LIMITS.proxyHosts} proxy hosts, ` +
        `${SEARCH_LIMITS.l4Hosts} L4 hosts and ${SEARCH_LIMITS.certificates} results of each other group. An empty query ` +
        "returns suggestions: common actions and pages. User results carry only the name and e-mail address.",
      operationId: "searchDashboard",
      parameters: [
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: MAX_SEARCH_QUERY_LENGTH },
          description: "The text to look for. Empty or missing: suggestions.",
        },
      ],
      responses: {
        "200": { description: "Results, in the order the palette shows them", content: { "application/json": { schema: ref("SearchResponse") } } },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
};

export const SEARCH_OPENAPI_SCHEMAS = {
  SearchResponse: {
    type: "object",
    properties: {
      query: { type: "string", description: "The query as searched: trimmed, spaces collapsed, cut to the maximum length" },
      results: { type: "array", items: ref("SearchResult") },
    },
    required: ["query", "results"],
  },
  SearchResult: {
    type: "object",
    properties: {
      group: { type: "string", enum: SEARCH_GROUPS.filter((group) => group !== "recent") },
      kind: { type: "string", enum: [...SEARCH_RESULT_KINDS] },
      id: { type: "string", description: "Stable identifier, such as proxy_host:12 or setting:geoblock" },
      title: { type: "string" },
      subtitle: { type: ["string", "null"] },
      href: { type: "string", description: "A dashboard path, or for external documentation an https URL" },
      external: { type: "boolean", description: "Opens outside the dashboard" },
      mono: { type: "boolean", description: "The title is a host name or address" },
      run: {
        type: ["string", "null"],
        enum: [...SEARCH_RUN_ACTIONS, null],
        description: "An action the palette runs itself (apply_config: POST /api/v1/caddy/apply); href is then a page to fall back to",
      },
      verb: { type: "string", enum: ["Open", "Run", "Read"] },
      noHighlight: { type: "boolean", description: "The title is not a match of the query" },
    },
    required: ["group", "kind", "id", "title", "subtitle", "href", "external", "mono", "run", "verb"],
  },
};
