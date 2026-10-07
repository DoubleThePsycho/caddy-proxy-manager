// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { saveDigestSettings } from "@/ee/ai/digest-settings";
import { previewDigest, sendDigestNow } from "@/ee/ai/digest";
import type { DigestPreview, DigestSendResult } from "@/ee/ai/types";

export type DigestActionResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

/** Runs a digest action for a user with ai:write; client-safe errors come back as { ok: false }. */
async function run<T>(operation: (userId: number) => Promise<T>): Promise<DigestActionResult<T>> {
  const session = await requirePermission("ai:write");
  try {
    const value = await operation(Number(session.user.id));
    revalidatePath("/alerts");
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveDigestSettingsAction(input: unknown): Promise<DigestActionResult> {
  return run(async (userId) => {
    await saveDigestSettings(input, userId);
    return undefined;
  });
}

export async function previewDigestAction(ai: boolean): Promise<DigestActionResult<DigestPreview>> {
  return run((userId) => previewDigest({ ai }, userId));
}

export async function sendDigestAction(): Promise<DigestActionResult<DigestSendResult>> {
  return run((userId) => sendDigestNow(userId));
}
