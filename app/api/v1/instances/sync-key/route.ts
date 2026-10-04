import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getSyncPublicKey } from "@/src/lib/sync-crypto";

/**
 * This instance's own sync key, the one it presents as a slave, so an admin
 * can compare it with the one a master pinned for it, or pin it there.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "instances:read");
    const { keyId, publicKey } = getSyncPublicKey();
    return NextResponse.json({ keyId, publicKey: publicKey.toString("base64") });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
