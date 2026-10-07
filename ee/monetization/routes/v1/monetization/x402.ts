// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody } from "@/ee/monetization/http";
import { getX402SettingsView, removeX402Settings, saveX402Settings } from "@/ee/monetization/x402/settings";

/** x402 settings: on, price, network, the Stripe deposit address and the CDP credentials. The CDP key secret is never returned. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    return NextResponse.json(await getX402SettingsView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Where payments go (the Stripe deposit address, the CDP credentials): administrator-level, like the Stripe account. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:payments");
    return NextResponse.json(await saveX402Settings(await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Turns x402 off and removes the CDP key secret. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "monetization:payments");
    return NextResponse.json(await removeX402Settings(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
