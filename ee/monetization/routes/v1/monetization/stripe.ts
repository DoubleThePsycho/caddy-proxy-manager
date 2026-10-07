// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody } from "@/ee/monetization/http";
import { getStripeSettingsView, removeStripeSettings, saveStripeSettings } from "@/ee/monetization/payments";

/** The secret key and webhook signing secret are never returned (hasSecretKey, hasWebhookSecret). */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    return NextResponse.json(await getStripeSettingsView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:payments");
    return NextResponse.json(await saveStripeSettings(await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Removes the Stripe keys (top-ups stop). */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:payments");
    return NextResponse.json(await removeStripeSettings(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
