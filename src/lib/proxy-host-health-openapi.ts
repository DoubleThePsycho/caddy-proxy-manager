/**
 * OpenAPI path and schemas of a proxy host's upstream health
 * (GET /api/v1/proxy-hosts/{id}/health), spread into
 * app/api/v1/openapi.json/route.ts.
 */
import { UPSTREAM_STATUSES } from "./upstream-health";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const STATUS_DESCRIPTION =
  "up: passive health checks count failures and found none recently. degraded: some recent failures. down: as many " +
  "failures as the host allows, so Caddy stops sending it requests. unchecked: no passive health check counts failures " +
  "for it (Caddy does not report active health check results). unknown: Caddy did not answer or does not report the " +
  "address (for example with upstream DNS pinning, where Caddy dials the resolved addresses). disabled: the host is disabled.";

export const PROXY_HOST_HEALTH_OPENAPI_PATHS = {
  "/api/v1/proxy-hosts/{id}/health": {
    get: {
      tags: ["Proxy Hosts"],
      summary: "Upstream health of a proxy host",
      description:
        "Permission proxy_hosts:read. A host outside the caller's tag scope or organisation answers 404. Reads Caddy's " +
        "upstream pool from its admin API (GET /reverse_proxy/upstreams) when called: the requests in flight and the " +
        "failures Caddy's passive health checks counted within their fail duration, per dial address. Caddy keeps one " +
        "entry per address, so hosts with the same upstream share the counts. When Caddy does not answer within a few " +
        "seconds, caddyReachable is false and every upstream is unknown.",
      operationId: "getProxyHostHealth",
      parameters: [{ $ref: "#/components/parameters/IdPath" }],
      responses: {
        "200": { description: "The host's upstream health", content: { "application/json": { schema: ref("ProxyHostHealth") } } },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
};

export const PROXY_HOST_HEALTH_OPENAPI_SCHEMAS = {
  ProxyHostHealth: {
    type: "object",
    properties: {
      proxyHostId: { type: "integer" },
      checkedAt: { type: "string", format: "date-time" },
      caddyReachable: { type: "boolean", description: "Whether Caddy's admin API answered" },
      status: {
        type: "string",
        enum: [...UPSTREAM_STATUSES],
        description: "The host as a whole: down when every upstream is down, degraded when one is down or failing, up when all are up.",
      },
      healthChecks: ref("ProxyHostHealthChecks"),
      upstreams: { type: "array", items: ref("UpstreamHealth") },
    },
    required: ["proxyHostId", "checkedAt", "caddyReachable", "status", "healthChecks", "upstreams"],
  },
  ProxyHostHealthChecks: {
    type: "object",
    description: "The host's health check settings (part of its load balancer settings).",
    properties: {
      active: {
        type: "object",
        nullable: true,
        description: "Active checks: Caddy requests a path on each upstream on an interval. Their results are not reported by Caddy.",
        properties: {
          path: { type: "string", nullable: true },
          port: { type: "integer", nullable: true },
          interval: { type: "string", nullable: true, example: "30s" },
          timeout: { type: "string", nullable: true, example: "5s" },
          expectStatus: { type: "integer", nullable: true },
        },
      },
      passive: {
        type: "object",
        nullable: true,
        properties: {
          failDuration: { type: "string", nullable: true, example: "30s" },
          maxFails: { type: "integer", nullable: true },
          unhealthyStatus: { type: "array", items: { type: "integer" }, nullable: true },
          unhealthyLatency: { type: "string", nullable: true },
          counting: { type: "boolean", description: "False without a fail duration: Caddy then counts no failures." },
        },
      },
      loadBalancing: {
        type: "object",
        nullable: true,
        properties: {
          policy: { type: "string" },
          retries: { type: "integer", nullable: true },
          tryDuration: { type: "string", nullable: true },
        },
      },
    },
    required: ["active", "passive", "loadBalancing"],
  },
  UpstreamHealth: {
    type: "object",
    properties: {
      upstream: { type: "string", description: "As configured on the host", example: "http://app:3000" },
      dial: { type: "string", description: "The address Caddy dials", example: "app:3000" },
      tls: { type: "boolean", description: "Caddy talks TLS to the upstream" },
      status: { type: "string", enum: [...UPSTREAM_STATUSES], description: STATUS_DESCRIPTION },
      reported: { type: "boolean", description: "Caddy reported the address" },
      fails: { type: "integer", nullable: true, description: "Failures counted within the fail duration" },
      requestsInFlight: { type: "integer", nullable: true },
    },
    required: ["upstream", "dial", "tls", "status", "reported", "fails", "requestsInFlight"],
  },
};
