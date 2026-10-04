// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { NO_STORE, storageErrorResponse } from "@/ee/high-availability/http";
import { getCertificateStorageView, removeCertificateStorage, saveCertificateStorage } from "@/ee/high-availability/service";

/** Where the Caddy nodes keep certificates. Readable without a license; secrets are never returned. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "high_availability:read");
    return NextResponse.json(await getCertificateStorageView(), { headers: NO_STORE });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

/** Sets or changes the storage. Enabling or changing shared storage needs the license; going back to local does not. */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "high_availability:write");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiValidationError("Request body must be JSON");
    }
    return NextResponse.json(await saveCertificateStorage(body, userId), { headers: NO_STORE });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

/** Back to local storage, forgetting the Redis settings. Never needs a license. */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "high_availability:write");
    return NextResponse.json(await removeCertificateStorage(userId), { headers: NO_STORE });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
