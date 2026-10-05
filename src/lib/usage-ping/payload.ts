/**
 * The anonymous usage ping: exactly what it sends, field by field.
 *
 * This file and collect.ts (where each value comes from) are all there is to
 * read to verify it; documentation/usage-ping.md lists the same fields. The
 * receiving service (ping.ingres.si) refuses any payload that does not
 * have exactly this shape, so adding a field means a new schema version there
 * first.
 *
 * Nothing here reads the database, the environment or the network.
 */
import { EDITIONS, type Feature } from "@/ee/licensing/features";

/** Version of the payload shape. */
export const USAGE_PING_SCHEMA_VERSION = 1;

/** Counts are only ever sent as one of these ranges, never as numbers. */
export const COUNT_BUCKETS = ["0", "1-5", "6-20", "21-100", "101+"] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

/**
 * proxy_hosts: HTTP proxy hosts; l4_hosts: TCP/UDP proxy hosts; users:
 * active dashboard accounts; replicas: the instance sync slaves a master
 * pushes to (always "0" on a standalone install).
 */
export const COUNT_FIELDS = ["proxy_hosts", "l4_hosts", "users", "replicas"] as const;
export type CountField = (typeof COUNT_FIELDS)[number];

/**
 * Free features in use: the WAF on at least one enabled proxy host, forward
 * auth (Authentik, generic or the built-in portal) on at least one enabled
 * proxy host, ClickHouse analytics configured, and rate limiting rules that
 * apply to at least one enabled proxy host.
 */
export const COMMUNITY_FEATURES = ["waf", "forward_auth", "clickhouse_analytics", "rate_limiting"] as const;

/**
 * Paid features that are set up on this install, by their license feature id
 * (ee/licensing/features.ts). Only whether each one is configured is sent,
 * never what it is configured with. collect.ts has the check for each.
 */
export const PAID_FEATURES = [
  "sso_saml",
  "sso_enforce",
  "custom_roles",
  "audit_streaming",
  "alerting",
  "config_history",
  "scheduled_backups",
  "ai_analyst",
  "approvals",
  "compliance_reports",
  "scim",
  "access_reviews",
  "ldap",
  "fleet",
  "high_availability",
  "multi_tenancy",
  "white_label",
  "api_monetization",
] as const satisfies readonly Feature[];
export type PaidFeatureField = (typeof PAID_FEATURES)[number];

/**
 * Features that were withdrawn: schema 1 of the receiving service requires
 * their fields, so they are always sent as false until the next schema.
 */
export const WITHDRAWN_FEATURES = ["virtual_patching"] as const;
export type WithdrawnFeatureField = (typeof WITHDRAWN_FEATURES)[number];

export const FEATURE_FIELDS = [...COMMUNITY_FEATURES, ...PAID_FEATURES, ...WITHDRAWN_FEATURES] as const;
export type FeatureField = (typeof FEATURE_FIELDS)[number];

/** "community" without a valid license; otherwise the licensed edition's name only. */
export const USAGE_PING_EDITIONS = ["community", ...EDITIONS] as const;
export type UsagePingEdition = (typeof USAGE_PING_EDITIONS)[number];

/** Sync slaves (replicas) never send, so only these two roles appear. */
export const USAGE_PING_ROLES = ["standalone", "master"] as const;
export type UsagePingRole = (typeof USAGE_PING_ROLES)[number];

/** Node.js's process.arch values; anything else is sent as "other". */
export const USAGE_PING_ARCHES = ["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64", "loong64", "other"] as const;
export type UsagePingArch = (typeof USAGE_PING_ARCHES)[number];

/** A release tag or commit; anything else (or longer) is sent as "unknown". */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type UsagePingPayload = {
  /** USAGE_PING_SCHEMA_VERSION. */
  schema: typeof USAGE_PING_SCHEMA_VERSION;
  /** Random UUID v4, created when the ping is turned on; derived from nothing. */
  install_id: string;
  /** The release this install runs. */
  version: string;
  edition: UsagePingEdition;
  role: UsagePingRole;
  counts: Record<CountField, CountBucket>;
  features: Record<FeatureField, boolean>;
  /** CPU architecture of the dashboard's container. */
  arch: UsagePingArch;
};

/** The values collect.ts gathers, before bucketing and normalising. */
export type UsagePingFacts = {
  version: string;
  edition: UsagePingEdition;
  role: UsagePingRole;
  counts: Record<CountField, number>;
  features: Record<Exclude<FeatureField, WithdrawnFeatureField>, boolean>;
  arch: string;
};

export function bucketCount(count: number): CountBucket {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count <= 5) return "1-5";
  if (count <= 20) return "6-20";
  if (count <= 100) return "21-100";
  return "101+";
}

export function normalizeVersion(version: string): string {
  return VERSION_PATTERN.test(version) ? version : "unknown";
}

export function normalizeArch(arch: string): UsagePingArch {
  return (USAGE_PING_ARCHES as readonly string[]).includes(arch) ? (arch as UsagePingArch) : "other";
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

/**
 * The payload, with its keys always in this order. Built only from the
 * fields listed above: nothing in `facts` beyond them can reach it.
 */
export function buildUsagePingPayload(installId: string, facts: UsagePingFacts): UsagePingPayload {
  return {
    schema: USAGE_PING_SCHEMA_VERSION,
    install_id: installId,
    version: normalizeVersion(facts.version),
    edition: (USAGE_PING_EDITIONS as readonly string[]).includes(facts.edition) ? facts.edition : "community",
    role: facts.role === "master" ? "master" : "standalone",
    counts: {
      proxy_hosts: bucketCount(facts.counts.proxy_hosts),
      l4_hosts: bucketCount(facts.counts.l4_hosts),
      users: bucketCount(facts.counts.users),
      replicas: facts.role === "master" ? bucketCount(facts.counts.replicas) : "0",
    },
    features: Object.fromEntries(
      FEATURE_FIELDS.map((field) => [
        field,
        !(WITHDRAWN_FEATURES as readonly string[]).includes(field) &&
          (facts.features as Partial<Record<FeatureField, boolean>>)[field] === true,
      ])
    ) as Record<
      FeatureField,
      boolean
    >,
    arch: normalizeArch(facts.arch),
  };
}
