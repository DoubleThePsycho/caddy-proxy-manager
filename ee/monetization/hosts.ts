// SPDX-License-Identifier: Elastic-2.0
/**
 * Monetization of proxy hosts: which hosts the gate guards, the header the
 * consumers' API key arrives in and the plans allowed on the host.
 *
 * Monetization is an authentication mode: it cannot be combined with
 * forward auth (built-in, Authentik or generic) or a basic-auth access list
 * on the same host (400 either way round; host-guard.ts covers the proxy
 * host side). WAF, geoblocking, mTLS and everything else stay
 * available.
 *
 * Balances live in this process, unless high availability shared state keeps
 * them in Redis or Valkey for every web node, so monetization cannot be
 * turned on while several web replicas share a PostgreSQL database without
 * shared state (409): each would charge its own copy of the balances (D9).
 * On a sync master it gates on the master; sync replicas serve monetized
 * hosts only when the master sends them with what they need to gate them
 * (replica-sync.ts), never ungated. A slave refuses (409): its configuration
 * comes from the master.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { monetizationHosts, monetizationPlans } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { brandName } from "@/ee/white-label/store";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { isSharedStateOn } from "@/ee/high-availability/shared-state/connection";
import { countReplicas } from "@/src/lib/db/events";
import { getProxyHost, listProxyHosts, type ProxyHost } from "@/src/lib/models/proxy-hosts";
import { reloadMonetization } from "./engine";
import { getHostRow, hostAuthConflicts, readAllowedPlanIds } from "./host-guard";
import { parseBoolean, parseIdList, parseInteger, rejectUnknownKeys, requireRecord } from "./http";
import { ensureGateSecret } from "./settings";
import { DEFAULT_KEY_HEADER, type HostMonetizationView } from "./types";
import { MAX_X402_PRICE_CENTS, MIN_X402_PRICE_CENTS } from "./x402/settings";

export const HOST_NOT_FOUND = "Proxy host not found";

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Headers that carry something else, or that the proxy or the gate set themselves. */
const RESERVED_HEADERS = new Set([
  "host", "cookie", "content-length", "content-type", "content-encoding", "transfer-encoding", "connection",
  "upgrade", "te", "trailer", "keep-alive", "expect", "proxy-authorization", "forwarded", "x-real-ip",
  "accept", "accept-encoding", "user-agent", "origin", "referer",
]);
const RESERVED_PREFIXES = ["x-forwarded-", "x-ingressi-", "x-cpm-"];

type HostRow = typeof monetizationHosts.$inferSelect;

export function parseKeyHeader(value: unknown): string {
  if (value === undefined || value === null || value === "") return DEFAULT_KEY_HEADER;
  if (typeof value !== "string" || !HEADER_NAME.test(value.trim())) {
    throw new ApiValidationError("keyHeader must be a header name of letters, digits and hyphens (at most 64)");
  }
  const name = value.trim();
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower) || RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    throw new ApiValidationError(`${name} cannot carry API keys; use Authorization or a header such as X-API-Key`);
  }
  return lower === "authorization" ? DEFAULT_KEY_HEADER : name;
}

function toView(host: ProxyHost, row: HostRow | null): HostMonetizationView {
  return {
    proxyHostId: host.id,
    name: host.name,
    domains: host.domains,
    hostEnabled: host.enabled,
    monetization: row
      ? {
          enabled: row.enabled,
          keyHeader: row.keyHeader,
          allowedPlanIds: readAllowedPlanIds(row.allowedPlanIds),
          x402: { enabled: row.x402Enabled, priceCents: row.x402PriceCents },
        }
      : null,
    conflicts: hostAuthConflicts(host),
  };
}

export async function listHostMonetization(): Promise<HostMonetizationView[]> {
  const rows = new Map((await appDb.select().from(monetizationHosts)).map((row) => [row.proxyHostId, row]));
  return (await listProxyHosts()).map((host) => toView(host, rows.get(host.id) ?? null));
}

async function requireHost(proxyHostId: number): Promise<ProxyHost> {
  const host = await getProxyHost(proxyHostId);
  if (!host) throw new ApiClientError(HOST_NOT_FOUND, 404);
  return host;
}

export async function getHostMonetization(proxyHostId: number): Promise<HostMonetizationView> {
  return toView(await requireHost(proxyHostId), await getHostRow(proxyHostId));
}

