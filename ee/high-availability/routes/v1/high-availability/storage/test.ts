// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE, readOptionalJson, storageErrorResponse } from "@/ee/high-availability/http";
import { testCertificateStorage } from "@/ee/high-availability/service";

/** Tests the storage in effect, or the Redis settings in the body, from this instance. Changes nothing. */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "high_availability:write");
    return NextResponse.json(await testCertificateStorage(await readOptionalJson(request), userId), { headers: NO_STORE });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
