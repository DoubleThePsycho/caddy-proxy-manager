/**
 * Passkeys (WebAuthn) for dashboard sign-in: what an account has, renaming
 * and removing them, and who may add one. The ceremonies themselves are
 * Better Auth's passkey plugin (@better-auth/passkey), configured in
 * src/lib/passkey-auth.ts; this module only reads and changes the rows it
 * stores. A passkey row holds a public key, never a secret.
 *
 * Rules (documentation/mfa.md has them for users):
 *  - Only an account with a local password can add a passkey: a passkey
 *    replaces the password and its second factor, so an account that signs
 *    in through an identity provider or a directory keeps doing so, and the
 *    provider or directory keeps deciding who gets in.
 *  - While SSO is enforced (ee/sso) only break-glass accounts can add one,
 *    and only they can sign in with one.
 *  - A passkey checks the person (user verification: PIN or biometrics), so
 *    it counts as multi-factor authentication for the MFA policy.
 *  - The last second factor of an account the policy covers cannot be
 *    removed.
 *
 * Passkeys are per dashboard, like users: not synced to slaves.
 */
import { and, count, eq } from "drizzle-orm";
import { getAuthenticatorName } from "@better-auth/passkey";
import { appDb } from "./db";
import { passkeys, users } from "./db/schema";
import { ApiClientError, ApiValidationError } from "./api-errors";
import { logAuditEvent } from "./audit";
import { hasPasswordCredential, isMfaRequiredFor, type MfaReader } from "./mfa";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { first, recoverable } from "@/src/lib/db/ops";

/** The most passkeys one account can have. */
export const MAX_PASSKEYS_PER_USER = 10;
export const MAX_PASSKEY_NAME_LENGTH = 64;

export type PasskeyView = {
  id: number;
  /** The name the user gave it, or one derived from the authenticator. */
  name: string;
  /** The authenticator model when it is known (from its AAGUID), e.g. "1Password". */
  authenticator: string | null;
  /** singleDevice (a security key) or multiDevice (synced, such as a password manager). */
  deviceType: string;
  backedUp: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
};

type PasskeyRow = typeof passkeys.$inferSelect;

function toView(row: PasskeyRow): PasskeyView {
  const authenticator = getAuthenticatorName(row.aaguid ?? undefined) ?? null;
  return {
    id: row.id,
    name: row.name?.trim() || authenticator || (row.deviceType === "singleDevice" ? "Security key" : "Passkey"),
    authenticator,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
  };
}

/** An account's passkeys, oldest first. Never returns the public key or the credential id. */
export async function listPasskeys(userId: number, reader: MfaReader = appDb): Promise<PasskeyView[]> {
  return (await reader
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, userId)))
    .sort((a, b) => a.id - b.id)
    .map(toView);
}

export async function countPasskeys(userId: number, reader: MfaReader = appDb): Promise<number> {
  return (await first(reader.select({ value: count() }).from(passkeys).where(eq(passkeys.userId, userId)).limit(1)))?.value ?? 0;
}

/** Whether any account has a passkey: the login page offers passkey sign-in only then. */
export async function anyPasskeyExists(reader: MfaReader = appDb): Promise<boolean> {
  return !!await first(reader.select({ id: passkeys.id }).from(passkeys).limit(1));
}

/** Why `userId` cannot add a passkey now, or null when it can. */
export async function passkeyRegistrationBlocker(userId: number, reader: MfaReader = appDb): Promise<string | null> {
  const user = await first(reader.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1));
  if (!user || user.status !== "active") return "Your account cannot add a passkey.";
  if (!await hasPasswordCredential(reader, userId)) {
    return "Only accounts with a password can add a passkey. Accounts that sign in through an identity provider or a directory keep signing in there.";
  }
  const sso = await readSsoEnforcement(reader);
  if (sso.enabled && !sso.breakGlassUserIds.includes(userId)) {
    return "Single sign-on is enforced, so only break-glass accounts can add a passkey.";
  }
  if (await countPasskeys(userId, reader) >= MAX_PASSKEYS_PER_USER) {
    return `An account can have at most ${MAX_PASSKEYS_PER_USER} passkeys. Remove one to add another.`;
  }
  return null;
}

/** Reads a passkey name from a request body: trimmed, 1 to 64 characters, no control characters. */
export function parsePasskeyName(value: unknown): string {
  if (typeof value !== "string") throw new ApiValidationError("name must be a string");
  const name = value.trim();
  if (!name) throw new ApiValidationError("name must not be empty");
  if (name.length > MAX_PASSKEY_NAME_LENGTH) {
    throw new ApiValidationError(`name must be ${MAX_PASSKEY_NAME_LENGTH} characters or fewer`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ApiValidationError("name must not contain control characters");
  return name;
}

async function requireOwnPasskey(userId: number, passkeyId: number): Promise<PasskeyRow> {
  const row = Number.isSafeInteger(passkeyId) && passkeyId > 0
    ? await first(appDb.select().from(passkeys).where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId))).limit(1))
    : undefined;
  // Another account's passkey is not found, like a missing one.
  if (!row) throw new ApiClientError("Passkey not found", 404);
  return row;
}

export async function renamePasskey(userId: number, passkeyId: number, rawName: unknown): Promise<PasskeyView> {
  const name = parsePasskeyName(rawName);
  return await appDb.transaction(async (tx) => {
    const row = await requireOwnPasskey(userId, passkeyId);
    const updated = await first(tx.update(passkeys).set({ name }).where(eq(passkeys.id, row.id)).returning());
    await logAuditEvent({
      userId,
      action: "passkey_renamed",
      entityType: "user",
      entityId: userId,
      summary: `Renamed a passkey to "${name}"`,
      data: { passkeyId: row.id },
    });
    return toView(updated ?? { ...row, name });
  }, { behavior: "immediate" });
}

export const LAST_SECOND_FACTOR_MESSAGE =
  "Your administrator requires multi-factor authentication for your account, and this is your last second factor. Set up an authenticator app or add another passkey first.";

/**
 * Removes one of the account's own passkeys. Refused when it is the account's
 * last second factor and the MFA policy covers the account.
 */
export async function removePasskey(userId: number, passkeyId: number): Promise<void> {
  await appDb.transaction(async (tx) => {
    const row = await first(tx.select().from(passkeys).where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId))).limit(1));
    if (!row) throw new ApiClientError("Passkey not found", 404);
    const totp = (await first(tx.select({ flag: users.twoFactorEnabled }).from(users).where(eq(users.id, userId)).limit(1)))?.flag === true;
    const remaining = ((await first(tx.select({ value: count() }).from(passkeys).where(eq(passkeys.userId, userId)).limit(1)))?.value ?? 0) - 1;
    if (!totp && remaining === 0 && await isMfaRequiredFor(tx, userId)) {
      throw new ApiValidationError(LAST_SECOND_FACTOR_MESSAGE);
    }
    await tx.delete(passkeys).where(eq(passkeys.id, row.id));
  });
  await logAuditEvent({
    userId,
    action: "passkey_removed",
    entityType: "user",
    entityId: userId,
    summary: "Removed a passkey",
    data: { passkeyId },
  });
}

/** Records that a passkey signed its account in (Better Auth stores only the counter). */
export async function markPasskeyUsed(credentialId: string, at: string = new Date().toISOString()): Promise<void> {
  try {
    await recoverable(async () => await appDb.update(passkeys).set({ lastUsedAt: at }).where(eq(passkeys.credentialID, credentialId)));
  } catch {
    // Bookkeeping only.
  }
}
