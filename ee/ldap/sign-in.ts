// SPDX-License-Identifier: Elastic-2.0
/**
 * Directory sign-in after the directory accepted the password: which local
 * account it signs in, linking and provisioning, and the role the group
 * mapping gives. Called from the Better Auth endpoint (plugin.ts), which
 * creates the session the standard way afterwards. Never checks the license.
 *
 * Local account, in this order:
 *  1. The account already linked to the entry's stable unique id in this
 *     directory (accounts row "ldap:<id>" / unique id; never the DN, which
 *     changes when an entry is renamed or moved).
 *  2. An existing account whose e-mail address is exactly the entry's
 *     (compared without case, as everywhere), only when the directory allows
 *     linking. Refused for the primary admin and break-glass accounts, for
 *     administrators and custom-role users (an e-mail match must not hand
 *     over privileges), for a disabled account, and for one already linked to
 *     another entry of the directory.
 *  3. A new account, only when the directory provisions users and the entry
 *     has an e-mail address. Created through Better Auth, so its user hooks
 *     run (sign-in name rules, enforceSafeUserDefaults).
 * Otherwise the sign-in is refused like a wrong password.
 *
 * Roles: when the directory has group mappings, every sign-in sets the role
 * the mapping gives (demoting as well as promoting, and taking away a custom
 * role), except for the primary admin and break-glass accounts, which a
 * directory never changes, and except a demotion that would leave no active
 * administrator. Username and e-mail are never derived: a new account gets
 * the entry's e-mail address and display name exactly as returned.
 */
import { and, eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { accounts, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { setUserRoleAssignment } from "@/src/lib/models/user";
import { LAST_ADMIN_MESSAGE, assertActiveAdminRemains } from "@/ee/custom-roles/escalation";
import { ldapProviderId, type LdapRole } from "./constants";
import { protectedUserIds, type DirectoryReader } from "./identity";
import { resolveDirectoryRole, type RoleDecision } from "./roles";
import type { DirectoryConfig, DirectoryUser } from "./types";
import { first } from "@/src/lib/db/ops";

export type RefusalReason =
  | "not_in_required_group"
  | "not_provisioned"
  | "no_email"
  | "email_in_use"
  | "protected_account"
  | "privileged_account"
  | "account_disabled"
  | "already_linked"
  | "linked_user_missing"
  | "provisioning_failed"
  | "linking_failed"
  | "role_update_failed";

export const REFUSAL_DESCRIPTIONS: Record<RefusalReason, string> = {
  not_in_required_group: "the user is not in the required group",
  not_provisioned: "no account is linked and the directory does not create accounts",
  no_email: "the entry has no e-mail address to create an account with",
  email_in_use: "an account with this e-mail address exists and the directory does not link existing accounts",
  protected_account: "the account with this e-mail address is the primary admin or a break-glass account, which a directory never links",
  privileged_account: "the account with this e-mail address is an administrator or has a custom role, which a directory never links",
  account_disabled: "the account is disabled",
  already_linked: "the account with this e-mail address is linked to another entry of this directory",
  linked_user_missing: "the linked account no longer exists",
  provisioning_failed: "the account could not be created",
  linking_failed: "the account could not be linked",
  role_update_failed: "the role from the group mapping could not be applied",
};

export type LocalAccountPlan =
  | { action: "existing"; userId: number }
  | { action: "link"; userId: number }
  | { action: "provision" }
  | { action: "refuse"; reason: RefusalReason; userId?: number };

/** Decides which local account a directory user signs in to; reads only. */
export async function planLocalAccount(reader: DirectoryReader, config: DirectoryConfig, user: DirectoryUser): Promise<LocalAccountPlan> {
  const providerId = ldapProviderId(config.id);
  const linked = await first(reader
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.providerId, providerId), eq(accounts.accountId, user.uniqueId)))
    .limit(1));
  if (linked) {
    const exists = await first(reader.select({ id: users.id }).from(users).where(eq(users.id, linked.userId)).limit(1));
    return exists ? { action: "existing", userId: linked.userId } : { action: "refuse", reason: "linked_user_missing" };
  }

  if (user.email) {
    const owner = await first(reader
      .select({ id: users.id, status: users.status, role: users.role, customRoleId: users.customRoleId, organizationId: users.organizationId })
      .from(users)
      .where(eq(users.email, user.email.toLowerCase()))
      .limit(1));
    if (owner) {
      if (!config.linkExistingAccounts) return { action: "refuse", reason: "email_in_use", userId: owner.id };
      if ((await protectedUserIds(reader)).has(owner.id)) return { action: "refuse", reason: "protected_account", userId: owner.id };
      // An e-mail match never hands an account's privileges to a directory
      // entry: whoever can set that address in the directory would get them.
      // Nor an organisation's account (ee/multi-tenancy): the directory is the provider's.
      if (owner.role === "admin" || owner.customRoleId !== null || owner.organizationId !== null) {
        return { action: "refuse", reason: "privileged_account", userId: owner.id };
      }
      if (owner.status !== "active") return { action: "refuse", reason: "account_disabled", userId: owner.id };
      const other = await first(reader
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.userId, owner.id), eq(accounts.providerId, providerId)))
        .limit(1));
      if (other) return { action: "refuse", reason: "already_linked", userId: owner.id };
      return { action: "link", userId: owner.id };
    }
  }

  if (!config.provisionUsers) return { action: "refuse", reason: "not_provisioned" };
  if (!user.email) return { action: "refuse", reason: "no_email" };
  return { action: "provision" };
}

