// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { getLicenseState, installLicenseKey, removeLicenseKey } from "@/ee/licensing/store";
import { afterLicenseInstalled, getLicenseView } from "@/ee/licensing/online-check";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "license:read");
    return NextResponse.json(await getLicenseView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "license:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    const key = (body as { key?: unknown } | null)?.key;
    if (typeof body !== "object" || body === null || typeof key !== "string" || key.trim().length === 0) {
      throw new ApiValidationError("Body must be {\"key\": \"<license key>\"}");
    }
    const state = await installLicenseKey(key);
    await logAuditEvent({
      userId,
      action: "license_installed",
      entityType: "license",
      summary: `Installed ${state.license?.edition} license ${state.license?.id} for ${state.license?.customer}`,
      data: { licenseId: state.license?.id, edition: state.license?.edition, expiresAt: state.license?.exp },
    });
    await afterLicenseInstalled(state, { actorUserId: userId });
    return NextResponse.json(await getLicenseView(), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "license:write");
    const previous = await getLicenseState();
    await removeLicenseKey();
    await logAuditEvent({
      userId,
      action: "license_removed",
      entityType: "license",
      summary: previous.license ? `Removed license ${previous.license.id}` : "Removed license key",
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
