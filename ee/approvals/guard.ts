// SPDX-License-Identifier: Elastic-2.0
/**
 * Enforcement of approval policies below the routes and server actions, so
 * that no path changes a protected host without approval:
 *
 * - assertHostChangeApproved runs in the proxy host and L4 proxy host model
 *   functions (create, update, delete). Unless the call runs inside
 *   runApprovedChange (an approved or emergency change being applied, see
 *   requests.ts), a change a policy covers is refused with 409. The routes
 *   and server actions turn such changes into change requests before they
 *   get here; every other caller (WAF rule suppression, AI tuning
 *   suggestions) is refused with a clear message.
 * - assertReplacementApproved runs inside the transaction that replaces the
 *   whole configuration (import, backup restore, configuration history
 *   rollback): a replacement that would add, change or remove a protected
 *   host is refused and nothing is written.
 *
 * Instance sync writes a replica's tables directly and is not affected: the
 * master already enforced its policies.
 */
import { ApiConflictError } from "@/src/lib/api-errors";
import { normalizeTags, parseStoredTags } from "@/src/lib/host-tags";
import { CONFIG_TABLES, type ConfigContent, type ConfigRow } from "@/src/lib/config-content";
import { canonicalJson, VOLATILE_COLUMNS } from "@/ee/config-history/fingerprint";
import { describePolicies, policiesCovering, updateOperations } from "./match";
import { readEnabledPolicyRules, type PolicyReader } from "./store";
import { TARGET_LABELS, type Operation, type PolicyRule, type TargetType } from "./types";
import { approvedChangeStorage, type ApprovedChange } from "./context";

const storage = approvedChangeStorage;

/** Runs `operation` as the approved (or emergency) change of request `requestId`. */
export function runApprovedChange<T>(change: ApprovedChange, operation: () => Promise<T>): Promise<T> {
  return storage.run(change, operation);
}

function isApproved(targetType: TargetType, targetId: number | null): boolean {
  const current = storage.getStore();
  if (!current || current.targetType !== targetType) return false;
  return current.targetId === null ? targetId === null : current.targetId === targetId;
}

/** A protected change attempted outside a change request (409); the message is safe to show. */
export class ApprovalRequiredError extends ApiConflictError {
  readonly policyIds: number[];
  constructor(message: string, policies: readonly PolicyRule[]) {
    super(message);
    this.name = "ApprovalRequiredError";
    this.policyIds = policies.map((policy) => policy.id);
  }
}

export type HostChangeCheck = {
  targetType: TargetType;
  targetId: number | null;
  name: string;
  /** The host's tags before and after the change. */
  tags: readonly string[];
  operations: readonly Operation[];
};

/**
 * Refuses a change a policy covers unless it runs as an approved change.
 * Called by the host model functions before they write anything.
 */
export async function assertHostChangeApproved(change: HostChangeCheck, reader?: PolicyReader): Promise<void> {
  if (isApproved(change.targetType, change.targetId)) return;
  const covering = policiesCovering(await readEnabledPolicyRules(reader), change.targetType, change.tags, change.operations);
  if (covering.length === 0) return;
  const label = `${TARGET_LABELS[change.targetType]} "${change.name}"`;
  throw new ApprovalRequiredError(
    `${label} is protected by ${describePolicies(covering)}: this change needs approval. ` +
      "Make it from the host's page or the REST API to submit a change request.",
    covering
  );
}

type ExistingHost = { id: number; name: string; tags: readonly string[]; enabled: boolean };

/** For createProxyHost / createL4ProxyHost: `tags` as the input gives them. */
export async function assertHostCreateApproved(targetType: TargetType, name: unknown, tags: unknown): Promise<void> {
  await assertHostChangeApproved({
    targetType,
    targetId: null,
    name: typeof name === "string" ? name : "",
    tags: normalizeTags(tags),
    operations: ["create"],
  });
}

/** For updateProxyHost / updateL4ProxyHost: the host's tags before and after both count. */
export async function assertHostUpdateApproved(targetType: TargetType, existing: ExistingHost, input: object): Promise<void> {
  const fields = input as Record<string, unknown>;
  const requested = fields.tags !== undefined ? normalizeTags(fields.tags) : [];
  await assertHostChangeApproved({
    targetType,
    targetId: existing.id,
    name: existing.name,
    tags: [...new Set([...existing.tags, ...requested])],
    operations: updateOperations(fields, existing.enabled).operations,
  });
}

/** For deleteProxyHost / deleteL4ProxyHost. */
export async function assertHostDeleteApproved(targetType: TargetType, existing: ExistingHost): Promise<void> {
  await assertHostChangeApproved({ targetType, targetId: existing.id, name: existing.name, tags: existing.tags, operations: ["delete"] });
}

// ── Whole-configuration replacement ───────────────────────────────────

const MAX_LISTED = 5;

function comparable(table: keyof typeof CONFIG_TABLES, row: ConfigRow, drop: readonly string[] = []): ConfigRow {
  const skip = new Set([...VOLATILE_COLUMNS, ...CONFIG_TABLES[table].attributionColumns, ...drop]);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !skip.has(key)));
}

