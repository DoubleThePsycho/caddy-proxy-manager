// SPDX-License-Identifier: Elastic-2.0
/**
 * SAML sign-in after the response was verified: which local account it
 * signs in, linking and provisioning, and the role the group mapping gives.
 * Called from the assertion consumer service (plugin.ts) before any session
 * exists; the session is created the standard way afterwards. Never checks
 * the license. Mirrors directory sign-in (ee/ldap/sign-in.ts).
 *
 * The account id (accounts.accountId of "saml:<id>") is the NameID only when
 * its Format is persistent; otherwise the provider must name an attribute
 * holding an immutable id. It is never the e-mail address unless an
 * administrator explicitly chose the e-mail attribute as that attribute.
 *
 * Local account, in this order:
 *  1. The account already linked to the subject in this provider.
 *  2. An existing account with exactly the asserted e-mail address (compared
 *     without case, as everywhere): linked when SCIM provisioned it and
 *     chose this provider for sign-in (ee/scim/binding.ts), or when the
 *     provider allows linking. The latter never links the primary admin or
 *     a break-glass account, an administrator or a custom-role user (an
 *     e-mail match must not hand over privileges), a disabled account, or
 *     one already linked to another subject of the provider.
 *  3. A new account, only when the provider provisions users and the
 *     assertion has an e-mail address. Created through Better Auth, so its
 *     user hooks run (sign-in name rules, enforceSafeUserDefaults).
 * Otherwise the sign-in is refused.
 *
 * Roles: when the provider has group mappings, every sign-in sets the role
 * the mapping gives (demoting as well as promoting, and taking away a custom
 * role), except for the primary admin and break-glass accounts, which SAML
 * never changes, and except a demotion that would leave no active
 * administrator. All of it happens before the session is created: a sign-in
 * whose role cannot be applied gets no session. Username and e-mail are never
 * derived: a new account gets the asserted e-mail address and name exactly.
 */
