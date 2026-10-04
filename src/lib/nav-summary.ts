/**
 * What the sidebar shows besides its links: the counters next to entries,
 * the edition, and the instance's place in the fleet. Read on every full
 * page load of the dashboard, so each part is a small query, guarded by the
 * read permission of the page it points to, and never throws: a counter
 * that fails is left out.
 */
import { X509Certificate } from "node:crypto";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { appDb } from "./db";
import { alertRuleStates, alertRules, certificates } from "./db/schema";
import { can, type Access } from "./permissions";
import type { NavBadge, NavBadges } from "./navigation";
import { getInstanceMode, type InstanceMode } from "./instance-sync";
import { certificateIdsInScope } from "./access-scope";
import { organizationCondition } from "@/ee/multi-tenancy/scope";
import { dashboardOrganizationFilter } from "@/ee/multi-tenancy/view";
import { countPendingChangeRequests } from "@/ee/approvals/requests";
import { getLicenseState, countManagedNodes } from "@/ee/licensing/store";
import { EDITION_LABELS } from "@/ee/licensing/features";
import { listEnvironmentRows, listFleetInstances } from "@/ee/fleet/environments";
import { first } from "@/src/lib/db/ops";

const DAY_MS = 86_400_000;

/** Imported certificates expiring within this many days (or already expired) are counted. */
export const CERTIFICATE_EXPIRY_BADGE_DAYS = 14;

export type NavEnvironmentGroup = { id: number; name: string; nodes: number; attention: number };

/** The environment switcher: this instance's role and, for fleet readers, the fleet's environments. */
export type NavEnvironment = {
  mode: InstanceMode;
  name: string;
  note: string;
  tone: "ok" | "warn";
  /** Fleet environments (fleet:read only), each with its nodes and how many need attention. */
  environments: NavEnvironmentGroup[];
  /** Where the switcher's links may go. */
  links: { fleet: boolean; sync: boolean };
};

export type NavSummary = {
  badges: NavBadges;
  /** The licensed edition ("Enterprise"), or null without a valid license. */
  edition: string | null;
  environment: NavEnvironment | null;
};