async function parseAllowedPlans(value: unknown): Promise<number[]> {
  const ids = parseIdList(value, "allowedPlanIds");
  const known = new Set((await appDb.select({ id: monetizationPlans.id }).from(monetizationPlans)).map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new ApiValidationError(`allowedPlanIds names no plan: ${unknown.join(", ")}`);
  return ids;
}

/**
 * 409 unless this install keeps balances in high availability shared state
 * (then every web node charges the same balances), or is standalone and the
 * only web replica on its database.
 */
export async function assertStandalone(): Promise<void> {
  const mode = await getInstanceMode();
  if (mode === "slave") {
    throw new ApiConflictError(
      "This instance is a sync replica: monetized hosts come from its master, which also decides whether replicas serve them"
    );
  }
  if (await isSharedStateOn()) return;
  const replicas = await countReplicas();
  if (replicas > 1) {
    throw new ApiConflictError(
      `API monetization keeps balances in each ${brandName()} process, and ${replicas} web replicas use this database, ` +
        "so each would charge its own copy of the balances. Turn on high availability shared state (Redis or Valkey) first, " +
        "so that every replica charges the same balances, or run a single replica"
    );
  }
}

type HostX402Input = { enabled: boolean; priceCents: number | null };

/** {enabled?, priceCents?}: the host's price per request in US cents (null: the x402 settings' price); fields left out keep their values. */
function parseHostX402(value: unknown, existing: HostRow | null): HostX402Input {
  const record = requireRecord(value);
  rejectUnknownKeys(record, ["enabled", "priceCents"]);
  const enabled = record.enabled === undefined ? existing?.x402Enabled ?? false : parseBoolean(record.enabled, "x402.enabled");
  const priceCents =
    record.priceCents === undefined
      ? existing?.x402PriceCents ?? null
      : record.priceCents === null
        ? null
        : parseInteger(record.priceCents, "x402.priceCents", MIN_X402_PRICE_CENTS, MAX_X402_PRICE_CENTS);
  return { enabled, priceCents };
}

/**
 * {enabled?, keyHeader?, allowedPlanIds?, x402?}. Turning monetization on (or
 * changing it while on) needs an instance that is not a sync replica and a
 * host without another authentication mode; turning it off needs neither.
 */
export async function setHostMonetization(proxyHostId: number, body: unknown, actorUserId: number): Promise<HostMonetizationView> {
  const host = await requireHost(proxyHostId);
  const record = requireRecord(body);
  rejectUnknownKeys(record, ["enabled", "keyHeader", "allowedPlanIds", "x402"]);
  const existing = await getHostRow(proxyHostId);
  const enabled = record.enabled === undefined ? true : parseBoolean(record.enabled, "enabled");
  const x402 = record.x402 === undefined ? null : parseHostX402(record.x402, existing);
  const keyHeader = record.keyHeader === undefined ? existing?.keyHeader ?? DEFAULT_KEY_HEADER : parseKeyHeader(record.keyHeader);
  const allowedPlanIds =
    record.allowedPlanIds === undefined ? readAllowedPlanIds(existing?.allowedPlanIds ?? "[]") : await parseAllowedPlans(record.allowedPlanIds);

  if (enabled) {
    await assertStandalone();
    const conflicts = hostAuthConflicts(host);
    if (conflicts.length > 0) {
      throw new ApiValidationError(
        `API monetization is an authentication mode and cannot be combined with ${conflicts.join(" and ")} on the same host; turn ${conflicts.length > 1 ? "them" : "it"} off first`
      );
    }
    await ensureGateSecret();
  }

  const stamp = nowIso();
  const values = {
    enabled,
    keyHeader,
    allowedPlanIds: JSON.stringify(allowedPlanIds),
    ...(x402 ? { x402Enabled: x402.enabled, x402PriceCents: x402.priceCents } : {}),
    updatedAt: stamp,
  };
  await appDb.insert(monetizationHosts)
    .values({ proxyHostId, ...values, createdAt: stamp })
    .onConflictDoUpdate({ target: monetizationHosts.proxyHostId, set: values });

  // Turning on: the gate learns the host before Caddy routes to it. Turning
  // off: Caddy stops routing to the gate before the gate forgets the host.
  if (enabled) await reloadMonetization();
  await applyCaddyConfig();
  if (!enabled) await reloadMonetization();

  await logAuditEvent({
    userId: actorUserId,
    action: enabled ? (existing?.enabled ? "update" : "enable") : "disable",
    entityType: "monetization_host",
    entityId: proxyHostId,
    summary: `${enabled ? (existing?.enabled ? "Updated" : "Turned on") : "Turned off"} API monetization on proxy host ${host.name}`,
    data: { enabled, keyHeader, allowedPlanIds, ...(x402 ? { x402 } : {}) },
  });
  return toView(host, await getHostRow(proxyHostId));
}

/** Turns monetization off and forgets the host's settings. */
export async function removeHostMonetization(proxyHostId: number, actorUserId: number): Promise<void> {
  const existing = await getHostRow(proxyHostId);
  const host = await getProxyHost(proxyHostId);
  if (!existing) {
    if (!host) throw new ApiClientError(HOST_NOT_FOUND, 404);
    return;
  }
  await appDb.delete(monetizationHosts).where(eq(monetizationHosts.proxyHostId, proxyHostId));
  await applyCaddyConfig();
  await reloadMonetization();
  await logAuditEvent({
    userId: actorUserId,
    action: "disable",
    entityType: "monetization_host",
    entityId: proxyHostId,
    summary: `Turned off API monetization on proxy host ${host?.name ?? `#${proxyHostId}`}`,
  });
}