import { and, eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { accounts, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { setUserRoleAssignment } from "@/src/lib/models/user";
import { LAST_ADMIN_MESSAGE, assertActiveAdminRemains } from "@/ee/custom-roles/escalation";
import { protectedUserIds } from "@/ee/ldap/identity";
import { canLinkScimSignIn } from "@/ee/scim/binding";
import { LIMITS, NAMEID_FORMAT_PERSISTENT, samlProviderId, type SamlRole } from "./constants";
import { resolveSamlRole, type SamlRoleDecision } from "./roles";
import type { SamlReader } from "./store";
import type { SamlAssertionIdentity, SamlProviderConfig } from "./types";
import { first } from "@/src/lib/db/ops";

export type RefusalReason =
  | "subject_unusable"
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
  subject_unusable:
    "the assertion has no usable account id (a persistent NameID, or exactly one value of the configured id attribute)",
  not_in_required_group: "the user is not in the required group",
  not_provisioned: "no account is linked and the provider does not create accounts",
  no_email: "the assertion has no e-mail address to create an account with",
  email_in_use: "an account with this e-mail address exists and the provider does not link existing accounts",
  protected_account: "the account with this e-mail address is the primary admin or a break-glass account, which SAML never links",
  privileged_account: "the account with this e-mail address is an administrator or has a custom role, which SAML never links",
  account_disabled: "the account is disabled",
  already_linked: "the account with this e-mail address is linked to another subject of this provider",
  linked_user_missing: "the linked account no longer exists",
  provisioning_failed: "the account could not be created",
  linking_failed: "the account could not be linked",
  role_update_failed: "the role from the group mapping could not be applied",
};

/** The user a verified assertion describes, read with the attributes the administrator chose. */
export type SamlUser = {
  /** The stable account id: accounts.accountId of the link. */
  subject: string;
  email: string | null;
  displayName: string | null;
  groups: string[];
  nameId: string | null;
  nameIdFormat: string | null;
  /** First value of every attribute, for SCIM linking on a claim. */
  claims: Record<string, string>;
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

function distinct(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * The account id, e-mail address, name and groups of a verified assertion.
 * Null when it has no usable account id.
 */
export function readSamlUser(
  config: Pick<SamlProviderConfig, "subjectAttribute" | "emailAttribute" | "nameAttribute" | "groupsAttribute">,
  identity: Pick<SamlAssertionIdentity, "nameId" | "nameIdFormat" | "attributes">
): SamlUser | null {
  let subject: string | null = null;
  if (config.subjectAttribute) {
    const values = distinct(identity.attributes.get(config.subjectAttribute) ?? []);
    if (values.length === 1) subject = values[0];
  } else if (identity.nameIdFormat === NAMEID_FORMAT_PERSISTENT && identity.nameId) {
    subject = identity.nameId;
  }
  if (!subject || subject.length > LIMITS.subject || CONTROL.test(subject)) return null;

  const email = (identity.attributes.get(config.emailAttribute) ?? [])
    .map((value) => value.trim())
    .find((value) => value.length <= LIMITS.email && EMAIL.test(value)) ?? null;
  const nameValue = config.nameAttribute ? (identity.attributes.get(config.nameAttribute) ?? [])[0]?.trim() : undefined;
  const displayName = nameValue && nameValue.length <= LIMITS.displayName && !CONTROL.test(nameValue) ? nameValue : null;
  const groups = config.groupsAttribute ? distinct(identity.attributes.get(config.groupsAttribute) ?? []) : [];

  const claims: Record<string, string> = {};
  for (const [name, values] of identity.attributes) {
    if (values[0] !== undefined) claims[name] = values[0];
  }
  return { subject, email, displayName, groups, nameId: identity.nameId, nameIdFormat: identity.nameIdFormat, claims };
}

export type LocalAccountPlan =
  | { action: "existing"; userId: number }
  | { action: "link"; userId: number; via: "email" | "scim" }
  | { action: "provision" }
  | { action: "refuse"; reason: RefusalReason; userId?: number };

/** Decides which local account a SAML user signs in to; reads only. */
export async function planLocalAccount(reader: SamlReader, config: SamlProviderConfig, user: SamlUser): Promise<LocalAccountPlan> {
  const providerId = samlProviderId(config.id);
  const linked = await first(reader
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.providerId, providerId), eq(accounts.accountId, user.subject)))
    .limit(1));
  if (linked) {
    const exists = await first(reader.select({ id: users.id }).from(users).where(eq(users.id, linked.userId)).limit(1));
    return exists ? { action: "existing", userId: linked.userId } : { action: "refuse", reason: "linked_user_missing" };
  }

  if (user.email) {
    const owner = await first(reader
      .select({ id: users.id, status: users.status, role: users.role, customRoleId: users.customRoleId })
      .from(users)
      .where(eq(users.email, user.email.toLowerCase()))
      .limit(1));
    if (owner) {
      // SCIM provisioned this account for exactly this provider (all checks in ee/scim/binding.ts).
      if (await canLinkScimSignIn(providerId, { ...user.claims, email: user.email })) {
        return { action: "link", userId: owner.id, via: "scim" };
      }
      if (!config.linkExistingAccounts) return { action: "refuse", reason: "email_in_use", userId: owner.id };
      if ((await protectedUserIds(reader)).has(owner.id)) return { action: "refuse", reason: "protected_account", userId: owner.id };
      // An e-mail match never hands an account's privileges to an IdP
      // identity: whoever can set that address at the IdP would get them.
      if (owner.role === "admin" || owner.customRoleId !== null) {
        return { action: "refuse", reason: "privileged_account", userId: owner.id };
      }
      if (owner.status !== "active") return { action: "refuse", reason: "account_disabled", userId: owner.id };
      const other = await first(reader
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.userId, owner.id), eq(accounts.providerId, providerId)))
        .limit(1));
      if (other) return { action: "refuse", reason: "already_linked", userId: owner.id };
      return { action: "link", userId: owner.id, via: "email" };
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
  | { ok: true; userId: number; created: boolean; linked: boolean; role: SamlRole | null }
  | { ok: false; reason: RefusalReason; userId: number | null };

function refusal(reason: RefusalReason, userId: number | null = null): CompletedSignIn {
  return { ok: false, reason, userId };
}

/** Records a SAML sign-in that was refused, with the reason (never shown to the browser). */
export async function auditRefusedSignIn(
  config: Pick<SamlProviderConfig, "id" | "name">,
  reason: string,
  userId: number | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  await logAuditEvent({
    userId,
    action: "saml_sign_in_refused",
    entityType: "saml_provider",
    entityId: config.id,
    summary: `SAML sign-in through "${config.name}" refused: ${reason}`,
    data: { providerId: config.id, reason, ...details },
  });
}