export type ReviewSummary = { pending: number; dueAt: string | null; overdue: boolean };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function safely<T>(read: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

async function alertsBadge(access: Access): Promise<NavBadge | null> {
  if (!can(access, "alerts:read")) return null;
  const row = await first(appDb
    .select({ value: count() })
    .from(alertRuleStates)
    .innerJoin(alertRules, eq(alertRules.id, alertRuleStates.ruleId))
    .where(and(eq(alertRuleStates.status, "firing"), eq(alertRules.enabled, true)))
    .limit(1));
  const firing = row?.value ?? 0;
  return firing > 0 ? { text: String(firing), tone: "warn", label: plural(firing, "alert firing", "alerts firing") } : null;
}

/** validTo by certificate id and PEM length, so unchanged certificates are parsed once. */
const validToCache = new Map<string, number | null>();

function validTo(id: number, pem: string): number | null {
  const key = `${id}:${pem.length}:${pem.slice(-48)}`;
  if (validToCache.has(key)) return validToCache.get(key)!;
  let value: number | null;
  try {
    value = new Date(new X509Certificate(pem).validTo).getTime();
  } catch {
    value = null;
  }
  if (validToCache.size > 500) validToCache.clear();
  validToCache.set(key, value);
  return value;
}

async function certificatesBadge(access: Access, now: number): Promise<NavBadge | null> {
  if (!can(access, "certificates:read")) return null;
  const organizationId = await dashboardOrganizationFilter(access);
  const inScope = await certificateIdsInScope(access);
  const rows = await appDb
    .select({ id: certificates.id, pem: certificates.certificatePem })
    .from(certificates)
    .where(and(eq(certificates.type, "imported"), isNotNull(certificates.certificatePem), organizationCondition(certificates.organizationId, organizationId)));
  const limit = now + CERTIFICATE_EXPIRY_BADGE_DAYS * DAY_MS;
  const expiring = rows.filter((row) => {
    if (inScope !== null && !inScope.has(row.id)) return false;
    const end = row.pem ? validTo(row.id, row.pem) : null;
    return end !== null && end <= limit;
  }).length;
  return expiring > 0
    ? { text: String(expiring), tone: "warn", label: `${plural(expiring, "certificate", "certificates")} expiring within ${CERTIFICATE_EXPIRY_BADGE_DAYS} days` }
    : null;
}

async function approvalsBadge(access: Access): Promise<NavBadge | null> {
  if (!can(access, "approvals:read")) return null;
  const pending = await countPendingChangeRequests(access);
  return pending > 0 ? { text: String(pending), tone: "neutral", label: plural(pending, "change request waiting", "change requests waiting") } : null;
}

/** The reviewer's own open review items (being named a reviewer is the authorization, as for /my-reviews). */
export function reviewsBadge(reviews: ReviewSummary, now: number): NavBadge | null {
  if (reviews.pending <= 0) return null;
  const items = plural(reviews.pending, "review item", "review items");
  if (!reviews.dueAt) return { text: String(reviews.pending), tone: "neutral", label: `${items} to decide` };
  const due = new Date(reviews.dueAt).getTime();
  if (reviews.overdue || due < now) return { text: "Late", tone: "warn", label: `${items} to decide, overdue` };
  const days = Math.max(0, Math.ceil((due - now) / DAY_MS));
  return {
    text: days === 0 ? "Today" : `${days}d`,
    tone: days <= 7 ? "warn" : "neutral",
    label: `${items} to decide, due ${days === 0 ? "today" : `in ${plural(days, "day", "days")}`}`,
  };
}

async function licenseInfo(access: Access): Promise<{ edition: string | null; badge: NavBadge | null }> {
  const state = await getLicenseState();
  const valid = (state.status === "active" || state.status === "grace") && state.license !== null;
  const edition = valid ? EDITION_LABELS[state.license!.edition] ?? null : null;
  if (!valid || !can(access, "license:read")) return { edition, badge: null };
  const nodes = await countManagedNodes();
  const licensed = state.license!.nodes;
  return {
    edition,
    badge: {
      text: `${nodes} of ${licensed} nodes`,
      tone: nodes > licensed ? "warn" : "neutral",
      label: `${nodes} of ${licensed} licensed nodes in use`,
    },
  };
}

const ATTENTION = new Set(["drifted", "unreachable", "older_version"]);

async function environmentSummary(access: Access): Promise<NavEnvironment | null> {
  const canFleet = can(access, "fleet:read");
  const canInstances = can(access, "instances:read");
  if (!canFleet && !canInstances) return null;
  const mode = await getInstanceMode();
  const links = { fleet: canFleet, sync: canInstances && can(access, "settings:read") };
  if (mode === "slave") {
    return { mode, name: "Replica", note: "Follows its master", tone: "ok", environments: [], links };
  }
  if (mode === "standalone") {
    return { mode, name: "This server", note: "Standalone · 1 node", tone: "ok", environments: [], links };
  }
  const instances = (await listFleetInstances()).filter((instance) => instance.enabled);
  const needsAttention = (instance: (typeof instances)[number]) =>
    Boolean(instance.lastSyncError) || (instance.drift.status !== null && ATTENTION.has(instance.drift.status));
  const attention = instances.filter(needsAttention).length;
  const nodes = instances.length + 1;
  const environments = canFleet
    ? (await listEnvironmentRows()).map((environment) => {
        const members = instances.filter((instance) => instance.environmentId === environment.id);
        return { id: environment.id, name: environment.name, nodes: members.length, attention: members.filter(needsAttention).length };
      })
    : [];
  return {
    mode,
    name: "Master",
    note: `${plural(nodes, "node", "nodes")}${attention > 0 ? ` · ${attention} ${attention === 1 ? "needs" : "need"} attention` : ""}`,
    tone: attention > 0 ? "warn" : "ok",
    environments,
    links,
  };
}

/** Everything the sidebar shows for `access` besides its links. */
export async function getNavSummary(access: Access, reviews: ReviewSummary, now: Date = new Date()): Promise<NavSummary> {
  const at = now.getTime();
  const [alertsFiring, certificatesExpiring, approvalsPending, license, environment] = await Promise.all([
    safely(async () => await alertsBadge(access), null),
    safely(() => certificatesBadge(access, at), null),
    safely(async () => await approvalsBadge(access), null),
    safely(() => licenseInfo(access), { edition: null, badge: null }),
    safely(() => environmentSummary(access), null),
  ]);
  return {
    badges: {
      alertsFiring,
      certificatesExpiring,
      approvalsPending,
      reviewsDue: reviewsBadge(reviews, at),
      licenseNodes: license.badge,
    },
    edition: license.edition,
    environment,
  };
}
