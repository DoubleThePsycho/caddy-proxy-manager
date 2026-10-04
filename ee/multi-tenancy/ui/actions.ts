// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requirePermission } from "@/src/lib/auth";
import { formatOrganizationView, ORGANIZATION_VIEW_COOKIE, parseOrganizationView } from "@/ee/multi-tenancy/view";

/**
 * The organisation switcher: which organisation the dashboard shows a
 * provider-level user ("all", "provider" or an organisation id). A view
 * only; it grants nothing (ee/multi-tenancy/view.ts).
 */
export async function setOrganizationViewAction(value: string): Promise<void> {
  await requirePermission("organizations:read");
  const view = parseOrganizationView(typeof value === "string" ? value : "");
  // A display preference, not a credential: it also works on plain-HTTP installs.
  (await cookies()).set(ORGANIZATION_VIEW_COOKIE, formatOrganizationView(view), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
}
