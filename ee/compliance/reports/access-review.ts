// SPDX-License-Identifier: Elastic-2.0
/**
 * Access review: every dashboard user with what they can do and how they sign
 * in, their API tokens and forward-auth groups, as of generation time, plus
 * sign-ins and access changes during the period.
 *
 * Token hashes, password hashes, TOTP secrets and backup codes are never
 * read here; tokens appear by name and dates only.
 */
import { and, count, eq, gte, inArray, isNotNull, lte, max, ne, notInArray, or } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import {
  accounts,
  apiTokens,
  auditEvents,
  forwardAuthAccess,
  groupMembers,
  groups,
  oauthProviders,
  proxyHosts,
  sessions,
  users,
} from "@/src/lib/db/schema";
import { isAdminLevel, PERMISSIONS } from "@/src/lib/permissions";
import { hasPasswordCredential, listMfaAccountSummaries, mfaPolicyDeadline, readMfaPolicy } from "@/src/lib/mfa";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { listCustomRoleViews } from "@/ee/custom-roles/store";
import { SIGN_IN_ACTIONS } from "../audit-areas";
import {
  auditEventSection,
  clean,
  columns,
  daysBetween,
  finding,
  iso,
  keyValueSection,
  percent,
  section,
  sortFindings,
  summaryItem,
  userLabel,
  type AuditRow,
  type BuildContext,
  type BuiltReport,
} from "./shared";
import type { ReportFinding } from "../types";
import { asc, first } from "@/src/lib/db/ops";

export const INACTIVE_DAYS = 90;
export const TOKEN_UNUSED_DAYS = 90;
const MAX_ACCESS_CHANGES = 2000;

/** Audit entity types whose changes alter who can do what. */
const ACCESS_ENTITY_TYPES = ["user", "custom_role", "group", "group_member", "forward_auth_access", "sso_enforcement", "oauth_provider"];

async function latestSignIns(): Promise<Map<number, string>> {
  const latest = new Map<number, string>();
  const keep = (userId: number | null, at: string | null) => {
    if (userId === null || !at) return;
    const value = iso(at);
    if (!value) return;
    const current = latest.get(userId);
    if (!current || value > current) latest.set(userId, value);
  };
  for (const row of await appDb
    .select({ userId: auditEvents.userId, at: max(auditEvents.createdAt) })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "login_success"), isNotNull(auditEvents.userId)))
    .groupBy(auditEvents.userId)) {
    keep(row.userId, row.at);
  }
  // A session's creation time is a sign-in too (sessions outlive audit retention less often).
  for (const row of await appDb.select({ userId: sessions.userId, at: max(sessions.createdAt) }).from(sessions).groupBy(sessions.userId)) {
    keep(row.userId, row.at);
  }
  return latest;
}

async function signInsInPeriod(context: BuildContext): Promise<Map<number, number>> {
  const rows = await appDb
    .select({ userId: auditEvents.userId, total: count() })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "login_success"),
        gte(auditEvents.createdAt, context.period.from.toISOString()),
        lte(auditEvents.createdAt, context.period.to.toISOString())
      )
    )
    .groupBy(auditEvents.userId);
  return new Map(rows.filter((row) => row.userId !== null).map((row) => [row.userId as number, row.total]));
}

async function accessChanges(context: BuildContext): Promise<{ rows: AuditRow[]; total: number }> {
  const where = and(
    gte(auditEvents.createdAt, context.period.from.toISOString()),
    lte(auditEvents.createdAt, context.period.to.toISOString()),
    or(inArray(auditEvents.entityType, ACCESS_ENTITY_TYPES), eq(auditEvents.action, "mfa_policy_updated")),
    notInArray(auditEvents.action, [...SIGN_IN_ACTIONS])
  );
  const rows = await appDb
    .select({
      id: auditEvents.id,
      createdAt: auditEvents.createdAt,
      userId: auditEvents.userId,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      summary: auditEvents.summary,
      hash: auditEvents.hash,
      userName: users.name,
      userEmail: users.email,
      username: users.username,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.userId))
    .where(where)
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
    .limit(MAX_ACCESS_CHANGES);
  const total = (await first(appDb.select({ value: count() }).from(auditEvents).where(where).limit(1)))?.value ?? 0;
  return { rows, total };
}

