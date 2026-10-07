// SPDX-License-Identifier: Elastic-2.0
/**
 * Linking a SCIM user's first SSO sign-in to the account SCIM provisioned.
 *
 * A SCIM user has no password and no linked identity. Better Auth signs an
 * OAuth/OIDC identity in by finding the account with the same e-mail
 * address, and links it only when the provider is trusted (its "Auto-link
 * accounts" switch) or reports the address as verified. For a provider
 * without auto-link, src/lib/auth-server.ts reports the address as verified
 * only when canLinkScimSignIn agrees. A SAML provider ("saml:<id>",
 * ee/saml/sign-in.ts) asks the same question, with the assertion's
 * attributes (first values) as the claims. canLinkScimSignIn needs every
 * one of:
 *
 *  - the sign-in comes through the provider chosen in the SCIM settings;
 *  - the e-mail address the provider asserts (exactly, apart from case) is
 *    the address of an active account that SCIM manages (scim_users; never a
 *    local account SCIM was not given, never the primary admin or a
 *    break-glass account);
 *  - that account has no identity of this provider linked yet (later
 *    sign-ins use the linked identity, and a second identity with the same
 *    address is refused);
 *  - with externalIdClaim set, the claim of that name equals the account's
 *    SCIM externalId exactly (e.g. Okta "sub", Entra ID "oid" with externalId
 *    mapped to the object id); otherwise, with requireVerifiedEmail (the
 *    default), the provider's email_verified claim is true.
 *
 * Nothing is derived: the comparison is between values the identity
 * provider sent through SCIM and through sign-in. An account an
 * administrator handed to SCIM ("adopted") is linkable the same way; handing
 * it to SCIM is the administrator's explicit permission. Reads only;
 * synchronous.
 */
import { and, eq, isNull } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { accounts, scimUsers, users } from "@/src/lib/db/schema";
import { logAuditEvent } from "@/src/lib/audit";
import { isProtectedUser, readScimSettings, type ScimReader } from "./store";
import { first, recoverable } from "@/src/lib/db/ops";

function claimIsTrue(value: unknown): boolean {
  return value === true || value === "true";
}

export async function canLinkScimSignIn(
  providerId: string,
  profile: Record<string, unknown>,
  reader: ScimReader = appDb
): Promise<boolean> {
  try {
    // Inside a transaction, in a savepoint of its own: a failed read answers
    // false without ending the transaction (PostgreSQL aborts it otherwise).
    return await recoverable(async () => await scimSignInLinkable(providerId, profile, reader));
  } catch (error) {
    // Fail closed: no link.
    console.warn("[scim] Could not check SCIM sign-in linking:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}

async function scimSignInLinkable(providerId: string, profile: Record<string, unknown>, reader: ScimReader): Promise<boolean> {
  const settings = await readScimSettings(reader);
  if (!settings.providerId || settings.providerId !== providerId) return false;
  if (typeof profile.email !== "string" || !profile.email.trim()) return false;
  const email = profile.email.trim().toLowerCase();
  const row = await first(reader
    .select({ userId: users.id, status: users.status, externalId: scimUsers.externalId })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(and(eq(users.email, email), isNull(scimUsers.deletedAt)))
    .limit(1));
  if (!row || row.status !== "active" || await isProtectedUser(reader, row.userId)) return false;
  const linked = await first(reader
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, row.userId), eq(accounts.providerId, providerId)))
    .limit(1));
  if (linked) return false;
  if (settings.externalIdClaim) {
    const claim = profile[settings.externalIdClaim];
    return typeof claim === "string" && claim.length > 0 && row.externalId !== null && claim === row.externalId;
  }
  if (settings.requireVerifiedEmail) {
    return claimIsTrue(profile.email_verified ?? profile.emailVerified);
  }
  return true;
}

/**
 * Records the first link of a SCIM user's identity through the SCIM sign-in
 * provider. Called from Better Auth's account-creation hook; bookkeeping only.
 */
export async function noteScimSignInLink(userId: number, providerId: string): Promise<void> {
  const settings = await readScimSettings(appDb);
  if (settings.providerId !== providerId) return;
  const row = await first(appDb
    .select({ id: scimUsers.id, userName: scimUsers.userName, linkedAt: scimUsers.linkedAt })
    .from(scimUsers)
    .where(eq(scimUsers.userId, userId))
    .limit(1));
  if (!row || row.linkedAt) return;
  // Only the first link is recorded: the update matches nothing once another one set it.
  const linked = await appDb
    .update(scimUsers)
    .set({ linkedAt: nowIso() })
    .where(and(eq(scimUsers.id, row.id), isNull(scimUsers.linkedAt)))
    .returning({ id: scimUsers.id });
  if (linked.length === 0) return;
  await logAuditEvent({
    userId,
    action: "scim_sso_link",
    entityType: "user",
    entityId: userId,
    summary: `Linked the first sign-in through provider ${providerId} to SCIM user ${userId}`,
    data: { providerId, userName: row.userName },
  });
}
