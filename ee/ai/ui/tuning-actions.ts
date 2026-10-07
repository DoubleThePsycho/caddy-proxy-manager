// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import {
  applyWafTuningSuggestion,
  dismissWafTuningSuggestion,
  generateWafTuningSuggestions,
  type ApplySuggestionResult,
} from "@/ee/ai/waf-tuning";
import type { WafTuningResult, WafTuningSuggestionView } from "@/ee/ai/types";

export type TuningActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs a tuning action for a user with waf:write; client-safe errors come back as { ok: false }. */
async function run<T>(operation: (userId: number) => Promise<T>, paths: string[]): Promise<TuningActionResult<T>> {
  const session = await requirePermission("waf:write");
  try {
    const value = await operation(Number(session.user.id));
    for (const path of paths) revalidatePath(path);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function generateTuningSuggestionsAction(explain: boolean): Promise<TuningActionResult<WafTuningResult>> {
  return run(() => generateWafTuningSuggestions({ explain }), ["/waf", "/security"]);
}

export async function applyTuningSuggestionAction(id: string): Promise<TuningActionResult<ApplySuggestionResult>> {
  return run((userId) => applyWafTuningSuggestion(id, userId), ["/waf", "/security", "/proxy-hosts"]);
}

export async function dismissTuningSuggestionAction(id: string): Promise<TuningActionResult<WafTuningSuggestionView>> {
  return run((userId) => dismissWafTuningSuggestion(id, userId), ["/waf", "/security"]);
}
