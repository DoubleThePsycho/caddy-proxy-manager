// SPDX-License-Identifier: Elastic-2.0
/**
 * SCIM provisioning: the stored settings and the checks the request path
 * uses.
 *
 * Everything here takes a database reader or writer (the database or a
 * transaction on it), so a check and the write it guards share one
 * transaction. Nothing here looks at the license:
 * SCIM requests, linking at sign-in and role mappings keep working without
 * one.
 */
import { eq } from "drizzle-orm";
import { nowIso } from "@/src/lib/db";
import { settings } from "@/src/lib/db/schema";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import {
  DEFAULT_SCIM_SETTINGS,
  SCIM_DEFAULT_ROLES,
  SCIM_DELETE_MODES,
  type ScimSettings,
} from "./types";
import { first } from "@/src/lib/db/ops";
import type { AppTx } from "@/src/lib/db/types";

export const SCIM_SETTINGS_KEY = "scim";

/** The primary admin (src/lib/init-db.ts) always has this id. */
export const PRIMARY_ADMIN_USER_ID = 1;

/** The database or a transaction on it, for reads. */
export type ScimReader = Pick<AppTx, "select">;

/** The database or a transaction on it, for reads and writes. */
export type ScimWriter = Pick<AppTx, "select" | "insert" | "update" | "delete">;

/**
 * The stored value as settings. No row, or one that is not a JSON object
 * (only editing the database by hand makes one), means the defaults: SCIM
 * off, no sign-in provider.
 */
export function parseScimSettings(raw: string | null | undefined): ScimSettings {
  if (!raw) return { ...DEFAULT_SCIM_SETTINGS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SCIM_SETTINGS };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SCIM_SETTINGS };
  const record = value as Record<string, unknown>;
  const text = (input: unknown) => (typeof input === "string" && input.length > 0 ? input : null);
  return {
    enabled: record.enabled === true,
    providerId: text(record.providerId),
    deleteMode: (SCIM_DELETE_MODES as readonly unknown[]).includes(record.deleteMode)
      ? (record.deleteMode as ScimSettings["deleteMode"])
      : DEFAULT_SCIM_SETTINGS.deleteMode,
    defaultRole: (SCIM_DEFAULT_ROLES as readonly unknown[]).includes(record.defaultRole)
      ? (record.defaultRole as ScimSettings["defaultRole"])
      : DEFAULT_SCIM_SETTINGS.defaultRole,
    manageRoles: record.manageRoles === true,
    // Anything but an explicit false keeps the stricter check.
    requireVerifiedEmail: record.requireVerifiedEmail !== false,
    externalIdClaim: text(record.externalIdClaim),
  };
}

export async function readScimSettings(reader: ScimReader): Promise<ScimSettings> {
  const row = await first(reader
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SCIM_SETTINGS_KEY))
    .limit(1));
  return parseScimSettings(row?.value);
}

export async function writeScimSettings(writer: ScimWriter, value: ScimSettings): Promise<void> {
  const serialized = JSON.stringify(value);
  const now = nowIso();
  await writer
    .insert(settings)
    .values({ key: SCIM_SETTINGS_KEY, value: serialized, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized, updatedAt: now } });
}

/**
 * Accounts SCIM can never change, whatever an identity provider sends: the
 * primary admin (the environment's recovery account) and every break-glass
 * account of enforced SSO, whether enforcement is on or not. They cannot be
 * handed to SCIM either.
 */
export async function isProtectedUser(reader: ScimReader, userId: number): Promise<boolean> {
  if (userId === PRIMARY_ADMIN_USER_ID) return true;
  return (await readSsoEnforcement(reader)).breakGlassUserIds.includes(userId);
}

/** SCIM userNames are compared without case (RFC 7643 section 4.1.1). */
export function userNameKey(userName: string): string {
  return userName.normalize("NFC").toLowerCase();
}