function groupByHost(rows: ConfigRow[]): Map<unknown, ConfigRow[]> {
  const map = new Map<unknown, ConfigRow[]>();
  for (const row of rows) map.set(row.proxyHostId, [...(map.get(row.proxyHostId) ?? []), row]);
  return map;
}

/** Each host of the configuration as a comparable string (without and with its enabled flag). */
function hostStates(content: ConfigContent, targetType: TargetType): Map<number, { row: ConfigRow; withoutEnabled: string; full: string }> {
  const table = targetType === "proxy_host" ? "proxyHosts" : "l4ProxyHosts";
  const rules = targetType === "proxy_host" ? groupByHost(content.tables.mtlsAccessRules) : new Map<unknown, ConfigRow[]>();
  const grants = targetType === "proxy_host" ? groupByHost(content.tables.forwardAuthAccess) : new Map<unknown, ConfigRow[]>();
  const exclusions = targetType === "proxy_host" ? groupByHost(content.tables.wafRuleExclusions) : new Map<unknown, ConfigRow[]>();
  const states = new Map<number, { row: ConfigRow; withoutEnabled: string; full: string }>();
  for (const row of content.tables[table]) {
    const id = row.id as number;
    // A host's forward-auth grants, mTLS access rules and WAF rule exclusions are part of it.
    const extra = {
      mtlsAccessRules: (rules.get(id) ?? []).map((rule) => comparable("mtlsAccessRules", rule)).map(canonicalJson).sort(),
      forwardAuthAccess: (grants.get(id) ?? [])
        .map((grant) => canonicalJson({ userId: grant.userId ?? null, groupId: grant.groupId ?? null }))
        .sort(),
      ...(exclusions.has(id)
        ? { wafRuleExclusions: (exclusions.get(id) ?? []).map((rule) => comparable("wafRuleExclusions", rule, ["id", "reason"])).map(canonicalJson).sort() }
        : {}),
    };
    const base = comparable(table, row);
    states.set(id, {
      row,
      full: canonicalJson({ ...base, ...extra }),
      withoutEnabled: canonicalJson({ ...comparable(table, row, ["enabled"]), ...extra }),
    });
  }
  return states;
}

function describeRow(row: ConfigRow): string {
  return typeof row.name === "string" && row.name ? row.name : `#${String(row.id)}`;
}

export type ProtectedHostChange = {
  targetType: TargetType;
  id: number;
  name: string;
  operations: Operation[];
  policies: PolicyRule[];
};

/**
 * The hosts that replacing the configuration with `next` would create,
 * change or delete although an enabled policy protects them (by their tags
 * before or after), with the policies. Empty when nothing is protected.
 */
export async function protectedReplacementChanges(reader: PolicyReader, current: ConfigContent, next: ConfigContent): Promise<ProtectedHostChange[]> {
  const policies = await readEnabledPolicyRules(reader);
  if (policies.length === 0) return [];
  const affected: ProtectedHostChange[] = [];
  for (const targetType of ["proxy_host", "l4_proxy_host"] as const) {
    const before = hostStates(current, targetType);
    const after = hostStates(next, targetType);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(id);
      const b = after.get(id);
      if (a && b && a.full === b.full) continue;
      let operations: Operation[];
      if (!a) operations = ["create"];
      else if (!b) operations = ["delete"];
      else if (a.withoutEnabled === b.withoutEnabled) operations = [b.row.enabled ? "enable" : "disable"];
      else operations = a.row.enabled === b.row.enabled ? ["update"] : ["update", b.row.enabled ? "enable" : "disable"];
      const tags = [...new Set([...parseStoredTags(a?.row.tags as string), ...parseStoredTags(b?.row.tags as string)])];
      const covering = policiesCovering(policies, targetType, tags, operations);
      if (covering.length === 0) continue;
      affected.push({ targetType, id, name: describeRow((b ?? a)!.row), operations, policies: covering });
    }
  }
  return affected;
}

/**
 * Refuses replacing the configuration with `next` when that would create,
 * change or delete a host that an enabled policy protects (by its tags
 * before or after). Runs inside the replacing transaction; throws a 409
 * before anything is written.
 */
export async function assertReplacementApproved(reader: PolicyReader, current: ConfigContent, next: ConfigContent): Promise<void> {
  const affected = await protectedReplacementChanges(reader, current, next);
  if (affected.length === 0) return;
  const names = new Map<number, PolicyRule>();
  for (const change of affected) for (const policy of change.policies) names.set(policy.id, policy);
  const labels = affected.map((change) => `${TARGET_LABELS[change.targetType].toLowerCase()} "${change.name}"`);
  const listed = labels.slice(0, MAX_LISTED).join(", ") + (labels.length > MAX_LISTED ? ` and ${labels.length - MAX_LISTED} more` : "");
  throw new ApprovalRequiredError(
    `This configuration would change hosts protected by ${describePolicies([...names.values()])}: ${listed}. ` +
      "Nothing was changed. Make these changes through change requests, or have an administrator disable the policies first.",
    [...names.values()]
  );
}
