// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import {
  parseSsoEnforcementInput,
  updateSsoEnforcement,
  type SsoEnforcementView,
} from "@/ee/sso/enforcement";

export type SsoEnforcementActionResult = { ok: true; view: SsoEnforcementView } | { ok: false; error: string };

export async function saveSsoEnforcementAction(input: unknown): Promise<SsoEnforcementActionResult> {
  const session = await requirePermission("sso:write");
  try {
    const view = await updateSsoEnforcement(parseSsoEnforcementInput(input), Number(session.user.id));
    revalidatePath("/sso");
    revalidatePath("/sign-in");
    return { ok: true, view };
  } catch (error) {
    if (error instanceof ApiClientError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