function groupBy<K, V>(items: V[], key: (item: V) => K): Map<K, V[]> {
  const map = new Map<K, V[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

export async function buildAccessReview(context: BuildContext): Promise<BuiltReport> {
  const { now } = context;
  const userRows = await appDb
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      username: users.username,
      role: users.role,
      status: users.status,
      customRoleId: users.customRoleId,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.id));
  const roles = await listCustomRoleViews(appDb);
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const mfaById = new Map((await listMfaAccountSummaries(now)).map((summary) => [summary.id, summary]));
  const mfaPolicy = await readMfaPolicy();
  const sso = await readSsoEnforcement(appDb);
  const lastSignIn = await latestSignIns();
  const periodSignIns = await signInsInPeriod(context);

  const providerNames = new Map((await appDb.select({ id: oauthProviders.id, name: oauthProviders.name }).from(oauthProviders)).map((row) => [row.id, row.name]));
  const identities = groupBy(
    await appDb.select({ userId: accounts.userId, providerId: accounts.providerId }).from(accounts).where(ne(accounts.providerId, "credential")),
    (row) => row.userId
  );
  const tokens = await appDb
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdBy: apiTokens.createdBy,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .orderBy(asc(apiTokens.id));
  const tokensByUser = groupBy(tokens, (token) => token.createdBy);
  const memberships = await appDb
    .select({ userId: groupMembers.userId, groupId: groups.id, groupName: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .orderBy(asc(groups.name), asc(groups.id));
  const groupsByUser = groupBy(memberships, (row) => row.userId);
  const grants = await appDb
    .select({ userId: forwardAuthAccess.userId, groupId: forwardAuthAccess.groupId, hostName: proxyHosts.name })
    .from(forwardAuthAccess)
    .innerJoin(proxyHosts, eq(proxyHosts.id, forwardAuthAccess.proxyHostId))
    .orderBy(asc(proxyHosts.name), asc(proxyHosts.id));
  const directGrants = groupBy(grants.filter((grant) => grant.userId !== null), (grant) => grant.userId as number);
  const groupGrants = groupBy(grants.filter((grant) => grant.groupId !== null), (grant) => grant.groupId as number);

  const findings: ReportFinding[] = [];
  const usersById = new Map(userRows.map((user) => [user.id, user]));
  let admins = 0;
  let adminsWithoutMfa = 0;
  let activeUsers = 0;
  let activeWithMfa = 0;
  let inactive = 0;

  // Read before the rows are built, one user at a time: the rows, counts and findings keep the user order.
  const passwordSignIns = new Map<number, boolean>();
  for (const user of userRows) passwordSignIns.set(user.id, await hasPasswordCredential(appDb, user.id));

  const userTableRows = userRows.map((user) => {
    const label = userLabel(user, user.id);
    const role = user.customRoleId !== null ? rolesById.get(user.customRoleId) ?? null : null;
    const builtInAdmin = user.role === "admin" && user.customRoleId === null;
    const administrator = builtInAdmin || (role !== null && role.adminLevel);
    const permissions = builtInAdmin ? ["all"] : role ? [...role.permissions] : [];
    const mfa = mfaById.get(user.id);
    const mfaEnrolled = mfa?.enabled === true;
    const active = user.status === "active";
    const last = lastSignIn.get(user.id) ?? null;
    const flags: string[] = [];

    if (active) {
      activeUsers += 1;
      if (mfaEnrolled) activeWithMfa += 1;
      if (administrator) {
        admins += 1;
        if (!mfaEnrolled) {
          adminsWithoutMfa += 1;
          flags.push("admin_without_mfa");
          findings.push(finding("high", "admin_without_mfa", `user:${user.id}`, `Administrator ${label} has no second factor (MFA) set up.`));
        }
      } else if (mfa?.required && !mfaEnrolled) {
        flags.push("mfa_required_not_enrolled");
        findings.push(finding("low", "mfa_required_not_enrolled", `user:${user.id}`, `${label} is required to set up MFA by the MFA policy and has not done so yet.`));
      }
      const reference = last ?? user.createdAt;
      if (daysBetween(reference, now) > INACTIVE_DAYS) {
        inactive += 1;
        flags.push("inactive_90_days");
        findings.push(
          finding(
            "medium",
            "inactive_90_days",
            `user:${user.id}`,
            last
              ? `Active account ${label} has not signed in since ${last.slice(0, 10)} (more than ${INACTIVE_DAYS} days).`
              : `Active account ${label}, created on ${String(iso(user.createdAt)).slice(0, 10)}, has no recorded sign-in in more than ${INACTIVE_DAYS} days.`
          )
        );
      }
    }

    const userGroups = groupsByUser.get(user.id) ?? [];
    const userTokens = tokensByUser.get(user.id) ?? [];
    const ssoIdentities = [...new Set((identities.get(user.id) ?? []).map((row) => clean(providerNames.get(row.providerId) ?? row.providerId, 100)))];
    return {
      id: user.id,
      email: clean(user.email, 200),
      name: clean(user.name ?? "", 120) || null,
      username: clean(user.username ?? "", 120) || null,
      status: clean(user.status, 20),
      role: role ? `custom: ${clean(role.name, 64)}` : user.customRoleId !== null ? "viewer (custom role deleted)" : clean(user.role, 20),
      administrator,
      permissions,
      scopeTags: role ? [...role.scopeTags] : [],
      mfa: mfaEnrolled ? "enrolled" : "not enrolled",
      mfaRequiredByPolicy: mfa?.required === true,
      passwordSignIn: passwordSignIns.get(user.id) === true,
      ssoIdentities,
      breakGlass: sso.enabled && sso.breakGlassUserIds.includes(user.id),
      lastSignInAt: last,
      signInsInPeriod: periodSignIns.get(user.id) ?? 0,
      createdAt: iso(user.createdAt),
      apiTokens: userTokens.length,
      forwardAuthGroups: userGroups.map((row) => clean(row.groupName, 100)),
      forwardAuthHosts: (directGrants.get(user.id) ?? []).map((grant) => clean(grant.hostName, 120)),
      flags,
    };
  });

  let tokensUnused = 0;
  let tokensExpired = 0;
  const tokenRows = tokens.map((token) => {
    const owner = usersById.get(token.createdBy);
    const ownerLabel = userLabel(owner ?? null, token.createdBy);
    const expired = token.expiresAt !== null && Date.parse(token.expiresAt) <= now.getTime();
    const lastUsed = iso(token.lastUsedAt);
    const flags: string[] = [];
    const ownerActive = owner?.status === "active";
    if (expired) {
      tokensExpired += 1;
      flags.push("expired");
      findings.push(finding("low", "token_expired", `api_token:${token.id}`, `API token "${clean(token.name, 100)}" of ${ownerLabel} expired on ${String(iso(token.expiresAt)).slice(0, 10)} and can be deleted.`));
    } else if (ownerActive && daysBetween(lastUsed ?? token.createdAt, now) > TOKEN_UNUSED_DAYS) {
      tokensUnused += 1;
      flags.push("unused_90_days");
      findings.push(
        finding(
          "medium",
          "token_unused_90_days",
          `api_token:${token.id}`,
          lastUsed
            ? `API token "${clean(token.name, 100)}" of ${ownerLabel} was last used on ${lastUsed.slice(0, 10)} (more than ${TOKEN_UNUSED_DAYS} days ago).`
            : `API token "${clean(token.name, 100)}" of ${ownerLabel}, created on ${String(iso(token.createdAt)).slice(0, 10)}, has never been used.`
        )
      );
    }
    return {
      id: token.id,
      name: clean(token.name, 100),
      owner: ownerLabel,
      ownerId: token.createdBy,
      ownerStatus: owner ? clean(owner.status, 20) : "deleted",
      createdAt: iso(token.createdAt),
      expiresAt: iso(token.expiresAt),
      lastUsedAt: lastUsed,
      flags,
    };
  });

  const roleRows = roles.map((role) => ({
    id: role.id,
    name: clean(role.name, 64),
    description: clean(role.description ?? "", 500) || null,
    permissions: [...role.permissions],
    scopeTags: [...role.scopeTags],
    administratorLevel: isAdminLevel(role.permissions),
    users: role.userCount,
  }));

  const groupRows = (await appDb
    .select({ id: groups.id, name: groups.name, description: groups.description })
    .from(groups)
    .orderBy(asc(groups.name), asc(groups.id)))
    .map((group) => {
      const members = memberships.filter((row) => row.groupId === group.id).map((row) => userLabel(usersById.get(row.userId) ?? null, row.userId));
      return {
        id: group.id,
        name: clean(group.name, 100),
        description: clean(group.description ?? "", 300) || null,
        members,
        memberCount: members.length,
        hosts: (groupGrants.get(group.id) ?? []).map((grant) => clean(grant.hostName, 120)),
      };
    });

  const changes = await accessChanges(context);
  const deadline = mfaPolicyDeadline(mfaPolicy);
  const sortedFindings = sortFindings(findings);
  const totalSignIns = [...periodSignIns.values()].reduce((sum, value) => sum + value, 0);

  return {
    summary: [
      summaryItem("users", "Dashboard users", userRows.length),
      summaryItem("activeUsers", "Active users", activeUsers),
      summaryItem("disabledUsers", "Disabled users", userRows.length - activeUsers),
      summaryItem("administrators", "Active administrators (built-in or administrator-level role)", admins),
      summaryItem("administratorsWithoutMfa", "Active administrators without MFA", adminsWithoutMfa),
      summaryItem("mfaCoveragePercent", "MFA coverage of active users (%)", percent(activeWithMfa, activeUsers)),
      summaryItem("inactiveUsers", `Active users without a sign-in for more than ${INACTIVE_DAYS} days`, inactive),
      summaryItem("apiTokens", "API tokens", tokens.length),
      summaryItem("apiTokensUnused", `API tokens unused for more than ${TOKEN_UNUSED_DAYS} days`, tokensUnused),
      summaryItem("apiTokensExpired", "Expired API tokens", tokensExpired),
      summaryItem("customRoles", "Custom roles", roles.length),
      summaryItem("forwardAuthGroups", "Forward-auth groups", groupRows.length),
      summaryItem("signInsInPeriod", "Dashboard sign-ins in the period", totalSignIns),
      summaryItem("accessChangesInPeriod", "Access changes in the period", changes.total),
    ],
    findings: sortedFindings,
    sections: [
      section(
        "users",
        "Users",
        "Every dashboard account as of generation time. Administrators hold every permission; built-in user and viewer roles hold none (their own profile and API tokens only).",
        columns([
          ["id", "Id"],
          ["email", "E-mail"],
          ["name", "Name"],
          ["username", "Username"],
          ["status", "Status"],
          ["role", "Role"],
          ["administrator", "Administrator"],
          ["permissions", "Permissions"],
          ["scopeTags", "Tag scope"],
          ["mfa", "MFA"],
          ["mfaRequiredByPolicy", "MFA required by policy"],
          ["passwordSignIn", "Password sign-in"],
          ["ssoIdentities", "Linked SSO identities"],
          ["breakGlass", "Break-glass account"],
          ["lastSignInAt", "Last sign-in (UTC)"],
          ["signInsInPeriod", "Sign-ins in period"],
          ["createdAt", "Created (UTC)"],
          ["apiTokens", "API tokens"],
          ["forwardAuthGroups", "Forward-auth groups"],
          ["forwardAuthHosts", "Direct forward-auth host access"],
          ["flags", "Flags"],
        ]),
        userTableRows
      ),
      section(
        "api_tokens",
        "API tokens",
        "Tokens act with their owner's current role. Shown by name and dates only; the token itself is never stored in readable form.",
        columns([
          ["id", "Id"],
          ["name", "Name"],
          ["owner", "Owner"],
          ["ownerId", "Owner id"],
          ["ownerStatus", "Owner status"],
          ["createdAt", "Created (UTC)"],
          ["expiresAt", "Expires (UTC)"],
          ["lastUsedAt", "Last used (UTC)"],
          ["flags", "Flags"],
        ]),
        tokenRows
      ),
      section(
        "custom_roles",
        "Custom roles",
        "Roles with chosen permissions, optionally limited to hosts carrying one of their tags.",
        columns([
          ["id", "Id"],
          ["name", "Name"],
          ["description", "Description"],
          ["permissions", "Permissions"],
          ["scopeTags", "Tag scope"],
          ["administratorLevel", "Administrator-level"],
          ["users", "Users"],
        ]),
        roleRows
      ),
      section(
        "forward_auth_groups",
        "Forward-auth groups",
        "Groups used to grant access to hosts protected by the built-in forward auth.",
        columns([
          ["id", "Id"],
          ["name", "Name"],
          ["description", "Description"],
          ["memberCount", "Members"],
          ["members", "Member accounts"],
          ["hosts", "Hosts the group can access"],
        ]),
        groupRows
      ),
      keyValueSection("policies", "Sign-in policies", "As of generation time.", [
        ["MFA policy", mfaPolicy.scope === "off" ? "off" : mfaPolicy.scope === "admins" ? "required for administrators and custom roles" : "required for every account with a password"],
        ["MFA grace period (days)", mfaPolicy.scope === "off" ? null : mfaPolicy.graceDays],
        ["MFA enrolment deadline (UTC)", iso(deadline)],
        ["SSO enforced (password sign-in off except break-glass accounts)", sso.enabled],
        ["Break-glass accounts", sso.enabled ? sso.breakGlassUserIds.length : 0],
        ["Permissions in the catalogue", PERMISSIONS.length],
      ]),
      auditEventSection(
        "access_changes",
        "Access changes in the period",
        "Audit events that changed users, roles, MFA, groups, forward-auth access, SSO or the MFA policy.",
        changes,
        MAX_ACCESS_CHANGES
      ),
    ],
    notes: [
      `Last sign-in is the latest of the recorded dashboard sign-ins (audit log) and dashboard sessions; sign-ins older than the audit log's retention are not visible. Accounts are flagged as inactive after ${INACTIVE_DAYS} days without a recorded sign-in, counted from creation when none is recorded.`,
      `API tokens are flagged when unused for more than ${TOKEN_UNUSED_DAYS} days (last use is recorded at most once a minute). Tokens of disabled accounts stop working and are not flagged.`,
      "Users, roles, tokens and groups are shown as of generation time; sign-ins and access changes cover the report period.",
    ],
  };
}
