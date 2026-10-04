import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listSyncKeyPinsWithSlaves, pinSyncKey, resetSyncKeyPin } from "@/src/lib/models/instances";

/** The sync key pins this master holds, by slave URL, with the slaves they apply to. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "instances:read");
    return NextResponse.json(await listSyncKeyPinsWithSlaves());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function requiredUrl(request: NextRequest): string | NextResponse {
  const url = request.nextUrl.searchParams.get("url")?.trim();
  return url || NextResponse.json({ error: "The url query parameter is required" }, { status: 400 });
}

/**
 * Pin `{ publicKey }` for the slave at `?url=`, for INSTANCE_SLAVES entries
 * and slaves not added yet (instances can also use
 * /api/v1/instances/{id}/sync-key-pin).
 */
export async function PUT(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "instances:write");
    const url = requiredUrl(request);
    if (url instanceof NextResponse) return url;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const publicKey = (body as { publicKey?: unknown } | null)?.publicKey;
    return NextResponse.json(await pinSyncKey(url, publicKey, userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Reset the sync key pin of the slave at `?url=`, for INSTANCE_SLAVES entries
 * (instances can also use /api/v1/instances/{id}/sync-key-pin).
 */
export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "instances:write");
    const url = requiredUrl(request);
    if (url instanceof NextResponse) return url;
    await resetSyncKeyPin(url, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
