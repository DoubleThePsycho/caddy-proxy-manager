import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { removePasskey, renamePasskey } from "@/src/lib/passkeys";
import { parseRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

/** The passkey id, or -1 (no passkey has it) for text that cannot be one. */
function parseId(raw: string): number {
  return parseRowId(raw) ?? -1;
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiValidationError("Request body must be a JSON object");
  }
  for (const key of Object.keys(body)) {
    if (key !== "name") throw new ApiValidationError(`Unknown field "${key.slice(0, 40)}"`);
  }
  return body as Record<string, unknown>;
}

/** Renames one of the caller's passkeys. Recorded as passkey_renamed. */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiUser(request);
    const id = parseId((await params).id);
    const body = await readBody(request);
    return NextResponse.json(await renamePasskey(userId, id, body.name));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Removes one of the caller's passkeys. 400 when it is the last second factor
 * of an account the MFA policy covers. Recorded as passkey_removed.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { userId } = await requireApiUser(request);
    await removePasskey(userId, parseId((await params).id));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
