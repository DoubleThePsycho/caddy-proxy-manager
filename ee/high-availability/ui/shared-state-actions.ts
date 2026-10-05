// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { getSharedStateStatus, removeSharedState, saveSharedState, SharedStateChangeError } from "@/ee/high-availability/shared-state/service";
import type { SharedStateActionResult, SharedStateStatusActionResult } from "@/ee/high-availability/shared-state/types";

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof ApiClientError || error instanceof SharedStateChangeError) return { ok: false, error: error.message };
  throw error;
}

export async function saveSharedStateAction(input: unknown): Promise<SharedStateActionResult> {
  const session = await requirePermission("high_availability:write");
  try {
    const view = await saveSharedState(input, Number(session.user.id));
    revalidatePath("/high-availability");
    return { ok: true, view };
  } catch (error) {
    return failure(error);
  }
}

export async function removeSharedStateAction(): Promise<SharedStateActionResult> {
  const session = await requirePermission("high_availability:write");
  try {
    const view = await removeSharedState(Number(session.user.id));
    revalidatePath("/high-availability");
    return { ok: true, view };
  } catch (error) {
    return failure(error);
  }
}

export async function sharedStateStatusAction(): Promise<SharedStateStatusActionResult> {
  await requirePermission("high_availability:read");
  try {
    return { ok: true, status: await getSharedStateStatus() };
  } catch (error) {
    return failure(error);
  }
}
