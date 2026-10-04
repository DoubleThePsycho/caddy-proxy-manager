// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { MAX_LICENSE_BODY_BYTES } from "@/ee/licensing/http";
import { checkLicenseKey, getLicenseState, installLicenseKey, removeLicenseKey } from "@/ee/licensing/store";
import { toLicenseKeyCheck, type LicenseKeyCheck } from "@/ee/licensing/view";
import {
  checkLicenseServerNow,
  parseLicenseAutoUpdateInput,
  setLicenseAutoUpdate,
  type LicenseAutoUpdateView,
} from "@/ee/licensing/auto-update";

/**
 * The install form's first step: checks the key on this machine and says
 * what it grants. Stores nothing and changes nothing, so it is not audited.
 */
export async function verifyLicenseAction(key: string): Promise<{ ok: true; check: LicenseKeyCheck } | { error: string }> {
  await requirePermission("license:write");
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) {
    return { error: "Paste a license key or choose a key file" };
  }
  if (trimmed.length > MAX_LICENSE_BODY_BYTES) {
    return { error: "That is too long for a license key" };
  }
  const { state, installable, error } = checkLicenseKey(trimmed);
  return { ok: true, check: toLicenseKeyCheck(state, installable, error) };
}

export async function installLicenseAction(formData: FormData): Promise<{ ok: true } | { error: string }> {
  const session = await requirePermission("license:write");
  const key = String(formData.get("key") ?? "").trim();
  if (!key) {
    return { error: "Paste a license key" };
  }
  try {
    const state = await installLicenseKey(key);
    await logAuditEvent({
      userId: Number(session.user.id),
      action: "license_installed",
      entityType: "license",
      summary: `Installed ${state.license?.edition} license ${state.license?.id} for ${state.license?.customer}`,
      data: { licenseId: state.license?.id, edition: state.license?.edition, expiresAt: state.license?.exp },
    });
  } catch (error) {
    if (error instanceof ApiClientError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath("/license");
  return { ok: true };
}

export async function removeLicenseAction(): Promise<void> {
  const session = await requirePermission("license:write");
  const previous = await getLicenseState();
  await removeLicenseKey();
  await logAuditEvent({
    userId: Number(session.user.id),
    action: "license_removed",
    entityType: "license",
    summary: previous.license ? `Removed license ${previous.license.id}` : "Removed license key",
  });
  revalidatePath("/license");
}

export type LicenseAutoUpdateActionResult = { ok: true; view: LicenseAutoUpdateView } | { ok: false; error: string };

async function settleAutoUpdate(change: () => Promise<LicenseAutoUpdateView>): Promise<LicenseAutoUpdateActionResult> {
  try {
    const view = await change();
    revalidatePath("/license");
    return { ok: true, view };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * Turns automatic license updates on (with the license's refresh token, or
 * the one already stored for it) or off (the stored token is deleted).
 */
export async function setLicenseAutoUpdateAction(enabled: boolean, refreshToken?: string): Promise<LicenseAutoUpdateActionResult> {
  const session = await requirePermission("license:write");
  return settleAutoUpdate(async () => {
    const token = typeof refreshToken === "string" ? refreshToken.trim() : "";
    const input = parseLicenseAutoUpdateInput({ enabled: enabled === true, ...(token ? { refreshToken: token } : {}) });
    return setLicenseAutoUpdate(input, Number(session.user.id));
  });
}

/** "Check now": asks the license server for a renewed key outside the daily slot. */
export async function checkLicenseServerNowAction(): Promise<LicenseAutoUpdateActionResult> {
  const session = await requirePermission("license:write");
  return settleAutoUpdate(() => checkLicenseServerNow(Number(session.user.id)));
}
