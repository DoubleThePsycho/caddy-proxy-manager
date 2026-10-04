"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import {
  getUsagePingView,
  resetUsagePingInstallId,
  setUsagePingEnabled,
  type UsagePingView,
} from "@/src/lib/usage-ping/store";

export type UsagePingActionResult = { ok: true; view: UsagePingView } | { ok: false; error: string };

async function settle(change: () => Promise<UsagePingView>): Promise<UsagePingActionResult> {
  try {
    const view = await change();
    revalidatePath("/settings");
    revalidatePath("/");
    return { ok: true, view };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Turn on or off, from Settings or the overview question. */
export async function setUsagePingEnabledAction(enabled: boolean): Promise<UsagePingActionResult> {
  const session = await requirePermission("settings:write");
  return settle(() => setUsagePingEnabled(enabled === true, Number(session.user.id)));
}

export async function resetUsagePingInstallIdAction(): Promise<UsagePingActionResult> {
  const session = await requirePermission("settings:write");
  return settle(() => resetUsagePingInstallId(Number(session.user.id)));
}

/** What would be sent, for the overview question's "See exactly what is sent". */
export async function previewUsagePingAction(): Promise<UsagePingView> {
  await requirePermission("settings:read");
  return getUsagePingView();
}