/** What Better Auth's internal adapter offers for creating and linking accounts (so its hooks run). */
export type AccountAdapter = {
  createOAuthUser(
    user: Record<string, unknown>,
    account: Record<string, unknown>
  ): Promise<{ user: { id: string | number } } | null | undefined>;
  linkAccount(account: Record<string, unknown>): Promise<unknown>;
};

export type CompletedSignIn =
  | { ok: true; userId: number; created: boolean; linked: boolean; role: LdapRole | null }
  | { ok: false; reason: RefusalReason; userId: number | null };

function refusal(reason: RefusalReason, userId: number | null = null): CompletedSignIn {
  return { ok: false, reason, userId };
}

/** Records a sign-in refused after the directory accepted the password. Wrong passwords are not recorded. */
export async function auditRefusedSignIn(
  config: Pick<DirectoryConfig, "id" | "name">,
  user: Pick<DirectoryUser, "dn" | "username"> | null,
  reason: string,
  userId: number | null
): Promise<void> {
  await logAuditEvent({
    userId,
    action: "ldap_sign_in_refused",
    entityType: "ldap_directory",
    entityId: config.id,
    summary: `Directory sign-in through "${config.name}" refused: ${reason}`,
    data: { directoryId: config.id, username: user?.username ?? null, dn: user?.dn ?? null, reason },
  });
}

/**
 * Applies the role the group mapping gives. Returns false when it could not
 * be applied (the sign-in is then refused rather than signed in with a role
 * the directory no longer grants).
 */