/**
 * Applies the role the group mapping gives. Returns false when it could not
 * be applied (the sign-in is then refused rather than signed in with a role
 * the identity provider no longer grants).
 */
async function applyRole(config: SamlProviderConfig, userId: number, role: SamlRole, decision: SamlRoleDecision): Promise<boolean> {
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
      action: "saml_role_change_skipped",
      entityType: "user",
      entityId: userId,
      summary: `SAML provider "${config.name}" did not change the role of ${current.email} to ${role}: ${
        lastAdmin ? "it is the last active administrator" : "the change failed"
      }`,
      data: { providerId: config.id, from: current.role, to: role },
    });
    return lastAdmin;
  }
  await logAuditEvent({
    userId,
    action: "saml_role_changed",
    entityType: "user",
    entityId: userId,
    summary: `SAML provider "${config.name}" changed the role of ${current.email} from ${current.role}${
      current.customRoleId !== null ? " (custom role)" : ""
    } to ${role}`,
    data: { providerId: config.id, from: current.role, fromCustomRoleId: current.customRoleId, to: role, groups: decision.matchedGroups },
  });
  return true;
}

/**
 * Resolves, links or creates the local account for a verified SAML user and
 * applies the role. The caller creates the session afterwards (which also
 * refuses a disabled account).
 */
export async function completeSamlSignIn(
  config: SamlProviderConfig,
  user: SamlUser,
  adapter: AccountAdapter
): Promise<CompletedSignIn> {
  const decision = resolveSamlRole(config, user.groups);
  if (!decision.inRequiredGroup) return refusal("not_in_required_group");

  const plan = await planLocalAccount(appDb, config, user);
  if (plan.action === "refuse") return refusal(plan.reason, plan.userId ?? null);

  const providerId = samlProviderId(config.id);
  let userId: number;
  let created = false;
  let linked = false;
  if (plan.action === "provision") {
    try {
      const result = await adapter.createOAuthUser(
        { email: user.email, name: user.displayName ?? "", emailVerified: false },
        { providerId, accountId: user.subject }
      );
      userId = Number(result?.user?.id);
      if (!Number.isSafeInteger(userId) || userId < 1) return refusal("provisioning_failed");
    } catch (error) {
      console.warn(`[saml] Creating an account through provider ${config.id} failed:`, error instanceof Error ? error.message : error);
      return refusal("provisioning_failed");
    }
    created = true;
    await logAuditEvent({
      userId,
      action: "saml_user_provisioned",
      entityType: "user",
      entityId: userId,
      summary: `Created an account for ${user.email} at first sign-in through SAML provider "${config.name}"`,
      data: { providerId: config.id, subject: user.subject },
    });
  } else if (plan.action === "link") {
    userId = plan.userId;
    try {
      await adapter.linkAccount({ userId, providerId, accountId: user.subject });
    } catch (error) {
      console.warn(`[saml] Linking user ${userId} through provider ${config.id} failed:`, error instanceof Error ? error.message : error);
      return refusal("linking_failed", userId);
    }
    linked = true;
    await logAuditEvent({
      userId,
      action: "saml_account_linked",
      entityType: "user",
      entityId: userId,
      summary: plan.via === "scim"
        ? `Linked the SCIM-provisioned account ${user.email} to its first sign-in through SAML provider "${config.name}"`
        : `Linked the existing account with the same e-mail address to SAML provider "${config.name}"`,
      data: { providerId: config.id, subject: user.subject, via: plan.via },
    });
  } else {
    userId = plan.userId;
  }

  const row = await first(appDb.select({ status: users.status, name: users.name }).from(users).where(eq(users.id, userId)).limit(1));
  if (!row) return refusal("linked_user_missing");
  if (row.status !== "active") return refusal("account_disabled", userId);

  let role: SamlRole | null = null;
  const isProtected = (await protectedUserIds(appDb)).has(userId);
  if (!isProtected && (decision.managesRoles || created)) {
    role = decision.role;
    if (!(await applyRole(config, userId, role, decision))) return refusal("role_update_failed", userId);
  }

  // The display name follows the IdP; the e-mail address stays what it was when the account was linked or created.
  if (!isProtected && user.displayName && user.displayName !== row.name) {
    await appDb.update(users).set({ name: user.displayName, updatedAt: nowIso() }).where(eq(users.id, userId));
  }

  return { ok: true, userId, created, linked, role };
}