async function applyRole(config: DirectoryConfig, userId: number, role: LdapRole, decision: RoleDecision): Promise<boolean> {
  const current = await first(appDb
    .select({ role: users.role, customRoleId: users.customRoleId, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1));
  if (!current) return false;
  if (current.role === role && current.customRoleId === null) return true;
  try {
    await setUserRoleAssignment(userId, { role, customRoleId: null }, async (tx) => {
      await assertActiveAdminRemains(tx, { userId, role });
    });
  } catch (error) {
    // The last active administrator keeps the role; anything else refuses the sign-in.
    const lastAdmin = error instanceof Error && error.message === LAST_ADMIN_MESSAGE;
    await logAuditEvent({
      userId,
      action: "ldap_role_change_skipped",
      entityType: "user",
      entityId: userId,
      summary: `Directory "${config.name}" did not change the role of ${current.email} to ${role}: ${
        lastAdmin ? "it is the last active administrator" : "the change failed"
      }`,
      data: { directoryId: config.id, from: current.role, to: role },
    });
    return lastAdmin;
  }
  await logAuditEvent({
    userId,
    action: "ldap_role_changed",
    entityType: "user",
    entityId: userId,
    summary: `Directory "${config.name}" changed the role of ${current.email} from ${current.role}${
      current.customRoleId !== null ? " (custom role)" : ""
    } to ${role}`,
    data: { directoryId: config.id, from: current.role, fromCustomRoleId: current.customRoleId, to: role, groups: decision.matchedGroups },
  });
  return true;
}

/**
 * Resolves, links or creates the local account for a directory user the
 * directory authenticated, and applies the role. The caller creates the
 * session afterwards (which also refuses a disabled account).
 */
export async function completeDirectorySignIn(
  config: DirectoryConfig,
  user: DirectoryUser,
  adapter: AccountAdapter
): Promise<CompletedSignIn> {
  const decision = resolveDirectoryRole(config, user.groups);
  if (!decision.inRequiredGroup) return refusal("not_in_required_group");

  const plan = await planLocalAccount(appDb, config, user);
  if (plan.action === "refuse") return refusal(plan.reason, plan.userId ?? null);

  const providerId = ldapProviderId(config.id);
  let userId: number;
  let created = false;
  let linked = false;
  if (plan.action === "provision") {
    try {
      const result = await adapter.createOAuthUser(
        { email: user.email, name: user.displayName ?? "", emailVerified: false },
        { providerId, accountId: user.uniqueId }
      );
      userId = Number(result?.user?.id);
      if (!Number.isSafeInteger(userId) || userId < 1) return refusal("provisioning_failed");
    } catch (error) {
      console.warn(`[ldap] Creating an account for ${user.dn} failed:`, error instanceof Error ? error.message : error);
      return refusal("provisioning_failed");
    }
    created = true;
    await logAuditEvent({
      userId,
      action: "ldap_user_provisioned",
      entityType: "user",
      entityId: userId,
      summary: `Created an account for ${user.username} at first sign-in through directory "${config.name}"`,
      data: { directoryId: config.id, dn: user.dn, uniqueId: user.uniqueId },
    });
  } else if (plan.action === "link") {
    userId = plan.userId;
    try {
      await adapter.linkAccount({ userId, providerId, accountId: user.uniqueId });
    } catch (error) {
      console.warn(`[ldap] Linking ${user.dn} to user ${userId} failed:`, error instanceof Error ? error.message : error);
      return refusal("linking_failed", userId);
    }
    linked = true;
    await logAuditEvent({
      userId,
      action: "ldap_account_linked",
      entityType: "user",
      entityId: userId,
      summary: `Linked the existing account with the same e-mail address to ${user.username} in directory "${config.name}"`,
      data: { directoryId: config.id, dn: user.dn, uniqueId: user.uniqueId },
    });
  } else {
    userId = plan.userId;
  }

  const row = await first(appDb.select({ status: users.status, name: users.name }).from(users).where(eq(users.id, userId)).limit(1));
  if (!row) return refusal("linked_user_missing");
  if (row.status !== "active") return refusal("account_disabled", userId);

  let role: LdapRole | null = null;
  // Organisation users (ee/multi-tenancy) keep the role their organisation gives them.
  const isProtected =
    (await protectedUserIds(appDb)).has(userId) ||
    ((await first(appDb.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, userId)).limit(1)))?.organizationId ?? null) !== null;
  if (!isProtected && (decision.managesRoles || created)) {
    role = decision.role;
    if (!(await applyRole(config, userId, role, decision))) return refusal("role_update_failed", userId);
  }

  // The display name follows the directory; the e-mail address stays what it was when the account was linked or created.
  if (!isProtected && user.displayName && user.displayName !== row.name) {
    await appDb.update(users).set({ name: user.displayName, updatedAt: nowIso() }).where(eq(users.id, userId));
  }

  return { ok: true, userId, created, linked, role };
}
